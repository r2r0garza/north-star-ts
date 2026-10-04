import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import { runQaChecks, summarizeCheckRun } from "../../mission-control/qa-checks"

// QA acceptance checks (plan 109.02). Offered only to a Mission Control QA
// seat's checks step, merge re-verification, or wave gate (plan 110); a user
// story's test step verifies by exploration and runs none (plan 110.04). The
// story, its manifest, and the phase run the results land on are resolved
// server-side from ToolContext; the model only picks which checks to run.

export const runChecksTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "run_checks",
      description:
        "The way to produce repeatable proof: run Playwright and command checks from the check " +
        'manifests in this worktree. Playwright checks (`runner: "playwright"`) ' +
        "run on the workspace's Playwright, or North Star's bundled one when the project has " +
        "none, against the app services they declare (baseURL is set for you). A failing check " +
        "is rerun once and both attempts are recorded, so flaky checks show up. Results are " +
        "recorded on this step by the harness; the proof is judged against them. Returns " +
        "pass/fail per check, each Playwright test's result, the output of failures, and where " +
        "failure traces and screenshots were saved. In a merge re-verification, runs the checks " +
        "of every user story in the milestone; at an acceptance gate, the whole accumulated " +
        "suite of the feature's stories. When Playwright checks need a test browser that " +
        "isn't installed yet, the call waits until the user provides one, then runs them.",
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
        "run_checks is only available to a QA seat's checks step, merge re-verification, or acceptance gate in Mission Control."
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
