import { basename } from "path"
import type { ActionClassifier, ActionDecision, ToolAction } from "./types"
import { normalizeCommand } from "./normalize"
import {
  isManagedMemoryPath,
  MANAGED_MEMORY_WRITE_ERROR,
} from "../memory/paths"
import {
  analyzeShellCommand,
  type ShellCommandAnalysis,
  type ShellCommandSegment,
} from "./shell-analyzer"

// Deterministic, regex-based classifier for shell commands. Ported from
// hermes-tools/approval.py (HARDLINE_PATTERNS + DANGEROUS_PATTERNS). The LLM is
// NEVER the security boundary — classification is offline, explainable, and
// unit-tested.
//
// Two tiers:
//  - HARDLINE → hard_block: catastrophic, no recovery path (wipe disk rooted at
//    /, overwrite raw block device, kernel shutdown/reboot, fork bomb, kill -1).
//    Never overridable by the allowlist.
//  - DANGEROUS → require_approval: recoverable-but-risky (recursive rm, chmod
//    777, curl|sh, git reset --hard, writes to ~/.ssh / shell-rc / credentials /
//    /etc, etc.). Prompts the human.
// Everything else → allow.

// ── Shared path fragments (mirror approval.py) ───────────────────────────────
const SSH_SENSITIVE_PATH = String.raw`(?:~|\$home|\$\{home\})/\.ssh(?:/|$)`
const SHELL_RC_FILES = String.raw`(?:~|\$home|\$\{home\})/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b`
const CREDENTIAL_FILES = String.raw`(?:~|\$home|\$\{home\})/\.(?:netrc|pgpass|npmrc|pypirc)\b`
// macOS: /etc, /var, /tmp, /home are symlinks to /private/{etc,var,tmp,home}.
const MACOS_PRIVATE_SYSTEM_PATH = String.raw`/private/(?:etc|var|tmp|home)/`
const SYSTEM_CONFIG_PATH = String.raw`(?:/etc/|${MACOS_PRIVATE_SYSTEM_PATH})`
const PROJECT_ENV_PATH = String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'\`]+/)*\.env(?:\.[^/\s"'\`]+)*)`
const PROJECT_CONFIG_PATH = String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'\`]+/)*config\.yaml)`
const SENSITIVE_WRITE_TARGET = `(?:${SYSTEM_CONFIG_PATH}|/dev/sd|${SSH_SENSITIVE_PATH}|${SHELL_RC_FILES}|${CREDENTIAL_FILES})`
const USER_SENSITIVE_WRITE_TARGET = `(?:${SSH_SENSITIVE_PATH}|${SHELL_RC_FILES}|${CREDENTIAL_FILES})`
const PROJECT_SENSITIVE_WRITE_TARGET = `(?:${PROJECT_ENV_PATH}|${PROJECT_CONFIG_PATH})`
const COMMAND_TAIL = String.raw`(?:\s*(?:&&|\|\||;).*)?$`

// Regex fragment matching the *start* of a command (positions where a shell
// would begin parsing a new command). Keeps shutdown/reboot patterns from
// firing on "echo reboot" or "grep 'shutdown' log".
const CMDPOS =
  String.raw`(?:^|[;&|\n\`]|\$\()` +
  String.raw`\s*` +
  String.raw`(?:sudo\s+(?:-[^\s]+\s+)*)?` +
  String.raw`(?:env\s+(?:\w+=\S*\s+)*)?` +
  String.raw`(?:(?:exec|nohup|setsid|time)\s+)*` +
  String.raw`\s*`

// A dangerous pattern carries an optional approval `category` (mirrors the
// ApprovalCategory taxonomy in settings/service.ts) so a sandbox policy can
// auto-approve selected categories inside a container. Hardline patterns have no
// category — they are never downgradable. An omitted category falls back to
// "code_exec", a category the sandbox policy leaves OFF by default (conservative).
type Pattern = [pattern: string, description: string, category?: string]

