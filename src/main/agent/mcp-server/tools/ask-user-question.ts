import { randomUUID } from "crypto"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { askUser } from "../../questions/broker"
import {
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  formatAnswers,
  normalizeQuestions,
} from "../../questions/normalize"
import type { CliMcpGrant } from "../types"

// How long a bridge question may wait on a human before the call is released as
// cancelled. Long enough that stepping away doesn't break the turn, bounded so a
// CLI never hangs forever on a panel nobody will answer. Both CLIs are told to
// wait at least this long (see inject.ts) so the timeout is ours, not theirs.
export const QUESTION_TIMEOUT_MS = 60 * 60 * 1000

// The MCP input schema. Hand-written JSON Schema rather than a zod shape: the
// bounds and wording are the same contract the internal tool publishes, and the
// adapter re-validates every argument anyway (normalizeQuestions).
// Deliberately NOT the internal tool's wording. A CLI can always ask in prose,
// and both Claude Code and Codex are tuned to do exactly that, so a description
// hedged with "don't use it for things you can decide yourself" reads as "skip
// this" and the tool goes unused. This copy instead names the two things prose
// cannot do: render clickable options, and get an answer back without ending
// the turn. Everything it claims is true of the round trip we actually run.
export const ASK_USER_QUESTION_BRIDGE_DESCRIPTION =
  "Ask the user a question. Use this tool for EVERY question you put to the user — never " +
  "write a question to them in prose instead. If you are about to end your turn with a " +
  "question, or write a line to the user that ends in a question mark, call this first. The " +
  "user is in the North Star desktop app, not a terminal: this renders a form with clickable " +
  "options and returns their answer to you, so you keep working in the same turn instead of " +
  "stopping and waiting for them to type. Only for questions the user alone can answer — keep " +
  "deciding for yourself anything the workspace already answers. Present 1-4 questions, each " +
  'with 2-4 distinct preset options; a free-form "Other" field is added automatically, so ' +
  "never add your own. Set multiSelect:true when several options can apply at once. Their " +
  "answers come back to you as JSON."

export const askUserQuestionMcpTool = {
  name: "ask_user_question",
  description: ASK_USER_QUESTION_BRIDGE_DESCRIPTION,
  annotations: {
    title: "Ask the user a question",
    // Not read-only: it interrupts the human. Never marked open-world/idempotent
    // either, so a client can't batch it alongside independent reads.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: {
    type: "object" as const,
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
}

// The SDK's own result type, so the handler satisfies the CallTool union
// (which also admits an async-task variant we never produce).
export type McpToolResult = CallToolResult

function fail(message: string): McpToolResult {
  return { content: [{ type: "text", text: message }], isError: true }
}

// Run one bridge question. The conversation and the renderer channel come from
// the authenticated grant, never from the call's arguments, so a CLI cannot
// raise a panel on another conversation.
export async function callAskUserQuestion(
  args: unknown,
  grant: CliMcpGrant
): Promise<McpToolResult> {
  const sink = grant.question
  if (!sink) {
    return fail(
      "Asking the user a question isn't available for this turn — no interactive session is attached."
    )
  }
  if (sink.signal.aborted) {
    return fail("The turn was stopped before the question could be asked.")
  }

  const normalized = normalizeQuestions(
    (args as { questions?: unknown } | null)?.questions
  )
  if (!normalized.ok) return fail(normalized.error)

  const result = await askUser({
    conversationId: grant.conversationId,
    // The CLI's own tool-call id never reaches the MCP server, so mint one. The
    // renderer only uses it to key the panel to a live turn.
    toolCallId: `north-star-mcp-${randomUUID()}`,
    questions: normalized.questions,
    emit: sink.emit,
    signal: sink.signal,
    timeoutMs: QUESTION_TIMEOUT_MS,
  })
  if (result.status === "cancelled") {
    return fail(
      "The user dismissed the question without answering. Continue with a reasonable assumption and say which one you made."
    )
  }
  return {
    content: [
      {
        type: "text",
        text: formatAnswers(normalized.questions, result.answers),
      },
    ],
  }
}
