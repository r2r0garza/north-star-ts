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
  // The analyzer unwraps privilege wrappers (`sudo x` reads as `x`), so the
  // command's first word is checked too.
  const segment = analysis.segments[0]
  const executable = [segment?.rawArgv?.[0], segment?.executable]
    .map((word) => path.basename(word ?? ""))
    .find((word) => NEVER.has(word))
  if (executable)
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

// Installing dependencies belongs to the worktree's setup (and, when a
// story's manifest diverges, to a worktree-local install, plan 112.5), never
// to how the app starts: a recipe that installs mutates shared directories on
// every start.
const INSTALL =
  /^(?:(?:npm|pnpm|bun)\s+(?:install|i|ci|add)\b|yarn(?:\s+(?:install|add)\b|\s*$)|(?:pip3?|python3?\s+-m\s+pip|uv\s+pip)\s+install\b|uv\s+(?:add|sync)\b|poetry\s+(?:add|install)\b|pipenv\s+install\b|gem\s+install\b|bundle(?:\s+install)?\s*$|cargo\s+install\b|go\s+install\b|composer\s+(?:install|require)\b|npx\s+playwright\s+install\b)/

// A program given its code on the command line (`node -e "…"`): a recipe
// that runs that starts a stand-in, not the project. Seen in a real repair
// turn, which "fixed" a recipe by replacing the app with a one-line server.
const INLINE_CODE =
  /^(?:\S*\/)?(?:node|nodejs|bun|python[\d.]*|ruby|perl|php|sh|bash|zsh)(?:\s+-{1,2}[\w-]+)*?\s+(?:-e|--eval|-p|--print|-c)(?:\s|=|$)|^(?:\S*\/)?deno\s+eval\b/

// Why a recipe command isn't safe to save or run, or null (plan 112.3,
// ported from backup:109.03's recipe-model.ts). The same policy as a
// builder's own shell commands in setup: one command, no chaining, pipes,
// redirects, or substitutions, nothing the classifier hard-blocks, nothing
// outside the workspace, no sudo, and no installs. A step that must run
// first goes in `setup`.
export function recipeCommandRefusal(
  command: string,
  cwd: string
): string | null {
  // The policy reads a runnable command, so placeholders become values.
  const runnable = command
    .replace(/\{port(?::[^}]*)?\}/g, "4000")
    .replace(/\{env:[^}]*\}/g, "value")
  const verdict = checkSetupCommand(runnable, cwd)
  if (!verdict.ok) return verdict.reason
  if (INSTALL.test(runnable.trim()))
    return "installing dependencies isn't part of starting the app (the worktree's setup installs them)"
  if (INLINE_CODE.test(runnable.trim()))
    return "the command runs code written into the command line; a recipe starts the project's own code (a script, an entry file, a package script)"
  return null
}

export function serviceCommandRefusal(
  service: { label: string; command: string; cwd: string },
  workspace: string
): string | null {
  const reason = recipeCommandRefusal(
    service.command,
    path.join(workspace, service.cwd)
  )
  return reason
    ? `${service.label}'s command (\`${service.command}\`): ${reason}`
    : null
}

// Every command a recipe would run: services, setup steps, and command
// prerequisite checks.
export function recipeRefusal(
  recipe: {
    services: Array<{ label: string; command: string; cwd: string }>
    setup?: Array<{ label: string; command: string; cwd: string }>
    prerequisites?: Array<{
      label: string
      check: { tcp: number } | { command: string }
    }>
  },
  workspace: string
): string | null {
  for (const service of recipe.services) {
    const refused = serviceCommandRefusal(service, workspace)
    if (refused) return refused
  }
  for (const step of recipe.setup ?? []) {
    const reason = recipeCommandRefusal(
      step.command,
      path.join(workspace, step.cwd)
    )
    if (reason)
      return `The setup step "${step.label}" (\`${step.command}\`): ${reason}`
  }
  for (const prerequisite of recipe.prerequisites ?? []) {
    if (!("command" in prerequisite.check)) continue
    const reason = recipeCommandRefusal(prerequisite.check.command, workspace)
    if (reason)
      return `The check for "${prerequisite.label}" (\`${prerequisite.check.command}\`): ${reason}`
  }
  return null
}
