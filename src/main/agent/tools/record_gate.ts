import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import { recordWaveGate } from "../../mission-control/gate-step"

// record_gate (plan 110.02): the QA seat of a milestone's wave acceptance gate
// triages every criterion of the batch (and every earlier criterion whose
// check failed) against the suite it ran. Offered ONLY to that step. The
// gate, its stories, the manifests, and the check results are resolved
// server-side from ToolContext; the model supplies the triage, never identity.
export const recordGateTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "record_gate",
      description:
        "Record this acceptance gate's result: for each user story you triaged (every story in " +
        "the batch, plus any earlier story whose check failed here), one entry per criterion " +
        "with its outcome and evidence. The harness checks each outcome against what " +
        "run_checks recorded on the suite as it is now: passed and check_fixed need its checks " +
        "passing; check_fixed also needs a check of it that failed earlier on this step and a " +
        "justification; app_bug needs a check that failed on an assertion and the problem; " +
        "unreachable needs a check that couldn't reach the app and the reason. Every automated " +
        "check in the suite must have a result on its current version. Recording again " +
        "replaces the previous record until the step ends.",
      parameters: {
        type: "object",
        properties: {
          stories: {
            type: "array",
            description: "One entry per user story triaged.",
            items: {
              type: "object",
              properties: {
                story: {
                  type: "string",
                  description:
                    "The story's ref as run_checks prints it (or, for this milestone's stories, its key).",
                },
                criteria: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: {
                        type: "string",
                        description: "The criterion id, e.g. AC-1.",
                      },
                      outcome: {
                        type: "string",
                        enum: [
                          "passed",
                          "app_bug",
                          "check_fixed",
                          "unreachable",
                        ],
                      },
                      evidence: {
                        type: "string",
                        description:
                          "What ran and what you observed (the check's result, or what the app did).",
                      },
                      checkIds: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Optional: the manifest check ids you mean. The harness uses the manifest's checks for the criterion either way.",
                      },
                      artifacts: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Evidence paths browser_screenshot or save_evidence returned. Needed for a criterion with only exploratory checks.",
                      },
                      problem: {
                        type: "string",
                        description:
                          "app_bug: what the app does that the criterion doesn't allow.",
                      },
                      justification: {
                        type: "string",
                        description:
                          "check_fixed: what the check asserted that the criterion doesn't ask for, and what you changed.",
                      },
                      reason: {
                        type: "string",
                        description:
                          "unreachable: what kept the check from reaching the app.",
                      },
                    },
                    required: ["id", "outcome", "evidence"],
                  },
                },
              },
              required: ["story", "criteria"],
            },
          },
        },
        required: ["stories"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.processRunId || !ctx.processPhaseRunId)
      return toolError(
        "unavailable",
        "record_gate is only available to the QA step of a milestone's acceptance gate."
      )
    const result = await recordWaveGate({
      processRunId: ctx.processRunId,
      processPhaseRunId: ctx.processPhaseRunId,
      workspace: ctx.workspace,
      args,
    })
    if (!result.ok) return toolError(result.code, result.message)
    return JSON.stringify({
      stories: result.report.stories.map((s) => ({
        story: s.key,
        criteria: s.criteria.map((c) => ({ id: c.id, outcome: c.outcome })),
      })),
      warnings: result.report.warnings,
      message: result.message,
    })
  },
}
