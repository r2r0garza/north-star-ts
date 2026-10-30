import type { ToolUse } from "./timeline"
import {
  commandPresentation,
  type CommandSnapshot,
} from "./command-presentation"

// The caller supplies one conversation/turn, never a global session cache.
export function projectCommandOutcomes(calls: ToolUse[]): ToolUse[] {
  const finals = new Map<string, CommandSnapshot>()
  const conflicts = new Set<string>()
  const key = (call: ToolUse, session: string) =>
    JSON.stringify([call.conversationId ?? "", session])
  for (const call of calls) {
    if (call.status !== "done" && !call.commandLive) continue
    const presentation = commandPresentation(
      call.name,
      call.commandLive ?? call.result
    )
    for (const snapshot of presentation?.snapshots ?? []) {
      if (!snapshot?.sessionId || snapshot.status === "running") continue
      const id = key(call, snapshot.sessionId)
      const previous = finals.get(id)
      if (
        previous &&
        (previous.status !== snapshot.status ||
          previous.exitCode !== snapshot.exitCode ||
          previous.signal !== snapshot.signal ||
          JSON.stringify(previous.cleanupError) !==
            JSON.stringify(snapshot.cleanupError))
      )
        conflicts.add(id)
      finals.set(id, snapshot)
    }
  }
  return calls.map((call) => {
    const snapshot = commandPresentation(
      call.name,
      call.commandLive ?? call.result
    )?.snapshots[0]
    if (snapshot?.status !== "running" || !snapshot.sessionId) return call
    const id = key(call, snapshot.sessionId)
    const outcome = conflicts.has(id) ? undefined : finals.get(id)
    if (!outcome) return call
    return call.commandOutcome &&
      JSON.stringify(call.commandOutcome) === JSON.stringify(outcome)
      ? call
      : { ...call, commandOutcome: outcome }
  })
}