// ── Hardline (unconditional block) ───────────────────────────────────────────
const HARDLINE_PATTERNS: Pattern[] = [
  [
    String.raw`\brm\s+(-[^\s]*\s+)*(/|/\*|/ \*)(\s|$)`,
    "recursive delete of root filesystem",
  ],
  [
    String.raw`\brm\s+(-[^\s]*\s+)*(/home|/home/\*|/root|/root/\*|/etc|/etc/\*|/usr|/usr/\*|/var|/var/\*|/bin|/bin/\*|/sbin|/sbin/\*|/boot|/boot/\*|/lib|/lib/\*)(\s|$)`,
    "recursive delete of system directory",
  ],
  [
    String.raw`\brm\s+(-[^\s]*\s+)*(~|\$home)(/?|/\*)?(\s|$)`,
    "recursive delete of home directory",
  ],
  [String.raw`\bmkfs(\.[a-z0-9]+)?\b`, "format filesystem (mkfs)"],
  [
    String.raw`\bdd\b[^\n]*\bof=/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*`,
    "dd to raw block device",
  ],
  [
    String.raw`>\s*/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b`,
    "redirect to raw block device",
  ],
  [String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, "fork bomb"],
  [String.raw`\bkill\s+(-[^\s]+\s+)*-1\b`, "kill all processes"],
  [
    CMDPOS + String.raw`(shutdown|reboot|halt|poweroff)\b`,
    "system shutdown/reboot",
  ],
  [CMDPOS + String.raw`init\s+[06]\b`, "init 0/6 (shutdown/reboot)"],
  [
    CMDPOS + String.raw`systemctl\s+(poweroff|reboot|halt|kexec)\b`,
    "systemctl poweroff/reboot",
  ],
  [CMDPOS + String.raw`telinit\s+[06]\b`, "telinit 0/6 (shutdown/reboot)"],
]

