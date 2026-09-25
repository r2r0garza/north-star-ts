import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import { recordSliceProof } from "../../mission-control/slice-runner"

// record_proof (plan 106.3): the verifier seat of a Mission Control slice run
// records a structured proof with evidence per acceptance criterion. Offered
// ONLY to a playbook's proof step. The slice, its criteria, the verifier seat,
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
        "Record this slice's proof: one entry per acceptance criterion (ids AC-1, AC-2, … as " +
        "listed in your objective), each with a status and concrete evidence, plus an overall " +
        'verdict. "accepted" requires every criterion met. An accepted proof is frozen; a ' +
        "rejected one may be revised a limited number of times. Call it once you have verified " +
        "every criterion yourself.",
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
                  description: "The criterion id from the objective, e.g. AC-1.",
                },
                status: {
                  type: "string",
                  enum: ["met", "not_met", "not_verifiable"],
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
                    "Workspace-relative paths of files that support the evidence.",
                },
                reason: {
                  type: "string",
                  description:
                    "Required when accepting a not_verifiable criterion: why it cannot be verified.",
                },
              },
              required: ["id", "status", "evidence"],
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
        "record_proof is only available inside a Mission Control slice run."
      )
    const result = recordSliceProof({
      processRunId: ctx.processRunId,
      processPhaseRunId: ctx.processPhaseRunId,
      args,
    })
    if (!result.ok) return toolError(result.code, result.message)
    return JSON.stringify({
      status: result.status,
      verifiedBy: result.proof.verifiedBy,
      criteria: result.proof.criteria.map((c) => ({ id: c.id, status: c.status })),
      warnings: result.proof.warnings ?? [],
      message: result.message,
    })
  },
}
