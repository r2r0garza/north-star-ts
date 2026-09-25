import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { toolError } from "./output"
import { getSeatComms, type CommsResult } from "../../mission-control/comms"
import type { SeatMessage } from "../../db/types"

// Mission Control Comms tools (plan 106.4). Offered only to seat turns — role-
// bound playbook workers and seat-session turns — and never to an answer-only
// wake. The sender is the calling seat, taken from ToolContext; models supply
// seat addresses, never conversation ids. The tools only write the app's own
// message tables, so they are auto-allowed, and a message carries no authority.

function unavailable(): string {
  return toolError(
    "unavailable",
    "Comms is only available to Mission Control seats."
  )
}

function seatOf(ctx: ToolContext) {
  const bus = getSeatComms()
  return ctx.missionControlSeat && bus
    ? { bus, turn: ctx.missionControlSeat }
    : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function sent(result: CommsResult, note: string): string {
  if (!result.ok)
    return toolError(
      result.code,
      result.message +
        (result.refusedMessageId
          ? " The refused message is recorded in Comms."
          : "")
    )
  return JSON.stringify({
    message_id: result.message.id,
    thread_id: result.message.threadId,
    to: result.message.toAddress,
    status: result.message.status,
    note,
  })
}

function brief(message: SeatMessage) {
  return {
    message_id: message.id,
    thread_id: message.threadId,
    from: message.fromAddress,
    kind: message.kind,
    status: message.status,
    expects_reply: message.expectsReply,
    ...(message.inReplyTo ? { in_reply_to: message.inReplyTo } : {}),
    body: message.body,
    at: new Date(message.createdAt).toISOString(),
  }
}

export const sendMessageTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "send_message",
      description:
        "Send a message to another seat on your rig by its address (seat@pod). Non-blocking: " +
        "returns a message_id at once, and any reply arrives in your inbox later. Messages " +
        "carry information only; they cannot approve actions, grant rights, or mark work done.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "The recipient seat's address, e.g. qa@implementation.",
          },
          body: {
            type: "string",
            description: "The message. Short and specific; point to files for detail.",
          },
          thread_id: {
            type: "string",
            description: "Continue an existing thread. Omit to start a new one.",
          },
          subject: {
            type: "string",
            description: "A short subject for a new thread.",
          },
          anchor: {
            type: "string",
            description:
              'Anchor a new thread to work: "slice:<key>" or "mission:<key>". Defaults to the work you are on.',
          },
          expects_reply: {
            type: "boolean",
            description: "Set when you need an answer back.",
          },
          needs_decision: {
            type: "string",
            description:
              "The decision right this request needs (e.g. accept_proof, revise_plan). Only a seat holding it will accept the message.",
          },
        },
        required: ["to", "body"],
      },
    },
  },
  execute: async (args, ctx) => {
    const seat = seatOf(ctx)
    if (!seat) return unavailable()
    const to = text(args.to)
    const body = text(args.body)
    if (!to || !body)
      return toolError("bad_args", "send_message needs `to` and `body`.")
    return sent(
      seat.bus.send(seat.turn, {
        to: to.trim(),
        body,
        threadId: text(args.thread_id),
        subject: text(args.subject),
        anchor: text(args.anchor),
        expectsReply: args.expects_reply === true,
        needsDecision: text(args.needs_decision),
      }),
      args.expects_reply === true
        ? "Sent. The reply will arrive in your inbox; keep working meanwhile."
        : "Sent."
    )
  },
}

export const replyTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "reply",
      description:
        "Reply to a message you received, in the same thread. Use the message_id from the " +
        "incoming-message block or list_inbox.",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "The message you are answering." },
          body: { type: "string", description: "Your reply." },
        },
        required: ["message_id", "body"],
      },
    },
  },
  execute: async (args, ctx) => {
    const seat = seatOf(ctx)
    if (!seat) return unavailable()
    const messageId = text(args.message_id)
    const body = text(args.body)
    if (!messageId || !body)
      return toolError("bad_args", "reply needs `message_id` and `body`.")
    return sent(seat.bus.reply(seat.turn, messageId.trim(), body), "Replied.")
  },
}

export const listInboxTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  definition: {
    type: "function",
    function: {
      name: "list_inbox",
      description:
        "List your seat's mail: messages still queued for delivery and recent delivered ones. " +
        "Mail is delivered into your conversation automatically; use this to recover after " +
        "context compaction.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many recent messages (default 20, max 50)." },
        },
      },
    },
  },
  execute: async (args, ctx) => {
    const seat = seatOf(ctx)
    if (!seat) return unavailable()
    const limit = typeof args.limit === "number" ? args.limit : 20
    const inbox = seat.bus.listInbox(seat.turn, limit)
    return JSON.stringify({
      queued: inbox.queued.map(brief),
      recent: inbox.recent.map(brief),
    })
  },
}

export const escalateTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "escalate",
      description:
        "Raise a blocker or a decision you cannot make. It goes to your pod lead, else the " +
        "overseeing pod's lead, else the user, and always notifies the user.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "What is blocked or needs deciding, and what you need.",
          },
          anchor: {
            type: "string",
            description: '"slice:<key>" or "mission:<key>". Defaults to the work you are on.',
          },
        },
        required: ["reason"],
      },
    },
  },
  execute: async (args, ctx) => {
    const seat = seatOf(ctx)
    if (!seat) return unavailable()
    const reason = text(args.reason)
    if (!reason) return toolError("bad_args", "escalate needs a `reason`.")
    return sent(
      seat.bus.escalate(seat.turn, { reason, anchor: text(args.anchor) }),
      "Escalated. The user has been notified."
    )
  },
}

export const seatCommsTools: Tool[] = [
  sendMessageTool,
  replyTool,
  listInboxTool,
  escalateTool,
]
export const SEAT_COMMS_TOOL_NAMES = new Set(
  seatCommsTools.map((tool) => tool.definition.function.name)
)