// ── Dangerous (require approval) ─────────────────────────────────────────────
// The third tuple element is the approval `category` used by the sandbox policy
// (see ApprovalCategory in settings/service.ts). Guidance:
//   destructive_fs  — recursive/forced deletion of files
//   history_rewrite — git operations that destroy commits/uncommitted work
//   system_mutation — touches system/credential paths, perms, services, devices
//   code_exec       — arbitrary code execution (shell -c, interpreters, curl|sh)
// Anything omitted falls back to "code_exec" (off by default in a sandbox).
const DANGEROUS_PATTERNS: Pattern[] = [
  [String.raw`\brm\s+(-[^\s]*\s+)*/`, "delete in root path", "destructive_fs"],
  [String.raw`\brm\s+-[^\s]*r`, "recursive delete", "destructive_fs"],
  [
    String.raw`\brm\s+--recursive\b`,
    "recursive delete (long flag)",
    "destructive_fs",
  ],
  [
    String.raw`\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b`,
    "world/other-writable permissions",
    "system_mutation",
  ],
  [
    String.raw`\bchmod\s+--recursive\b.*(777|666|o\+[rwx]*w|a\+[rwx]*w)`,
    "recursive world/other-writable (long flag)",
    "system_mutation",
  ],
  [
    String.raw`\bchown\s+(-[^\s]*)?r\s+root`,
    "recursive chown to root",
    "system_mutation",
  ],
  [
    String.raw`\bchown\s+--recursive\b.*root`,
    "recursive chown to root (long flag)",
    "system_mutation",
  ],
  [String.raw`\bmkfs\b`, "format filesystem", "system_mutation"],
  [String.raw`\bdd\s+.*if=`, "disk copy", "system_mutation"],
  [String.raw`>\s*/dev/sd`, "write to block device", "system_mutation"],
  [String.raw`\bdrop\s+(table|database)\b`, "SQL DROP", "destructive_fs"],
  [
    String.raw`\bdelete\s+from\b(?![^\n]*\bwhere\b)`,
    "SQL DELETE without WHERE",
    "destructive_fs",
  ],
  [String.raw`\btruncate\s+(table)?\s*\w`, "SQL TRUNCATE", "destructive_fs"],
  [
    String.raw`>\s*${SYSTEM_CONFIG_PATH}`,
    "overwrite system config",
    "system_mutation",
  ],
  [
    String.raw`\bsystemctl\s+(-[^\s]+\s+)*(stop|restart|disable|mask)\b`,
    "stop/restart system service",
    "system_mutation",
  ],
  [String.raw`\bkill\s+-9\s+-1\b`, "kill all processes", "system_mutation"],
  [String.raw`\bpkill\s+-9\b`, "force kill processes", "system_mutation"],
  [
    String.raw`\bkillall\s+(-[^\s]*\s+)*-(9|kill|sigkill)\b`,
    "force kill processes (killall -KILL)",
    "system_mutation",
  ],
  [
    String.raw`\bkillall\s+(-[^\s]*\s+)*-s\s+(kill|sigkill|9)\b`,
    "force kill processes (killall -s KILL)",
    "system_mutation",
  ],
  [
    String.raw`\bkillall\s+(-[^\s]*\s+)*-r\b`,
    "kill processes by regex (killall -r)",
    "system_mutation",
  ],
  [
    String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`,
    "fork bomb",
    "system_mutation",
  ],
  [
    String.raw`\b(bash|sh|zsh|ksh)\s+-[^\s]*c(\s+|$)`,
    "shell command via -c/-lc flag",
    "code_exec",
  ],
  [
    String.raw`\b(python[23]?|perl|ruby|node)\s+-[ec]\s+`,
    "script execution via -e/-c flag",
    "code_exec",
  ],
  [
    String.raw`\b(curl|wget)\b.*\|\s*(?:[/\w]*/)?(?:ba)?sh(?:\s|$|-c)`,
    "pipe remote content to shell",
    "code_exec",
  ],
  [
    String.raw`\b(bash|sh|zsh|ksh)\s+<\s*<?\s*\(\s*(curl|wget)\b`,
    "execute remote script via process substitution",
    "code_exec",
  ],
  [
    String.raw`\btee\b.*["']?${SENSITIVE_WRITE_TARGET}`,
    "overwrite system file via tee",
    "system_mutation",
  ],
  [
    String.raw`>>?\s*["']?${SENSITIVE_WRITE_TARGET}`,
    "overwrite system file via redirection",
    "system_mutation",
  ],
  [
    String.raw`\btee\b.*["']?${PROJECT_SENSITIVE_WRITE_TARGET}["']?${COMMAND_TAIL}`,
    "overwrite project env/config via tee",
    "system_mutation",
  ],
  [
    String.raw`>>?\s*["']?${PROJECT_SENSITIVE_WRITE_TARGET}["']?${COMMAND_TAIL}`,
    "overwrite project env/config via redirection",
    "system_mutation",
  ],
  [String.raw`\bxargs\s+.*\brm\b`, "xargs with rm", "destructive_fs"],
  [
    String.raw`\bfind\b.*-exec(?:dir)?\s+(/\S*/)?rm\b`,
    "find -exec/-execdir rm",
    "destructive_fs",
  ],
  [String.raw`\bfind\b.*-delete\b`, "find -delete", "destructive_fs"],
  [
    String.raw`\b(cp|mv|install)\b.*\s${SYSTEM_CONFIG_PATH}`,
    "copy/move file into system config path",
    "system_mutation",
  ],
  [
    String.raw`\b(cp|mv|install)\b.*\s["']?${PROJECT_SENSITIVE_WRITE_TARGET}["']?${COMMAND_TAIL}`,
    "overwrite project env/config file",
    "system_mutation",
  ],
  [
    String.raw`\b(cp|mv|install)\b.*\s["']?${SENSITIVE_WRITE_TARGET}[^\s"']*["']?${COMMAND_TAIL}`,
    "copy/move file into sensitive credential/SSH/shell-rc path",
    "system_mutation",
  ],
  [
    String.raw`\bsed\s+-[^\s]*i.*(?:${USER_SENSITIVE_WRITE_TARGET})[^\s"']*`,
    "in-place edit of sensitive credential/SSH/shell-rc path",
    "system_mutation",
  ],
  [
    String.raw`\bsed\s+--in-place\b.*(?:${USER_SENSITIVE_WRITE_TARGET})[^\s"']*`,
    "in-place edit of sensitive credential/SSH/shell-rc path (long flag)",
    "system_mutation",
  ],
  [
    String.raw`\b(?:perl|ruby)\b.*(?:^|\s)-[^\s]*i\b.*(?:${USER_SENSITIVE_WRITE_TARGET})[^\s"']*`,
    "in-place edit of sensitive credential/SSH/shell-rc path (perl/ruby)",
    "system_mutation",
  ],
  [
    String.raw`\bsed\s+-[^\s]*i.*\s${SYSTEM_CONFIG_PATH}`,
    "in-place edit of system config",
    "system_mutation",
  ],
  [
    String.raw`\bsed\s+--in-place\b.*\s${SYSTEM_CONFIG_PATH}`,
    "in-place edit of system config (long flag)",
    "system_mutation",
  ],
  [
    String.raw`\b(python[23]?|perl|ruby|node)\s+<<`,
    "script execution via heredoc",
    "code_exec",
  ],
  [
    String.raw`\bgit\s+reset\s+--hard\b`,
    "git reset --hard (destroys uncommitted changes)",
    "history_rewrite",
  ],
  [
    String.raw`\bgit\s+push\b.*--force\b`,
    "git force push (rewrites remote history)",
    "history_rewrite",
  ],
  [
    String.raw`\bgit\s+push\b.*-f\b`,
    "git force push short flag (rewrites remote history)",
    "history_rewrite",
  ],
  [
    String.raw`\bgit\s+clean\s+-[^\s]*f`,
    "git clean with force (deletes untracked files)",
    "destructive_fs",
  ],
  [
    String.raw`\bgit\s+branch\s+-d\b`,
    "git branch force delete",
    "history_rewrite",
  ],
  [
    String.raw`\bchmod\s+\+x\b.*[;&|]+\s*\./`,
    "chmod +x followed by immediate execution",
    "code_exec",
  ],
  [
    String.raw`\bsudo\b[^;|&\n]*?\s+(?:-s\b|--stdin\b|-a\b|--askpass\b)`,
    "sudo with privilege flag (stdin/askpass/shell/list)",
    "system_mutation",
  ],
  [
    String.raw`\bsudo\b[^;|&\n]*?\s+-[a-z]*[sa][a-z]*\b`,
    "sudo with combined-flag privilege escalation",
    "system_mutation",
  ],
]

// Pre-compile at module load. Patterns are authored lowercase-friendly and we
// match against the normalized+lowercased command, so the `i` flag is belt-and-
// suspenders; `s` (dotAll) mirrors Python's re.DOTALL. The category rides along
// (dangerous tier only); an omitted one defaults to "code_exec".
function compile(patterns: Pattern[]): Array<[RegExp, string, string]> {
  return patterns.map(([p, d, c]) => [new RegExp(p, "is"), d, c ?? "code_exec"])
}
const HARDLINE_COMPILED = compile(HARDLINE_PATTERNS)
const DANGEROUS_COMPILED = compile(DANGEROUS_PATTERNS)

// Executables that write the paths handed to them. Redirect targets are caught
// separately via candidateWritePaths; this catches the `tee`/`sed -i`/`cp` shape
// that carries its destination in argv instead.
const FILE_MUTATING_EXECUTABLES = new Set([
  "cp",
  "dd",
  "install",
  "ln",
  "mv",
  "patch",
  "rm",
  "sed",
  "shred",
  "tee",
  "truncate",
])

// Reads are deliberately not blocked: memory-recent points the agent at
// reference/ for raw detail, and grepping it is legitimate.
function managedMemoryWriteTarget(
  analysis: ShellCommandAnalysis
): string | undefined {
  const redirected = analysis.candidateWritePaths.find(isManagedMemoryPath)
  if (redirected) return redirected
  for (const segment of [...analysis.segments, ...analysis.substitutions]) {
    const executable = segment.executable ? basename(segment.executable) : ""
    if (!FILE_MUTATING_EXECUTABLES.has(executable)) continue
    const target = [...segment.argv, ...segment.rawArgv].find(
      isManagedMemoryPath
    )
    if (target) return target
  }
  return undefined
}

export class RegexCommandClassifier implements ActionClassifier {
  classify(action: ToolAction): ActionDecision | null {
    if (action.kind !== "shell") return null
    const command =
      typeof action.detail?.command === "string"
        ? (action.detail.command as string)
        : action.identity
    const normalized = normalizeCommand(command).toLowerCase()
    const analysis = shellAnalysis(action, command)

    // Hardline is unconditional and carries no category — it is never downgraded
    // by the allowlist or a sandbox policy.
    const hardline = firstMatch(normalized, HARDLINE_COMPILED)
    if (hardline) return { level: "hard_block", reason: hardline.description }
    for (const segment of [...analysis.segments, ...analysis.substitutions]) {
      const segmentHardline = firstMatch(
        segmentText(segment),
        HARDLINE_COMPILED
      )
      if (segmentHardline) {
        return { level: "hard_block", reason: segmentHardline.description }
      }
    }

    // Hard-blocked rather than gated: require_approval is auto-approved in Auto
    // mode, and a shell write here bypasses every extraction check the memory
    // pipeline applies. The file tools refuse this path too.
    const memoryTarget = managedMemoryWriteTarget(analysis)
    if (memoryTarget) {
      return {
        level: "hard_block",
        reason: `${MANAGED_MEMORY_WRITE_ERROR} (blocked target: ${memoryTarget})`,
      }
    }

    const dangerous = firstMatch(normalized, DANGEROUS_COMPILED)
    if (dangerous) {
      return {
        level: "require_approval",
        reason: dangerous.description,
        category: dangerous.category,
      }
    }
    for (const segment of [...analysis.segments, ...analysis.substitutions]) {
      const segmentDangerous = firstMatch(
        segmentText(segment),
        DANGEROUS_COMPILED
      )
      if (segmentDangerous) {
        return {
          level: "require_approval",
          reason: segmentDangerous.description,
          category: segmentDangerous.category,
        }
      }
    }
    if (analysis.confidence !== "high") {
      return {
        level: "require_approval",
        reason: `shell syntax requires approval: ${analysis.reasons.join(", ")}`,
        category: "code_exec",
      }
    }
    if (analysis.outsideWorkspacePaths.length > 0) {
      return {
        level: "require_approval",
        reason: "command references paths outside the workspace",
        category: "system_mutation",
      }
    }
    if (analysis.networkOperations.length > 0) {
      return {
        level: "require_approval",
        reason: "command may access the network",
        category: "network_access",
      }
    }
    return { level: "allow" }
  }
}

function shellAnalysis(
  action: ToolAction,
  command: string
): ShellCommandAnalysis {
  const analysis = action.detail?.shellAnalysis
  if (isShellCommandAnalysis(analysis)) return analysis
  return analyzeShellCommand(command, process.platform)
}

function isShellCommandAnalysis(value: unknown): value is ShellCommandAnalysis {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ShellCommandAnalysis).segments) &&
    Array.isArray((value as ShellCommandAnalysis).substitutions) &&
    Array.isArray((value as ShellCommandAnalysis).networkOperations) &&
    Array.isArray((value as ShellCommandAnalysis).outsideWorkspacePaths)
  )
}

function firstMatch(
  command: string,
  patterns: Array<[RegExp, string, string]>
): { description: string; category: string } | null {
  for (const [re, description, category] of patterns) {
    if (re.test(command)) return { description, category }
  }
  return null
}

function segmentText(segment: ShellCommandSegment): string {
  return normalizeCommand(
    [
      ...segment.argv,
      ...segment.redirects.flatMap((redirect) => [
        redirect.op,
        redirect.target,
      ]),
    ].join(" ")
  ).toLowerCase()
}
