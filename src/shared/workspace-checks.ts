// Persisted workspace check validation. No Node imports.

// A workspace's definition of one named check.
export interface WorkspaceCheck {
  command: string
  // Workspace-relative; null means the workspace root.
  cwd: string | null
}

export type WorkspaceChecks = Record<string, WorkspaceCheck>

export const COMMAND_MAX_LENGTH = 8_000
export const COMMAND_CWD_MAX_LENGTH = 1_024

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
  if (!name) throw new Error("A check name is required.")
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
