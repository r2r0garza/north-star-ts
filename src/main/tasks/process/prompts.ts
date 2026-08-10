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
  // A reviewer's "Request changes" feedback (plan 029): when this phase was
  // gated and sent back, the note is surfaced so the re-run addresses it.
  reworkNote?: string
}): string {
  const { phase, objective, upstream, reworkNote } = input
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
  if (reworkNote?.trim()) {
    lines.push("## Requested changes")
    lines.push(
      "A reviewer looked at your previous attempt at this phase and asked for " +
        "changes. Address this feedback before you finish:"
    )
    lines.push("")
    lines.push(reworkNote.trim())
    lines.push("")
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
      "cannot see this message or the other sub-tasks)."
  )
  lines.push(
    "Strict format: a plain JSON array of double-quoted strings. NOT an array of " +
      "objects. No trailing commas. No markdown code fences. No prose before or " +
      "after the array — the array must be your entire reply."
  )
  lines.push("")
  lines.push('Example: ["Implement the login form component", "Add the /session API route"]')
  return lines.join("\n")
}

// Corrective coda appended to the decomposition prompt on a retry (plan: fan-out
// robustness), after a previous attempt's reply failed to parse. Nudges the model
// back to the strict contract parseDecomposition expects.
export const decompositionRetryNote =
  "\n\n## Important\nYour previous reply could not be parsed as a JSON array of " +
  "strings. Reply with ONLY that array — a plain JSON array of double-quoted " +
  "strings, no objects, no code fences, no prose."

// String fields we'll accept off an object element, in preference order, when a
// model "enriches" the array as `[{ "briefing": "…" }]` instead of plain strings.
const BRIEFING_KEYS = [
  "briefing",
  "task",
  "prompt",
  "subtask",
  "description",
  "text",
]

// Coerce one array element to a sub-task briefing string, or null if it carries
// none. Accepts a plain string, or an object with one of BRIEFING_KEYS (else its
// sole string value).
function elementToBriefing(el: unknown): string | null {
  if (typeof el === "string") return el.trim() || null
  if (el && typeof el === "object") {
    const obj = el as Record<string, unknown>
    for (const key of BRIEFING_KEYS) {
      if (typeof obj[key] === "string" && obj[key].trim())
        return (obj[key] as string).trim()
    }
    // Fall back to the sole string value, if the object has exactly one.
    const strings = Object.values(obj).filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0
    )
    if (strings.length === 1) return strings[0].trim()
  }
  return null
}

// From `text` starting at `from`, find the balanced `]` matching the `[` at
// `from`, tracking string literals so brackets inside strings don't miscount.
// Returns the index of the closing `]`, or -1 if unbalanced.
function matchBracket(text: string, from: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

// Try to parse a JSON array of briefings out of one candidate string: scan each
// `[` and match its balanced `]`, JSON.parse the slice, and coerce elements to
// briefing strings. Returns [] if no bracketed run parses into a non-empty list.
function briefingsFromCandidate(candidate: string): string[] {
  for (let start = candidate.indexOf("["); start !== -1; start = candidate.indexOf("[", start + 1)) {
    const end = matchBracket(candidate, start)
    if (end === -1) break
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1))
    } catch {
      continue // this `[` didn't start a valid array — try the next one
    }
    if (!Array.isArray(parsed)) continue
    const briefings = parsed
      .map(elementToBriefing)
      .filter((s): s is string => s !== null)
    if (briefings.length > 0) return briefings
  }
  return []
}

// Tolerant extraction of the sub-task list from a decomposition worker's final
// assistant message (plan 025.1). Real LLM output varies, so this is deliberately
// forgiving: it scans every fenced code block AND the raw text for the first
// bracketed run that JSON-parses into a non-empty array, matching brackets in a
// string-aware way (so prose brackets / a leading non-JSON fence don't defeat it)
// and accepting arrays of objects (pulling a briefing field) as well as plain
// strings. Trims, drops empties, caps at MAX_FAN_OUT. Returns [] on a genuine
// miss — the caller treats an empty result as a decomposition failure.
export function parseDecomposition(text: string): string[] {
  if (!text) return []
  // Candidates in priority order: each fenced block's body (a model may open with
  // an explanatory fence before the JSON one), then the whole raw text.
  const candidates: string[] = []
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  while ((m = fence.exec(text)) !== null) candidates.push(m[1])
  candidates.push(text)

  for (const candidate of candidates) {
    const briefings = briefingsFromCandidate(candidate)
    if (briefings.length > 0) return briefings.slice(0, MAX_FAN_OUT)
  }
  return []
}
