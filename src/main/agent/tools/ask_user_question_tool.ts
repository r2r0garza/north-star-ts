import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import {
  ASK_USER_QUESTION_DESCRIPTION,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  formatAnswers,
  normalizeQuestions,
} from "../questions/normalize"

// Lets the agent pause and ask the user for clarification before proceeding,
// presenting 1-4 questions each with 2-4 preset options (plus an automatic
// "Other" free-form field). Blocks the turn until the user answers; the answers
// come back as the tool result so the model can continue with them. Offered in
// all modes — clarification is useful everywhere. The bounds, validation, and
// answer shape live in ../questions/normalize so the CLI MCP bridge's adapter
// (plan 045.2) offers the identical contract.
export const askUserQuestionTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "ask_user_question",
      description: ASK_USER_QUESTION_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: MAX_QUESTIONS,
            description: "The questions to ask (1-4).",
            items: {
              type: "object",
              properties: {
                question: {
                  type: "string",
                  description: "The full question text shown to the user.",
                },
                header: {
                  type: "string",
                  description:
                    'A very short label/chip for the question, e.g. "Auth method".',
                },
                multiSelect: {
                  type: "boolean",
                  description:
                    "true: the user may select several options. false (default): exactly one.",
                },
                options: {
                  type: "array",
                  minItems: MIN_OPTIONS,
                  maxItems: MAX_OPTIONS,
                  description:
                    '2-4 distinct preset choices. Do NOT include an "Other" option.',
                  items: {
                    type: "object",
                    properties: {
                      label: {
                        type: "string",
                        description: "The choice the user sees and selects.",
                      },
                      description: {
                        type: "string",
                        description:
                          "Optional one-line explanation of the choice / its trade-off.",
                      },
                    },
                    required: ["label"],
                  },
                },
              },
              required: ["question", "header", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.ask) {
      return toolError(
        "unavailable",
        "Asking the user a question isn't available in this context."
      )
    }

    const normalized = normalizeQuestions(
      (args as { questions?: unknown }).questions
    )
    if (!normalized.ok) return toolError("bad_args", normalized.error)

    const result = await ctx.ask(normalized.questions)
    if (result.status === "cancelled") {
      return toolError(
        "cancelled",
        "The user dismissed the question without answering."
      )
    }
    return formatAnswers(normalized.questions, result.answers)
  },
}
