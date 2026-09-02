import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import type { Message, MessageRole } from "../../db/types"
import {
  conversationRead,
  conversationSearch,
  conversationTreeSearch,
} from "../../db/repositories/conversation-recall"

const ROLE_VALUES: MessageRole[] = ["system", "user", "assistant", "tool"]

export const conversationSearchTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  executionPolicy: { timeoutMs: 30000 },
  definition: {
    type: "function",
    function: {
      name: "conversation_search",
      description:
        "Search the current conversation transcript only. The conversation scope is server-owned; do not pass a conversation id. Results are evidence pointers; use conversation_read to recover exact surrounding messages.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms to find." },
          roles: {
            type: "array",
            items: { type: "string", enum: ROLE_VALUES },
            description: "Optional message roles to include.",
          },
          before_seq: {
            type: "integer",
            description: "Only return matches before this message sequence.",
          },
          after_seq: {
            type: "integer",
            description: "Only return matches after this message sequence.",
          },
          limit: {
            type: "integer",
            description: "Maximum results, default 20, hard cap 50.",
          },
        },
        required: ["query"],
      },
    },
  },
  execute: async (args, ctx) => {
    const conversationId = currentConversation(ctx.conversationId)
    if (!conversationId) return noConversation()
    const parsed = parseSearchArgs(args)
    if ("error" in parsed) return parsed.error
    const hits = conversationSearch(conversationId, parsed.query, parsed)
    return JSON.stringify({ scope: "conversation", hits })
  },
}

export const conversationReadTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  executionPolicy: { timeoutMs: 30000 },
  definition: {
    type: "function",
    function: {
      name: "conversation_read",
      description:
        "Read exact messages from the current conversation transcript by sequence range. The conversation scope is server-owned; do not pass a conversation id.",
      parameters: {
        type: "object",
        properties: {
          start_seq: {
            type: "integer",
            description: "First message sequence to read.",
          },
          end_seq: {
            type: "integer",
            description:
              "Last message sequence to read. Defaults to start_seq.",
          },
          max_messages: {
            type: "integer",
            description: "Maximum messages, default 50, hard cap 100.",
          },
        },
        required: ["start_seq"],
      },
    },
  },
  execute: async (args, ctx) => {
    const conversationId = currentConversation(ctx.conversationId)
    if (!conversationId) return noConversation()
    const startSeq = numberArg(args.start_seq)
    if (startSeq === null || startSeq < 1) {
      return toolError("bad_args", "`start_seq` must be a positive integer.")
    }
    const endSeq = optionalNumberArg(args.end_seq)
    const maxMessages = optionalNumberArg(args.max_messages)
    const messages = conversationRead(
      conversationId,
      startSeq,
      endSeq ?? undefined,
      maxMessages ?? undefined
    )
    return JSON.stringify({
      scope: "conversation",
      messages: messages.map(renderMessage),
      capped:
        typeof maxMessages === "number" && messages.length >= maxMessages
          ? true
          : undefined,
    })
  },
}

export const conversationTreeSearchTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  executionPolicy: { timeoutMs: 30000 },
  definition: {
    type: "function",
    function: {
      name: "conversation_tree_search",
      description:
        "Search the current conversation plus worker transcripts descended from it. The tree scope is server-owned and cannot reach sibling, project, or global conversations.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms to find." },
          include_tasks: {
            type: "boolean",
            description:
              "Include background task worker transcripts. Defaults true.",
          },
          include_subagents: {
            type: "boolean",
            description: "Include subagent worker transcripts. Defaults true.",
          },
          limit: {
            type: "integer",
            description: "Maximum results, default 20, hard cap 50.",
          },
        },
        required: ["query"],
      },
    },
  },
  execute: async (args, ctx) => {
    const conversationId = currentConversation(ctx.conversationId)
    if (!conversationId) return noConversation()
    const parsed = parseSearchArgs(args)
    if ("error" in parsed) return parsed.error
    const hits = conversationTreeSearch(conversationId, parsed.query, {
      ...parsed,
      includeTasks: args.include_tasks !== false,
      includeSubagents: args.include_subagents !== false,
    })
    return JSON.stringify({ scope: "conversation_tree", hits })
  },
}

function currentConversation(value: string | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function noConversation(): string {
  return toolError(
    "no_conversation",
    "Conversation recall needs the current conversation context."
  )
}

function parseSearchArgs(args: Record<string, unknown>):
  | {
      query: string
      roles?: MessageRole[]
      beforeSeq?: number
      afterSeq?: number
      limit?: number
    }
  | { error: string } {
  const query = typeof args.query === "string" ? args.query.trim() : ""
  if (!query) return { error: toolError("bad_args", "`query` is required.") }
  const roles = Array.isArray(args.roles)
    ? args.roles.filter((role): role is MessageRole =>
        ROLE_VALUES.includes(role as MessageRole)
      )
    : undefined
  return {
    query,
    roles,
    beforeSeq: optionalNumberArg(args.before_seq) ?? undefined,
    afterSeq: optionalNumberArg(args.after_seq) ?? undefined,
    limit: optionalNumberArg(args.limit) ?? undefined,
  }
}

function numberArg(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : null
}

function optionalNumberArg(value: unknown): number | null {
  return value === undefined || value === null ? null : numberArg(value)
}

function renderMessage(message: Message) {
  return {
    seq: message.seq,
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls?.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    createdAt: message.createdAt,
  }
}
