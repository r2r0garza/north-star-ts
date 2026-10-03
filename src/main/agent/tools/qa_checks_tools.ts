import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import {
  refreezeQaChecks,
  runQaChecks,
  summarizeCheckRun,
} from "../../mission-control/qa-checks"

// QA acceptance checks (plan 109.02). Offered only to a Mission Control QA
// seat's work turn in a user story run. The story, its manifest, and the
// phase run the results land on are resolved server-side from ToolContext;
// the model only picks which checks to run.

export const runChecksTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "run_checks",
      description:
        "Run this user story's automated acceptance checks from its check manifest, in this " +
        "worktree. A failing check is rerun once and both attempts are recorded, so flaky " +
        "checks show up. Results are recorded on this step by the harness; the proof is " +
        "judged against them. Returns pass/fail per check and the output of failures. " +
        "In a merge re-verification, runs the checks of every user story in the milestone.",
      parameters: {
        type: "object",
        properties: {
          checkIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Run only these check ids from the manifest. Omit to run every automated check.",
          },
        },
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.processRunId || !ctx.processPhaseRunId)
      return toolError(
        "unavailable",
        "run_checks is only available to a QA seat in a Mission Control user story run."
      )
    const checkIds = Array.isArray(args.checkIds)
      ? args.checkIds.filter(
          (id): id is string => typeof id === "string" && id.trim() !== ""
        )
      : undefined
    const outcome = await runQaChecks({
      processRunId: ctx.processRunId,
      phaseRunId: ctx.processPhaseRunId,
      workspace: ctx.workspace,
      checkIds,
      signal: ctx.signal,
    })
    if (!outcome.ok) return toolError(outcome.code, outcome.message)
    return summarizeCheckRun(outcome)
  },
}

export const refreezeChecksTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "refreeze_checks",
      description:
        "Accept the current checks directory as the new frozen version, after reviewing changes " +
        "made since the checks step. Use it only when every change is legitimate (for example, " +
        "you fixed your own check); if the builder weakened a check, record a rejected proof " +
        "instead. Required before an accepted proof when the checks changed.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why the changed checks are legitimate.",
          },
        },
        required: ["reason"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.processRunId || !ctx.processPhaseRunId)
      return toolError(
        "unavailable",
        "refreeze_checks is only available to a QA seat's test step in a Mission Control user story run."
      )
    const result = await refreezeQaChecks({
      processRunId: ctx.processRunId,
      phaseRunId: ctx.processPhaseRunId,
      workspace: ctx.workspace,
      reason: typeof args.reason === "string" ? args.reason : "",
    })
    if (!result.ok) return toolError(result.code, result.message)
    return `Re-froze the checks directory (${result.files} files). ${result.changed ? `The ${result.changed} changed file${result.changed === 1 ? "" : "s"} no longer block an accepted proof.` : "Nothing had changed since the last freeze."}`
  },
}
