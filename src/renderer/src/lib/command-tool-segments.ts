import type { ToolUse } from "./timeline"
import { commandPresentation } from "./command-presentation"

export function isActiveCommandLaunch(call: ToolUse): boolean {
  if (!["exec_command", "run_shell_tool"].includes(call.name)) return false
  if (
    call.commandOutcome ||
    call.status === "interrupted" ||
    call.status === "error" ||
    ["pending", "denied"].includes(call.approval?.status ?? "")
  )
    return false
  const current = commandPresentation(
    call.name,
    call.commandLive ?? call.result
  )
  if (current && current.outcome !== "reported_running") return false
  return call.commandLive
    ? current?.outcome === "reported_running"
    : call.status === "running"
}

export type CommandToolSegment =
  | { kind: "group"; key: string; calls: ToolUse[] }
  | { kind: "command"; key: string; call: ToolUse }

export function commandToolSegments(calls: ToolUse[]): CommandToolSegment[] {
  const segments: CommandToolSegment[] = []
  for (const call of calls) {
    if (isActiveCommandLaunch(call)) {
      segments.push({ kind: "command", key: `command:${call.id}`, call })
    } else {
      const last = segments.at(-1)
      if (last?.kind === "group") last.calls.push(call)
      else
        segments.push({ kind: "group", key: `group:${call.id}`, calls: [call] })
    }
  }
  return segments
}
