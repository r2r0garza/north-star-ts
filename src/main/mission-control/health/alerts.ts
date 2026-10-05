import type { HealthEvidence, HealthSeverity, RigGraph } from "../../db/types"
import { parseSeatAddress } from "../../../shared/mission-control/address"
import { HEALTH_DETECTORS } from "../../../shared/mission-control/health-weights"
import { escalationTarget, seatDirectory, USER_ADDRESS } from "../comms"
import { drivingLead } from "../navigator"

// Alert routing (plan 106.8). A warning goes to the user and to the seat with
// the context to analyze it: the lead of the pod where the signal originated,
// or, when that lead is part of the problem (or the pod has none), the lead
// above it. Never an arbitrary seat. Null means only the user hears of it.
export function contextSeat(
  rig: RigGraph,
  input: {
    podKey: string | null
    offenders: string[]
    defaultPodKey: string | null
  }
): string | null {
  const directory = seatDirectory(rig)
  const offenders = new Set(input.offenders)
  const pod =
    input.podKey ??
    input.offenders.map((a) => parseSeatAddress(a)?.podKey).find(Boolean) ??
    null
  const above = (address: string): string | null => {
    const target = escalationTarget(rig, address)
    return target === USER_ADDRESS || offenders.has(target) ? null : target
  }
  if (pod) {
    const lead = directory.find(
      (s) => s.podKey === pod && s.isLead && !s.vacant
    )
    if (lead && !offenders.has(lead.address)) return lead.address
    // The lead is in the loop, or the pod has none: go up a level.
    const from =
      lead ?? directory.find((s) => s.podKey === pod && !s.vacant) ?? null
    if (from) return above(from.address)
  }
  const top = drivingLead(rig, input.defaultPodKey)
  if (!top) return null
  return offenders.has(top.address) ? above(top.address) : top.address
}

export interface AlertContent {
  detector: string
  severity: HealthSeverity
  summary: string
  anchorLabel: string
  evidence: HealthEvidence[]
}

function when(at: number | null): string {
  return at === null ? "" : ` (${new Date(at).toISOString().slice(11, 16)})`
}

// The alert a context-bearing seat receives: what fired, the evidence, and
// what's asked of it. Short enough to read in one turn.
export function renderAlert(content: AlertContent): string {
  const spec = HEALTH_DETECTORS.find((d) => d.key === content.detector)
  const lines = [
    `Health alert · ${spec?.label ?? content.detector} (${spec?.pathology ?? "coordination"}) · ${content.severity} · ${content.anchorLabel}`,
    "",
    content.summary,
  ]
  if (spec) lines.push("", `What this watches for: ${spec.description}`)
  if (content.evidence.length) {
    lines.push("", "Evidence:")
    for (const item of content.evidence.slice(0, 8))
      lines.push(`- ${item.label}${when(item.at)}`)
  }
  lines.push(
    "",
    "Reply with a short analysis (two or three sentences): is this real, and why is it happening? Then do exactly one:",
    "- continue: the work is healthy; say what will move the map next;",
    "- replan: change the plan with your map tools so the work can move;",
    "- escalate: only when the user must decide something; call `escalate` with a `question` and 2–4 `options`, then wait for the answer instead of acting on the work.",
    "The seats involved were shown a Refocus. Don't answer with more coordination than the fix needs."
  )
  return lines.join("\n")
}

// The user's notification: one line of what, one of why.
export function renderNotification(content: AlertContent): {
  title: string
  body: string
} {
  const spec = HEALTH_DETECTORS.find((d) => d.key === content.detector)
  return {
    title: `Health: ${spec?.label ?? content.detector} · ${content.anchorLabel}`,
    body: content.summary.slice(0, 300),
  }
}
