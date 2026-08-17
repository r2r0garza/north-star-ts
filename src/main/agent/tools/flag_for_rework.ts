import type { Tool } from "./types"
import { toolError } from "./output"
import * as processes from "../../db/repositories/processes"
import { resolveTarget } from "../../tasks/process/flagback"

// The per-run cap on how many rework flags may be raised (plan 031.2). The DAG has
// no cycle guard, so cross-phase flag-back MUST be bounded — a flagging phase that
// re-runs could otherwise re-flag forever. Mirrors MAX_FAN_OUT's role as a hard
// runaway bound.
export const MAX_FLAGS_PER_RUN = 10

// flag_for_rework (plan 031.2): a Process phase-worker that finds a defect an
// EARLIER phase owns records a structured flag instead of fixing out of lane. The
// engine routes it after this phase settles — resetting the target phase (or the
// single fan-out sub-task this worker consumed) and everything downstream, then
// re-running. Offered ONLY to process phase workers (ctx.processRunId set).
export const flagForReworkTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "flag_for_rework",
      description:
        "Flag a defect that an EARLIER phase of this process owns, instead of fixing it " +
        "yourself (fixing out of your lane leaves the real source untouched). The earlier " +
        "phase — and everything built on its output — will be re-run to address your feedback.\n\n" +
        "Only flag work that ran BEFORE you; you cannot flag your own phase or a later one. " +
        "Name the target by its phase key (shown in the 'Phases you may flag for rework' section " +
        "of your briefing). If you are reviewing a single sub-task of a fan-out phase, just name " +
        "that phase's key — the engine knows which sub-task you are working on.\n\n" +
        "Use this sparingly and only for a concrete, upstream-owned defect; prefer completing your " +
        "own work when the issue is yours to fix.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "The key of the upstream phase to send back. For a specific sub-task of a fan-out " +
              "phase you did NOT directly consume, you may use 'key#N' (N is the 1-based sub-task number).",
          },
          reason: {
            type: "string",
            description:
              "A specific, actionable description of the defect and what the earlier phase must change.",
          },
        },
        required: ["target", "reason"],
      },
    },
  },
  execute: async (args, ctx) => {
    const target = typeof args.target === "string" ? args.target.trim() : ""
    const reason = typeof args.reason === "string" ? args.reason.trim() : ""
    if (!target) return toolError("bad_args", "`target` (an upstream phase key) is required.")
    if (!reason) return toolError("bad_args", "`reason` is required.")

    // Offered only to process phase workers; fail-closed elsewhere.
    if (!ctx.processRunId || !ctx.processPhaseRunId)
      return toolError(
        "unavailable",
        "flag_for_rework is only available inside a Process phase."
      )

    const run = processes.getProcessRun(ctx.processRunId)
    if (!run?.processId)
      return toolError("unavailable", "this process run is no longer available.")
    const graph = processes.getProcessGraph(run.processId)
    if (!graph) return toolError("unavailable", "the process graph is unavailable.")
    const flaggingRun = processes.getPhaseRun(ctx.processPhaseRunId)
    if (!flaggingRun)
      return toolError("unavailable", "this phase run is no longer available.")

    // Per-run flag budget — the mandatory bound (no cycle guard on the DAG).
    const raised = processes.listFlags({ runId: ctx.processRunId })
    if (raised.length >= MAX_FLAGS_PER_RUN)
      return toolError(
        "flag_budget",
        `this run has already raised ${raised.length} rework flags (the limit); finish your own work instead.`
      )

    // Parse an optional `key#N` sub-task index off the target.
    const hashIdx = target.lastIndexOf("#")
    let targetPhaseKey = target
    let subtaskIndex: number | undefined
    if (hashIdx > 0) {
      const n = Number(target.slice(hashIdx + 1))
      if (Number.isInteger(n) && n > 0) {
        targetPhaseKey = target.slice(0, hashIdx)
        subtaskIndex = n
      }
    }

    const resolved = resolveTarget(graph, ctx.processRunId, flaggingRun, {
      targetPhaseKey,
      subtaskIndex,
    })
    if ("error" in resolved) return toolError("bad_target", resolved.error)

    processes.createFlag({
      runId: ctx.processRunId,
      flaggingPhaseRunId: ctx.processPhaseRunId,
      targetPhaseId: resolved.targetPhaseId,
      targetChildRunId: resolved.targetChildRunId ?? null,
      reason,
    })

    return (
      `Flag recorded against "${targetPhaseKey}". It will be routed after this phase completes; ` +
      `that phase and its downstream will re-run to address: ${reason}`
    )
  },
}
