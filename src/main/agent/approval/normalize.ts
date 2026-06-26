import { homedir } from "os"
import { stripAnsi } from "./ansi"

// Normalize a shell command before danger-pattern matching. Ported from
// hermes-tools/approval.py `_normalize_command_for_detection`.
//
// The goal is to defeat trivial obfuscation so a dangerous command can't be
// disguised as benign and slip through the classifier as `allow`. This is also
// the single source of truth for a command's *identity* used by the allowlist:
// two commands that normalize to the same string are "the same command".
//
// Steps (order matters — see the home-fold note below):
//  1. Strip ANSI escape sequences (CSI/OSC/DCS/8-bit C1, etc.).
//  2. Strip null bytes.
//  3. Unicode NFKC normalization (fullwidth Latin → ASCII, etc.).
//  4. Fold the absolute home prefix to `~` so /home/alice/.ssh matches the
//     same patterns as ~/.ssh and $HOME/.ssh.
//  5. Strip shell backslash-escapes: r\m → rm (prevents \-injection bypass).
//  6. Strip empty-string literals that split tokens: r''m → rm, r""m → rm.
//
// Note: the home fold runs BEFORE the backslash strip because a Windows home
// prefix (C:\Users\alice\...) is separated by backslashes that step 5 would
// otherwise dissolve. The fold accepts either separator.

// Fold an absolute home prefix (POSIX or Windows form) to `~`. Requires at
// least one path segment under the home so a bare home with no tail isn't
// folded, and a degenerate home (root / drive letter) can't rewrite unrelated
// paths.
function foldHomePrefix(command: string, home: string): string {
  if (!home) return command
  const components = home.split(/[/\\]+/).filter(Boolean)
  if (components.length < 2) return command
  const escaped = components.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const body = escaped.join("[/\\\\]+")
  // Optional leading separator, the home body, then a required path tail. The
  // tail's backslashes are normalized to `/` so multi-segment static patterns
  // (e.g. ~/.ssh/authorized_keys) match regardless of original separator.
  const re = new RegExp(`[/\\\\]*${body}((?:[/\\\\][^/\\\\\\s'"\`;|&<>()]*)+)`, "g")
  return command.replace(re, (_m, tail: string) => "~" + tail.replace(/\\/g, "/"))
}

export function normalizeCommand(command: string): string {
  let out = stripAnsi(command)
  // Strip null bytes.
  out = out.replace(/\0/g, "")
  // Unicode NFKC normalization (fullwidth → ASCII, etc.).
  out = out.normalize("NFKC")
  // Fold the absolute home prefix to ~ (best-effort; never throws).
  try {
    out = foldHomePrefix(out, homedir())
  } catch {
    // homedir() can throw in unusual environments — skip the fold.
  }
  // Strip shell backslash-escapes: r\m → rm.
  out = out.replace(/\\([^\n])/g, "$1")
  // Strip empty-string literals that split tokens: r''m → rm, r""m → rm.
  out = out.replace(/''|""/g, "")
  return out
}
