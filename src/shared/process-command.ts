// Deterministic command phases (plan 104). The contract shared by the main
// process (repository validation, import/export, the engine's executor) and the
// renderer (builder validation, monitor rendering). No Node imports here.

// How a phase executes. `agent` starts an LLM worker; `command` runs a persisted
// shell command through the run's Environment with no model involved;
// `subprocess` runs another Process definition as a nested run.
export type ProcessPhaseKind = "agent" | "command" | "subprocess"

export const PROCESS_PHASE_KINDS: readonly ProcessPhaseKind[] = [
  "agent",
  "command",
  "subprocess",
]

// What a command phase runs. A process is reused across workspaces, so a phase
// usually names a workspace CHECK (e.g. `test`) that each workspace maps to its
// own command; the mapping is resolved when a run starts and frozen on the run.
// A LITERAL command is for one that is right in every workspace. There is no
// default: a check a workspace doesn't define stops the run before it starts.
export type ProcessCommandConfig =
  | {
      source: "check"
      check: string
      timeoutMs: number
      maxOutputBytes: number
    }
  | {
      source: "literal"
      command: string
      // Workspace-relative; null means the workspace root.
      cwd: string | null
      timeoutMs: number
      maxOutputBytes: number
    }

// A workspace's definition of one named check.
export interface WorkspaceCheck {
  command: string
  // Workspace-relative; null means the workspace root.
  cwd: string | null
}

export type WorkspaceChecks = Record<string, WorkspaceCheck>

// The exact command a run executes for one command phase, frozen at run start.
export interface ResolvedProcessCommand {
  // The workspace check it came from; null for a literal command.
  check: string | null
  command: string
  cwd: string | null
  timeoutMs: number
  maxOutputBytes: number
}

// Check names a builder suggests. Any valid name works.
export const SUGGESTED_CHECK_NAMES = [
  "test",
  "build",
  "lint",
  "typecheck",
  "e2e",
]

export type ProcessCommandStatus =
  // Written just before spawn, so a crash mid-command is detectable on resume.
  "running" | "completed" | "failed" | "timed_out" | "cancelled" | "interrupted"

export interface ProcessCommandReceipt {
  version: 1
  // The workspace check the command came from; null (or absent on early
  // receipts) for a literal command.
  check?: string | null
  command: string
  cwd: string | null
  environment: "local" | "container"
  status: ProcessCommandStatus
  exitCode: number | null
  signal: string | null
  startedAt: number
  finishedAt: number | null
  stdout: string
  stderr: string
  outputTruncated: boolean
  capturedOutputBytes: number
  observedOutputBytes: number
  // Why the command did not run or settle cleanly (policy block, spawn error,
  // cleanup failure, interruption). Null for an ordinary exit.
  error: string | null
}

export const COMMAND_MAX_LENGTH = 8_000
export const COMMAND_CWD_MAX_LENGTH = 1_024
export const COMMAND_TIMEOUT_MIN_MS = 1_000
export const COMMAND_TIMEOUT_MAX_MS = 2 * 60 * 60_000
export const COMMAND_TIMEOUT_DEFAULT_MS = 10 * 60_000
export const COMMAND_OUTPUT_MIN_BYTES = 1_024
export const COMMAND_OUTPUT_MAX_BYTES = 1024 * 1024
export const COMMAND_OUTPUT_DEFAULT_BYTES = 256 * 1024
// The share of a receipt handed to downstream phases' kickoffs.
export const COMMAND_DOWNSTREAM_MAX_CHARS = 16_000

const CHECK_NAME = /^[a-z][a-z0-9_-]{0,39}$/

