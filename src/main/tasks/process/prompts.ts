import type { ProcessPhase } from "../../db/types"

// Kickoff builders for a Process phase (plan 025). A phase runs in its OWN forked
// worker conversation (like a subagent), so it cannot see the orchestrator's
// conversation — the kickoff must be self-contained: the run objective, this
// phase's role, and a digest of what upstream phases produced.

export interface UpstreamResult {
  phaseName: string
  // The upstream phase's final assistant content (its "output"), possibly null.
  content: string | null
}

// The message seeded into a phase's worker conversation. Deliberately plain: the
// agent's own .agent.md body is the system prompt; this is the task briefing.
export function kickoffPrompt(input: {
  phase: ProcessPhase
  objective: string
  upstream: UpstreamResult[]
}): string {
  const { phase, objective, upstream } = input
  const lines: string[] = []
  lines.push(`# Process phase: ${phase.name}`)
  lines.push("")
  lines.push("You are executing one phase of a larger multi-phase process.")
  lines.push("")
  lines.push("## Overall objective")
  lines.push(objective.trim() || "(no objective provided)")
  lines.push("")
  if (upstream.length > 0) {
    lines.push("## Output of the phases that ran before you")
    for (const u of upstream) {
      lines.push(`### ${u.phaseName}`)
      lines.push(u.content?.trim() || "(no textual output)")
      lines.push("")
    }
  }
  lines.push("## Your task")
  lines.push(
    `Carry out the "${phase.name}" phase toward the overall objective. When done, ` +
      `summarize what you produced so the next phase can build on it.`
  )
  return lines.join("\n")
}

// The kickoff for an `on_each_subtask` consumer instance (plan 025.2). A phase V
// joined to a fan-out phase C by an `on_each_subtask` edge runs ONCE PER completed
// C sub-task — this briefing carries that single sub-task's output (not the whole
// phase's aggregate) so V works on exactly the piece that just landed. Like
// kickoffPrompt, it's self-contained (the worker can't see the orchestrator).
export function eachSubtaskKickoffPrompt(input: {
  phase: ProcessPhase
  objective: string
  sourcePhaseName: string
  // The triggering sub-task's final output (its worker's last assistant message).
  subtaskContent: string | null
}): string {
  const { phase, objective, sourcePhaseName, subtaskContent } = input
  const lines: string[] = []
  lines.push(`# Process phase: ${phase.name}`)
  lines.push("")
  lines.push(
    "You are executing one phase of a larger multi-phase process. You are being " +
      `run on a SINGLE sub-task produced by the "${sourcePhaseName}" phase — not ` +
      "its whole output. Focus only on the piece below."
  )
  lines.push("")
  lines.push("## Overall objective")
  lines.push(objective.trim() || "(no objective provided)")
  lines.push("")
  lines.push(`## The "${sourcePhaseName}" sub-task to act on`)
  lines.push(subtaskContent?.trim() || "(no textual output)")
  lines.push("")
  lines.push("## Your task")
  lines.push(
    `Carry out the "${phase.name}" phase for this one sub-task toward the overall ` +
      `objective. When done, summarize what you produced.`
  )
  return lines.join("\n")
}

// Upper bound on the number of sub-tasks a fan-out phase may spawn (plan 025.1,
// Open Q #3 — agent-decided but bounded, to prevent runaway spawning). A
// decomposition yielding more is truncated to this cap.
export const MAX_FAN_OUT = 8

// The kickoff for a FAN-OUT phase's decomposition pass (plan 025.1). The phase's
// worker is asked to split the phase's work into N independent sub-tasks and emit
// ONLY a JSON array of sub-task briefings as its final message — each becomes a
// child phase-run with its own worker. Deliberately self-contained like
// kickoffPrompt (the worker can't see the orchestrator conversation).
export function fanOutDecomposePrompt(input: {
  phase: ProcessPhase
  objective: string
  upstream: UpstreamResult[]
}): string {
  const { phase, objective, upstream } = input
  const lines: string[] = []
  lines.push(`# Process phase (fan-out): ${phase.name}`)
  lines.push("")
  lines.push(
    "You are planning one phase of a larger multi-phase process. This phase " +
      "FANS OUT: instead of doing the work yourself, split it into independent " +
      "sub-tasks that will each run in parallel in their own worker."
  )
  lines.push("")
  lines.push("## Overall objective")
  lines.push(objective.trim() || "(no objective provided)")
  lines.push("")
  if (upstream.length > 0) {
    lines.push("## Output of the phases that ran before you")
    for (const u of upstream) {
      lines.push(`### ${u.phaseName}`)
      lines.push(u.content?.trim() || "(no textual output)")
      lines.push("")
    }
  }
  lines.push("## Your task")
  lines.push(
    `Decompose the "${phase.name}" phase into independent sub-tasks — one per ` +
      `distinct piece of work that can proceed on its own. You may inspect the ` +
      `workspace first to decide the split. Aim for at most ${MAX_FAN_OUT} ` +
      `sub-tasks; fewer is fine.`
  )
  lines.push("")
  lines.push(
    "When you are done deciding, reply with ONLY a JSON array of strings — each " +
      "string a complete, self-contained briefing for one sub-task worker (it " +
      "cannot see this message or the other sub-tasks). No prose before or after " +
      "the array."
  )
  lines.push("")
  lines.push('Example: ["Implement the login form component", "Add the /session API route"]')
  return lines.join("\n")
}

// Tolerant extraction of the sub-task list from a decomposition worker's final
// assistant message (plan 025.1). Pulls the first JSON array out of the text
// (tolerating ```json fences / surrounding prose), validates it's a non-empty
// array of non-empty strings, trims + caps at MAX_FAN_OUT. Returns [] on any
// miss — the caller treats an empty result as a decomposition failure.
export function parseDecomposition(text: string): string[] {
  if (!text) return []
  // Prefer a fenced ```json block if present, else the first bracketed array.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf("[")
  const end = candidate.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const subtasks = parsed
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return subtasks.slice(0, MAX_FAN_OUT)
}
