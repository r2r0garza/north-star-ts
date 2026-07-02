import type { Tool } from "./types"
import type { Question } from "./types"
import { toolError } from "./output"

// Bounds — keep the panel sane and the schema honest. The UI always appends a
// free-form "Other" choice, so the model never specifies it.
const MAX_QUESTIONS = 4
const MIN_OPTIONS = 2
const MAX_OPTIONS = 4

// Lets the agent pause and ask the user for clarification before proceeding,
// presenting 1-4 questions each with 2-4 preset options (plus an automatic
// "Other" free-form field). Blocks the turn until the user answers; the answers
// come back as the tool result so the model can continue with them. Offered in
// all modes — clarification is useful everywhere.
export const askUserQuestionTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "ask_user_question",
      description:
        "Ask the user one or more clarifying questions when you genuinely need their input " +
        "to proceed — an ambiguous request, a fork in approach, a missing detail. Don't use it " +
        "for things you can decide yourself or find in the workspace. Present 1-4 questions, " +
        'each with 2-4 distinct preset options; a free-form "Other" field is added ' +
        "automatically, so never add your own. Set multiSelect:true when several options can " +
        "apply at once. The turn pauses until the user answers, and their answers are returned " +
        "to you as JSON.",
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

    // Validate/normalize the model-supplied questions before prompting. Bounds
    // mirror the schema; we re-check here because the model can ignore the schema.
    const raw = (args as { questions?: unknown }).questions
    if (!Array.isArray(raw) || raw.length === 0) {
      return toolError("bad_args", "`questions` must be a non-empty array.")
    }
    if (raw.length > MAX_QUESTIONS) {
      return toolError(
        "bad_args",
        `Ask at most ${MAX_QUESTIONS} questions per call.`
      )
    }

    const questions: Question[] = []
    for (const q of raw) {
      const item =
        q && typeof q === "object" ? (q as Record<string, unknown>) : {}
      const question = String(item.question ?? "").trim()
      const header = String(item.header ?? "").trim()
      if (!question)
        return toolError("bad_args", "Each question needs `question` text.")
      const opts = Array.isArray(item.options) ? item.options : []
      const options = opts
        .map((o) => {
          const oo =
            o && typeof o === "object" ? (o as Record<string, unknown>) : {}
          const label = String(oo.label ?? "").trim()
          const description = String(oo.description ?? "").trim()
          return label
            ? { label, ...(description ? { description } : {}) }
            : null
        })
        .filter((o): o is { label: string; description?: string } => o !== null)
      if (options.length < MIN_OPTIONS) {
        return toolError(
          "bad_args",
          `Question "${header || question}" needs at least ${MIN_OPTIONS} options.`
        )
      }
      questions.push({
        question,
        header: header || question.slice(0, 24),
        multiSelect: item.multiSelect === true,
        options: options.slice(0, MAX_OPTIONS),
      })
    }

    const result = await ctx.ask(questions)
    if (result.status === "cancelled") {
      return toolError(
        "cancelled",
        "The user dismissed the question without answering."
      )
    }

    // Return the answers paired with their questions so the model has full
    // context to continue. `selected` is the chosen labels; `other` is any
    // free-form text the user typed.
    const answered = questions.map((q, i) => ({
      question: q.question,
      header: q.header,
      selected: result.answers[i]?.selected ?? [],
      other: result.answers[i]?.other,
    }))
    return JSON.stringify({ answers: answered })
  },
}
