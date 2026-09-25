import type { SeatTurnProfile } from "../mission-control/seat-turns"
import { getToolEffects } from "./tools"
import { SEAT_COMMS_TOOL_NAMES } from "./tools/seat_comms_tools"

// The toolset a Mission Control seat turn may use (plan 106.4). A playbook
// step (`work`) keeps whatever its agent and seat already allow. A turn woken
// by mail keeps only LOCAL READ-ONLY tools — no mutation, execution,
// delegation, open-world access, or MCP (which declares no effects) — so a
// message can never cause a side effect. `consult` wakes may still message;
// `answer_only` wakes answer in their final message instead.
export function allowedForSeatProfile(
  name: string,
  profile: SeatTurnProfile,
  alwaysReadOnly: ReadonlySet<string> = new Set()
): boolean {
  if (SEAT_COMMS_TOOL_NAMES.has(name)) return profile !== "answer_only"
  if (profile === "work") return true
  if (alwaysReadOnly.has(name)) return true
  const effects = getToolEffects(name)
  return !!effects && effects.readOnly && !effects.openWorld
}
