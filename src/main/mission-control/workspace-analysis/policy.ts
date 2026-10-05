import path from "path"
import {
  analyzeShellCommand,
  shellActionForCommand,
} from "../../agent/approval/shell-analyzer"
import { RegexCommandClassifier } from "../../agent/approval/regex-classifier"

// Command policy for setup findings (plan 106.11). Everything a finding can
// run or persist passes here, whether a recipe composed it or the model
// proposed it: one simple command (no chaining, pipes, redirects, or
// substitutions), nothing the approval classifier hard-blocks, and nothing
// that reaches outside the workspace. A generated-files command may be
// prefixed with `cd <dir> &&` to run in a project root.

const classifier = new RegexCommandClassifier()

// Never a setup step or fix: privilege escalation, system package managers
// (installing system software is always the user's manual step), and
// destructive or machine-level commands.
const NEVER = new Set([
  "sudo",
  "doas",
  "su",
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "zypper",
  "apk",
  "brew",
  "port",
  "choco",
  "winget",
  "scoop",
  "snap",
  "rm",
  "rmdir",
  "dd",
  "mkfs",
  "shutdown",
  "reboot",
  "chown",
  "chmod",
  "curl",
  "wget",
  "ssh",
  "scp",
  "eval",
  "exec",
  "source",
  ".",
])

export interface PolicyVerdict {
  ok: boolean
  reason: string | null
}

const OK: PolicyVerdict = { ok: true, reason: null }

export function checkSetupCommand(
  command: string,
  workspace: string
): PolicyVerdict {
  const text = command.trim()
  if (!text) return { ok: false, reason: "empty command" }
  if (text.length > 400) return { ok: false, reason: "command is too long" }
  if (/[\n\r]/.test(text)) return { ok: false, reason: "multi-line command" }
  const analysis = analyzeShellCommand(
    text,
    process.platform === "win32" ? "win32" : "darwin",
    {
      cwd: workspace,
      workspace,
    }
  )
  if (analysis.segments.length !== 1)
    return {
      ok: false,
      reason: "only one command per step (no chaining or pipes)",
    }
  if (analysis.substitutions.length)
    return { ok: false, reason: "command substitution isn't allowed" }
  if (analysis.redirects.length)
    return { ok: false, reason: "redirects aren't allowed" }
  if (analysis.confidence !== "high")
    return {
      ok: false,
      reason: `unsupported shell syntax: ${analysis.reasons.join(", ")}`,
    }
  const executable = path.basename(analysis.segments[0]?.executable ?? "")
  if (NEVER.has(executable))
    return {
      ok: false,
      reason: `\`${executable}\` isn't allowed in setup; do it by hand`,
    }
  if (analysis.outsideWorkspacePaths.length)
    return {
      ok: false,
      reason: `reaches outside the workspace: ${analysis.outsideWorkspacePaths[0]}`,
    }
  const decision = classifier.classify(
    shellActionForCommand(text, { cwd: workspace, workspace })
  )
  if (decision?.level === "hard_block")
    return { ok: false, reason: decision.reason }
  return OK
}

export function checkGeneratedCommand(
  command: string,
  workspace: string
): PolicyVerdict {
  const match = /^cd\s+([\w./@-]+)\s+&&\s+(.+)$/.exec(command.trim())
  if (!match) return checkSetupCommand(command, workspace)
  const dir = checkRelativePath(match[1])
  if (!dir.ok) return dir
  return checkSetupCommand(match[2], path.join(workspace, match[1]))
}

export function checkRelativePath(p: string): PolicyVerdict {
  const value = p.trim()
  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value))
    return { ok: false, reason: "absolute path" }
  if (value.split(/[\\/]/).includes(".."))
    return { ok: false, reason: "path leaves the workspace" }
  if (/[\0\n]/.test(value)) return { ok: false, reason: "invalid path" }
  return OK
}

export function checkGlob(glob: string): PolicyVerdict {
  const rel = checkRelativePath(glob)
  if (!rel.ok) return rel
  if (!glob.trim() || glob.trim() === "**" || glob.trim() === "**/*")
    return { ok: false, reason: "glob would cover the whole workspace" }
  if (
    /[[{]/.test(glob) &&
    !/^[^[\]{}]*(\{[^{}]*\}|\[[^[\]]*\])?[^[\]{}]*$/.test(glob)
  )
    return { ok: false, reason: "malformed glob" }
  try {
    path.posix.matchesGlob("probe/file.txt", glob)
  } catch {
    return { ok: false, reason: "malformed glob" }
  }
  return OK
}