// Normalize a workspace-relative working directory. Returns null for the
// workspace root, a cleaned relative path, or an error message. The engine
// still resolves the result through the Environment, which also rejects
// symlink escapes; this catches what can be judged from the text alone.
export function normalizeCommandCwd(
  input: string | null | undefined
): { cwd: string | null } | { error: string } {
  if (input === null || input === undefined) return { cwd: null }
  const raw = input.trim()
  if (!raw) return { cwd: null }
  if (raw.length > COMMAND_CWD_MAX_LENGTH)
    return { error: "The working directory is too long." }
  if (raw.includes("\0"))
    return { error: "The working directory contains a NUL character." }
  const slashed = raw.replace(/\\/g, "/")
  if (
    slashed.startsWith("/") ||
    slashed.startsWith("~") ||
    /^[A-Za-z]:/.test(slashed)
  )
    return {
      error: "The working directory must be relative to the workspace.",
    }
  const parts: string[] = []
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..")
      return { error: "The working directory must stay inside the workspace." }
    parts.push(part)
  }
  return { cwd: parts.length ? parts.join("/") : null }
}

// Validate a check name: lowercase letters, digits, `-` and `_`.
export function parseCheckName(input: unknown, path = "check"): string {
  if (typeof input !== "string") throw new Error(`${path} must be a string`)
  const name = input.trim().toLowerCase()
  if (!name) throw new Error("A command phase needs a check name.")
  if (!CHECK_NAME.test(name))
    throw new Error(
      "A check name uses lowercase letters, digits, - and _, starts with a letter, and is at most 40 characters."
    )
  return name
}

// Validate a command and its working directory (a workspace check, or a
// literal command phase).
function parseCommandText(
  obj: Record<string, unknown>,
  path: string
): { command: string; cwd: string | null } {
  if (typeof obj.command !== "string")
    throw new Error(`${path}.command must be a string`)
  const command = obj.command.trim()
  if (!command) throw new Error("A command is required.")
  if (command.length > COMMAND_MAX_LENGTH)
    throw new Error(
      `The command is longer than ${COMMAND_MAX_LENGTH} characters.`
    )
  if (command.includes("\0"))
    throw new Error("The command contains a NUL character.")
  if (obj.cwd !== undefined && obj.cwd !== null && typeof obj.cwd !== "string")
    throw new Error(`${path}.cwd must be a string or null`)
  const cwd = normalizeCommandCwd(obj.cwd as string | null | undefined)
  if ("error" in cwd) throw new Error(cwd.error)
  return { command, cwd: cwd.cwd }
}

export function parseWorkspaceCheck(
  input: unknown,
  path = "check"
): WorkspaceCheck {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error(`${path} must be an object`)
  return parseCommandText(input as Record<string, unknown>, path)
}

// Keep the well-formed checks of a stored map; drop anything else.
export function normalizeWorkspaceChecks(input: unknown): WorkspaceChecks {
  const checks: WorkspaceChecks = {}
  if (!input || typeof input !== "object" || Array.isArray(input)) return checks
  for (const [name, value] of Object.entries(input)) {
    try {
      checks[parseCheckName(name)] = parseWorkspaceCheck(value)
    } catch {
      // A malformed entry reads as undefined, so a run asks for it again.
    }
  }
  return checks
}

// Validate and normalize a command config (builder input, IPC, import). Throws
// with a message fit for a toast or an import error. A config without a
// `source` is a literal command (the shape before workspace checks).
export function parseCommandConfig(
  input: unknown,
  path = "command"
): ProcessCommandConfig {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error(`${path} must be an object`)
  const obj = input as Record<string, unknown>
  const source = obj.source ?? "literal"
  if (source !== "check" && source !== "literal")
    throw new Error(`${path}.source must be "check" or "literal"`)
  const timeoutMs = boundedInteger(
    obj.timeoutMs,
    COMMAND_TIMEOUT_DEFAULT_MS,
    COMMAND_TIMEOUT_MIN_MS,
    COMMAND_TIMEOUT_MAX_MS,
    `${path}.timeoutMs`
  )
  const maxOutputBytes = boundedInteger(
    obj.maxOutputBytes,
    COMMAND_OUTPUT_DEFAULT_BYTES,
    COMMAND_OUTPUT_MIN_BYTES,
    COMMAND_OUTPUT_MAX_BYTES,
    `${path}.maxOutputBytes`
  )
  if (source === "check")
    return {
      source,
      check: parseCheckName(obj.check, `${path}.check`),
      timeoutMs,
      maxOutputBytes,
    }
  return { source, ...parseCommandText(obj, path), timeoutMs, maxOutputBytes }
}

