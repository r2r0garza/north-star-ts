import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import { recordUserStoryProof } from "../../mission-control/user-story-runner"

// record_proof (plan 106.3): the verifier seat of a Mission Control user story run
// records a structured proof with evidence per acceptance criterion. Offered
// ONLY to a playbook's proof step. The user story, its criteria, the verifier seat,
// and the builders are all resolved server-side from ToolContext — the model
// supplies findings, never identity. Independence, freeze-on-accept, and the
// revision cap are enforced here, at the tool boundary.
export const recordProofTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "record_proof",
      description:
        "Record this user story's proof: one entry per acceptance criterion (ids AC-1, AC-2, … as " +
        "listed in your objective), each with a status, how you verified it (method), and " +
        'concrete evidence, plus an overall verdict. "accepted" requires every criterion met. ' +
        "The harness checks each met criterion against what it recorded in this step: a " +
        "criterion the check manifest covers with automated checks is met only if those checks " +
        "passed here through run_checks (cite them in checkIds); an exploratory criterion needs " +
        'method "app_exercised" with saved evidence (screenshot paths) in artifacts; reading the ' +
        'code alone is never "met" (record it not_verifiable with a reason). Relying only on the ' +
        "builder's tests is allowed but flagged. An accepted proof is frozen; a rejected one may " +
        "be revised a limited number of times. Call it once you have verified every criterion " +
        "yourself.",
      parameters: {
        type: "object",
        properties: {
          criteria: {
            type: "array",
            description: "One entry per acceptance criterion.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "The criterion id from the objective, e.g. AC-1.",
                },
                status: {
                  type: "string",
                  enum: ["met", "not_met", "not_verifiable", "deferred"],
                  description:
                    "deferred: in a user story's test step, a criterion your tools can't exercise " +
                    "(say, something only an automated browser check can do). The milestone's wave " +
                    "acceptance gate proves it with Playwright; give the reason. It doesn't block " +
                    "acceptance, but at least one criterion must be verified here.",
                },
                method: {
                  type: "string",
                  enum: [
                    "qa_check",
                    "app_exercised",
                    "builder_tests",
                    "command",
                    "code_read",
                  ],
                  description:
                    "How you verified it: qa_check (QA checks from the manifest, run with " +
                    "run_checks), app_exercised (you drove the running app; cite screenshots), " +
                    "builder_tests (only the builder's tests), command (a command you ran " +
                    "yourself, e.g. curl or the CLI), code_read (you only read the code).",
                },
                checkIds: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "The manifest check ids that verified it. Required for qa_check; must " +
                    "include every automated check the manifest lists for this criterion.",
                },
                evidence: {
                  type: "string",
                  description:
                    "What you ran or inspected, and what you observed.",
                },
                artifacts: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Files that support the evidence: the evidence paths browser_screenshot and " +
                    "save_evidence returned, or workspace-relative paths.",
                },
                reason: {
                  type: "string",
                  description:
                    "Required when accepting a not_verifiable criterion (why it cannot be verified) " +
                    "and for a deferred one (what your tools can't do that the gate's checks can).",
                },
              },
              required: ["id", "status", "method", "evidence"],
            },
          },
          verdict: { type: "string", enum: ["accepted", "rejected"] },
        },
        required: ["criteria", "verdict"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.processRunId || !ctx.processPhaseRunId)
      return toolError(
        "unavailable",
        "record_proof is only available inside a Mission Control user story run."
      )
    const result = await recordUserStoryProof({
      processRunId: ctx.processRunId,
      processPhaseRunId: ctx.processPhaseRunId,
      args,
    })
    if (!result.ok) return toolError(result.code, result.message)
    return JSON.stringify({
      status: result.status,
      verifiedBy: result.proof.verifiedBy,
      criteria: result.proof.criteria.map((c) => ({
        id: c.id,
        status: c.status,
        method: c.method,
      })),
      warnings: result.proof.warnings ?? [],
      message: result.message,
    })
  },
}
