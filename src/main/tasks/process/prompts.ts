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