// The exact command for a phase in a workspace, or the missing check's name.
export function resolveCommandConfig(
  config: ProcessCommandConfig,
  checks: WorkspaceChecks
): ResolvedProcessCommand | { missing: string } {
  const limits = {
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
  }
  if (config.source === "literal")
    return { check: null, command: config.command, cwd: config.cwd, ...limits }
  const check = checks[config.check]
  if (!check) return { missing: config.check }
  return {
    check: config.check,
    command: check.command,
    cwd: check.cwd,
    ...limits,
  }
}

// How a phase's command reads in a summary: `check test` or the command.
export function commandConfigLabel(config: ProcessCommandConfig): string {
  return config.source === "check" ? `check ${config.check}` : config.command
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  path: string
): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${path} must be an integer`)
  if (value < min || value > max)
    throw new Error(`${path} must be between ${min} and ${max}`)
  return value
}

export function commandStatusLabel(status: ProcessCommandStatus): string {
  switch (status) {
    case "running":
      return "running"
    case "completed":
      return "exit 0"
    case "failed":
      return "failed"
    case "timed_out":
      return "timed out"
    case "cancelled":
      return "cancelled"
    case "interrupted":
      return "interrupted"
  }
}

// One line describing how the command ended, e.g. "exited with code 1".
export function commandOutcomeText(receipt: ProcessCommandReceipt): string {
  if (receipt.status === "running") return "is still running"
  if (receipt.status === "interrupted")
    return "was interrupted before it finished (the app stopped while it ran)"
  if (receipt.status === "cancelled") return "was cancelled"
  if (receipt.status === "timed_out") return "timed out and was stopped"
  if (receipt.exitCode !== null) return `exited with code ${receipt.exitCode}`
  if (receipt.signal) return `was terminated by signal ${receipt.signal}`
  return receipt.error ? `failed: ${receipt.error}` : "failed"
}

// The bounded text downstream phases receive as this phase's output. Output is
// shown as data with its exit status; stdout/stderr tails are kept because the
// end of a test or build log is where the verdict usually is.
export function renderCommandReceiptSummary(
  receipt: ProcessCommandReceipt,
  maxChars = COMMAND_DOWNSTREAM_MAX_CHARS
): string {
  const header = [
    ...(receipt.check ? [`Workspace check: ${receipt.check}`] : []),
    `Command: ${receipt.command}`,
    `Working directory: ${receipt.cwd ?? "(workspace root)"}`,
    `Result: the command ${commandOutcomeText(receipt)}.`,
    ...(receipt.finishedAt !== null
      ? [`Duration: ${formatDuration(receipt.finishedAt - receipt.startedAt)}`]
      : []),
    ...(receipt.error ? [`Error: ${receipt.error}`] : []),
    ...(receipt.outputTruncated
      ? [
          `Output was truncated: ${receipt.capturedOutputBytes} of ${receipt.observedOutputBytes} bytes kept.`,
        ]
      : []),
  ].join("\n")
  const budget = Math.max(0, maxChars - header.length - 64)
  const stdout = receipt.stdout.trimEnd()
  const stderr = receipt.stderr.trimEnd()
  const stdoutBudget = stderr ? Math.floor(budget * 0.6) : budget
  const stderrBudget = stdout ? budget - stdoutBudget : budget
  const sections = [header]
  if (stdout) sections.push(`stdout:\n${tail(stdout, stdoutBudget)}`)
  if (stderr) sections.push(`stderr:\n${tail(stderr, stderrBudget)}`)
  if (!stdout && !stderr) sections.push("(no output)")
  return sections.join("\n\n")
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  if (maxChars <= 0) return "[…output omitted]"
  return `[…${text.length - maxChars} earlier characters omitted]\n${text.slice(text.length - maxChars)}`
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`
  const seconds = ms / 1_000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`
}
