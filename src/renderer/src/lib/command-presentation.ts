import { renderContextEnvelope } from "../../../shared/context-provenance"

export const COMMAND_OUTPUT_LIMIT = 4000
export const INITIAL_COMPLETION_LIMIT = 5
const snapshotTools = new Set([
  "exec_command",
  "poll_command",
  "write_stdin",
  "terminate_command",
])
export const isCommandTool = (name: string) =>
  snapshotTools.has(name) ||
  name === "run_shell_tool" ||
  name === "wait_for_events"
export type CommandOutcome =
  | "success"
  | "failure"
  | "unknown"
  | "reported_running"
export interface CommandSnapshot {
  status: "running" | "completed" | "timed_out" | "terminated"
  output: string
  exitCode: number | null
  signal: string | null
  sessionId?: string
  eventId?: string
  command?: string
  cwd?: string
  durationMs?: number
  cleanupError?: { path: string; error: string }
  truncated?: boolean
  modelTruncated?: boolean
  droppedBytes?: number
  omittedBytes?: number
  cursor?: number
  nextCursor?: number
  totalBytes?: number
}
export interface CommandPresentation {
  snapshots: Array<CommandSnapshot | null>
  outcome: CommandOutcome
  label: string
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
function snapshot(value: unknown): CommandSnapshot | null {
  if (
    !record(value) ||
    !["running", "completed", "timed_out", "terminated"].includes(
      String(value.status)
    ) ||
    typeof value.output !== "string"
  )
    return null
  if (
    !(
      value.exitCode === null ||
      (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))
    ) ||
    !(value.signal === null || typeof value.signal === "string")
  )
    return null
  for (const key of ["sessionId", "eventId", "command", "cwd"])
    if (value[key] !== undefined && typeof value[key] !== "string") return null
  for (const key of [
    "durationMs",
    "droppedBytes",
    "omittedBytes",
    "cursor",
    "nextCursor",
    "totalBytes",
  ])
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" ||
        !Number.isFinite(value[key]) ||
        value[key] < 0)
    )
      return null
  for (const key of ["truncated", "modelTruncated"])
    if (value[key] !== undefined && typeof value[key] !== "boolean") return null
  if (
    value.cleanupError !== undefined &&
    (!record(value.cleanupError) ||
      typeof value.cleanupError.path !== "string" ||
      typeof value.cleanupError.error !== "string")
  )
    return null
  if (
    value.status === "running" &&
    (typeof value.sessionId !== "string" || !value.sessionId)
  )
    return null
  return value as unknown as CommandSnapshot
}
export function snapshotOutcome(s: CommandSnapshot): CommandOutcome {
  if (
    s.cleanupError ||
    s.signal ||
    s.status === "timed_out" ||
    s.status === "terminated" ||
    (s.exitCode !== null && s.exitCode !== 0)
  )
    return "failure"
  if (s.status === "running") return "reported_running"
  return s.exitCode === 0 ? "success" : "unknown"
}
export function snapshotLabel(s: CommandSnapshot): string {
  if (s.cleanupError) return "Cleanup failed"
  if (s.status === "timed_out") return "Timed out"
  if (s.status === "terminated" || s.signal) return "Terminated"
  if (s.status === "running") return "Running when reported"
  if (s.exitCode !== null)
    return s.exitCode === 0
      ? "Completed successfully"
      : `Exited with code ${s.exitCode}`
  return "Final outcome unavailable"
}
export function displayedCommandOutput(output: string): string {
  return output.length > COMMAND_OUTPUT_LIMIT
    ? `${output.slice(0, COMMAND_OUTPUT_LIMIT)}\n…[UI clipped at 4,000 characters]`
    : output
}
function legacy(result: string): CommandSnapshot | null {
  const envelope = renderContextEnvelope(
    { trust: "untrusted_data", channel: "command", source: "run_shell_tool" },
    ""
  )
  const prefix = envelope.slice(0, -"DATA: ".length)
  if (!result.startsWith(prefix)) return null
  const lines = result.slice(prefix.length).split("\n")
  if (!lines.every((line) => line.startsWith("DATA: "))) return null
  const text = lines.map((line) => line.slice(6)).join("\n")
  const match =
    /^\[(?:exit code (-?\d+|unknown)|timed out after (\d+)ms \(killed\)|terminated by signal ([A-Z0-9]+))\](?:\n|$)/.exec(
      text
    )
  if (!match) return null
  return {
    status: match[2] ? "timed_out" : match[3] ? "terminated" : "completed",
    exitCode: match[1] && match[1] !== "unknown" ? Number(match[1]) : null,
    signal: match[3] ?? null,
    output: text.slice(match[0].length),
  }
}
export function commandPresentation(
  name: string,
  result: string | undefined
): CommandPresentation | null {
  if (
    !isCommandTool(name) ||
    result === undefined ||
    result.startsWith("ERROR[")
  )
    return null
  let snapshots: Array<CommandSnapshot | null>
  if (name === "run_shell_tool") {
    let parsed = legacy(result)
    if (!parsed) {
      try {
        parsed = snapshot(JSON.parse(result))
      } catch {
        return null
      }
    }
    if (!parsed) return null
    snapshots = [parsed]
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(result)
    } catch {
      return null
    }
    if (name === "wait_for_events") {
      if (
        !record(parsed) ||
        !["empty", "completed"].includes(String(parsed.status)) ||
        !Array.isArray(parsed.completions) ||
        (parsed.status === "empty" && parsed.completions.length !== 0)
      )
        return null
      snapshots = parsed.completions.map((entry) => {
        const s = snapshot(entry)
        return s &&
          s.status !== "running" &&
          s.eventId &&
          s.sessionId &&
          record(entry) &&
          typeof entry.runId === "string"
          ? s
          : null
      })
    } else {
      const s = snapshot(parsed)
      if (!s) return null
      snapshots = [s]
    }
  }
  const outcomes = snapshots.map((s) => (s ? snapshotOutcome(s) : "unknown"))
  const outcome = outcomes.includes("failure")
    ? "failure"
    : outcomes.includes("reported_running")
      ? "reported_running"
      : outcomes.includes("unknown")
        ? "unknown"
        : "success"
  return {
    snapshots,
    outcome,
    label:
      snapshots.length === 1 && snapshots[0]
        ? snapshotLabel(snapshots[0])
        : snapshots.length === 0
          ? "No completion events"
          : outcome === "failure"
            ? "Command failure reported"
            : outcome === "unknown"
              ? "Some outcomes unavailable"
              : `${snapshots.length} command completions`,
  }
}
