import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import { recordWaveGate, runGateSuite } from "../../mission-control/gate-step"

// The wave gate's QA tools (plan 112.5): run the acceptance suite, and record
// the gate. Offered ONLY to the QA step of a milestone's acceptance gate. The
// gate, its stories, and the suite are resolved server-side from
// ToolContext; the model supplies findings, never identity.

export const runSuiteTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "run_suite",
      description:
        "Run the acceptance suite (Playwright, in e2e/) against the app running for this step and report each test's result. " +
        "With no grep it runs the whole suite, and that run is what record_gate counts until the suite changes. " +
        "Pass grep (a test title pattern, e.g. a tag) to run a few tests while you work.",
      parameters: {
        type: "object",
        properties: {
          grep: {
            type: "string",
            description:
              'Optional test title pattern, e.g. "@FEAT.M1.US2 @AC-1". Omit to run the whole suite.',
          },
        },
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.processRunId || !ctx.processPhaseRunId || !ctx.workspace)
      return toolError(
        "unavailable",
        "run_suite is only available in a milestone's acceptance gate."
      )
    const grep =
      typeof args.grep === "string" && args.grep.trim()
        ? args.grep.trim()
        : undefined
    const result = await runGateSuite({
      processRunId: ctx.processRunId,
      processPhaseRunId: ctx.processPhaseRunId,
      workspace: ctx.workspace,
      grep,
      signal: ctx.signal,
    })
    return result.ok ? result.text : toolError(result.code, result.message)
  },
}

export const recordGateTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "record_gate",
      description:
        "Record the acceptance gate: triage every criterion of the batch (and every earlier criterion whose test failed) " +
        "against the latest whole-suite run_suite. Tests map to criteria by their title tags `@<storyRef> @AC-n`. " +
        "The tool checks each outcome against the run and explains anything it refuses. Recording again replaces the record.",
      parameters: {
        type: "object",
        properties: {
          stories: {
            type: "array",
            description: "One entry per user story you triaged.",
            items: {
              type: "object",
              properties: {
                story: {
                  type: "string",
                  description:
                    "The story's ref, as its tests are tagged (without @), or its key.",
                },
                criteria: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string", description: "e.g. AC-1" },
                      outcome: {
                        type: "string",
                        enum: [
                          "passed",
                          "app_bug",
                          "check_fixed",
                          "environment",
                          "spec_question",
                        ],
                      },
                      evidence: {
                        type: "string",
                        description: "What ran and what you observed.",
                      },
                      artifacts: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Evidence paths browser_screenshot (or save_evidence) returned. Needed for a criterion no test covers.",
                      },
                      problem: {
                        type: "string",
                        description:
                          "app_bug: what the app does that the criterion doesn't allow. The fix story's builder reads it first.",
                      },
                      justification: {
                        type: "string",
                        description:
                          "check_fixed: what the test asserted that the criterion doesn't ask for.",
                      },
                      reason: {
                        type: "string",
                        description:
                          "environment: what kept the tests from reaching the app.",
                      },
                      question: {
                        type: "string",
                        description:
                          "spec_question: what a later story changed and why this earlier criterion no longer holds, for the user to decide.",
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
    if (!ctx.processRunId || !ctx.processPhaseRunId || !ctx.workspace)
      return toolError(
        "unavailable",
        "record_gate is only available in a milestone's acceptance gate."
      )
    const result = await recordWaveGate({
      processRunId: ctx.processRunId,
      processPhaseRunId: ctx.processPhaseRunId,
      workspace: ctx.workspace,
      args,
    })
    if (!result.ok) return toolError(result.code, result.message)
    return JSON.stringify({
      warnings: result.report.warnings,
      message: result.message,
    })
  },
}

export const gateTools: Tool[] = [runSuiteTool, recordGateTool]
