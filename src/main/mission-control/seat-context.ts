import type { AgentDefinition } from "../agent/agents/types"
import type { ContextSection } from "../agent/context/context-builder"
import type { SeatBinding, SeatBindingsSnapshot } from "../db/types"

// Seat context layering (plan 106.3, decision 3). Every role-bound worker sees,
// in order: agent body (the base prompt) → seat charter → rig culture → pod
// culture → the static intent chain → the Process kickoff (the user message).
// This provider renders the middle layers as one context section; the agent
// loop places it in the system block like any other section.

export const SEAT_CONTEXT_PRIORITY = 65

function block(title: string, body: string): string[] {
  const text = body.trim()
  return text ? [`### ${title}`, text, ""] : []
}

export function renderSeatContext(
  snapshot: SeatBindingsSnapshot,
  seat: SeatBinding
): string {
  return [
    `## Your seat: ${seat.address}`,
    `You occupy the "${seat.role}" seat in the ${seat.podName} pod of the "${snapshot.rigName}" rig.` +
      (seat.decisionRights.length
        ? ` Your decision rights: ${seat.decisionRights.join(", ")}.`
        : " You hold no decision rights beyond your own work."),
    "",
    ...block("Seat charter", seat.charter),
    ...block("Rig culture", snapshot.rigCulture),
    ...block(
      "Pod mission and culture",
      [seat.podMission.trim(), seat.podCulture.trim()].filter(Boolean).join("\n\n")
    ),
    ...block("Intent chain (why this work exists)", snapshot.intentChain),
  ]
    .join("\n")
    .trim()
}

export function seatContextSection(
  snapshot: SeatBindingsSnapshot,
  seat: SeatBinding
): ContextSection {
  return {
    name: "mission_control_seat",
    priority: SEAT_CONTEXT_PRIORITY,
    content: renderSeatContext(snapshot, seat),
    provenance: {
      trust: "approved_instruction",
      channel: "agent",
      source: `seat:${seat.address}`,
      persisted: true,
    },
  }
}

// The seat's narrowing applied to its agent (tri-state: null keeps the agent's
// own value). A runtime-only definition — never persisted as a conversation
// agent — passed to the agent loop as its agentOverride.
export function narrowedSeatAgent(
  agent: AgentDefinition,
  seat: SeatBinding
): AgentDefinition {
  return {
    ...agent,
    skills: seat.skills ?? agent.skills,
    tools: seat.tools ?? agent.tools,
    mcpServers: seat.mcpServers ?? agent.mcpServers,
  }
}
