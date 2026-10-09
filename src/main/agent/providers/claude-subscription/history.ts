import { replayToolCallArguments } from "../../tool-call-arguments"
import { invalid, object, onlyKeys } from "./errors"

export const TOOL_PREFIX = "mcp__ns__"
export type NativeBlock = Record<string, any>
export interface ReplayFrame {
  type: "user" | "assistant"
  message: { role: "user" | "assistant"; content: NativeBlock[] }
  shouldQuery?: boolean
}

export function inventoryIdentity(name: unknown): {
  server: string
  name: string
  native: string
} {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name))
    invalid("Malformed host tool name.")
  let server = "ns"
  let tool = name
  if (name.startsWith("mcp__")) {
    const match = /^mcp__([a-z0-9]+(?:-[a-z0-9]+)*)__([a-zA-Z0-9_-]+)$/.exec(
      name
    )
    if (!match)
      invalid(
        "MCP server names must be canonical lowercase slugs; normalization is not implicit."
      )
    server = match[1]
    tool = match[2]
  }
  const native = `mcp__${server}__${tool}`
  if (native.length > 64)
    invalid("Tool names must fit the native MCP namespace without renaming.")
  return { server, name: tool, native }
}

export function nativeToolName(name: unknown): string {
  return inventoryIdentity(name).native
}

function contentBlocks(content: unknown, images: boolean): NativeBlock[] {
  if (content === null || content === undefined) return []
  if (typeof content === "string")
    return content ? [{ type: "text", text: content }] : []
  if (!Array.isArray(content)) invalid("Unsupported message content.")
  return content.map((part) => {
    if (!object(part)) invalid("Unsupported message part.")
    if (part.type === "text" && typeof part.text === "string") {
      onlyKeys(part, ["type", "text"])
      return { type: "text", text: part.text }
    }
    if (images && part.type === "image_url" && object(part.image_url)) {
      onlyKeys(part, ["type", "image_url"])
      onlyKeys(part.image_url, ["url", "detail"])
      const match =
        typeof part.image_url.url === "string" &&
        /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
          part.image_url.url
        )
      if (
        !match ||
        Buffer.from(match[2], "base64").toString("base64") !== match[2]
      ) {
        invalid(
          "Only native base64 image attachments are supported; remote images are not fetched."
        )
      }
      return {
        type: "image",
        source: { type: "base64", media_type: match[1], data: match[2] },
      }
    }
    invalid("Unsupported message part.")
  })
}

export function translateHistory(
  messages: unknown,
  toolName = nativeToolName
): {
  system: string
  frames: ReplayFrame[]
} {
  if (!Array.isArray(messages) || !messages.length)
    invalid("History must not be empty.")
  const system: string[] = []
  const frames: ReplayFrame[] = []
  const calls = new Map<string, boolean>()
  for (const message of messages) {
    if (!object(message)) invalid("Invalid history message.")
    onlyKeys(message, [
      "role",
      "content",
      "tool_calls",
      "tool_call_id",
      "is_error",
    ])
    if (message.role === "system" || message.role === "developer") {
      if (
        frames.length ||
        typeof message.content !== "string" ||
        message.tool_calls ||
        message.tool_call_id
      ) {
        invalid(
          "System/developer content must be leading text, never elevated history."
        )
      }
      system.push(message.content)
      continue
    }
    let role: "user" | "assistant"
    let blocks: NativeBlock[]
    if (message.role === "tool") {
      if (
        typeof message.tool_call_id !== "string" ||
        calls.get(message.tool_call_id) !== false
      ) {
        invalid("Tool result does not match a pending historical call.")
      }
      if (
        message.is_error !== undefined &&
        typeof message.is_error !== "boolean"
      )
        invalid("Invalid tool error flag.")
      calls.set(message.tool_call_id, true)
      role = "user"
      blocks = [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: contentBlocks(message.content, true),
          ...(message.is_error === undefined
            ? {}
            : { is_error: message.is_error }),
        },
      ]
    } else if (message.role === "assistant" || message.role === "user") {
      role = message.role
      blocks = contentBlocks(message.content, role === "user")
      if (message.tool_call_id !== undefined || message.is_error !== undefined)
        invalid("Misplaced tool-result fields.")
      if (message.tool_calls !== undefined) {
        if (role !== "assistant" || !Array.isArray(message.tool_calls))
          invalid("Invalid historical calls.")
        for (const call of message.tool_calls) {
          if (
            !object(call) ||
            call.type !== "function" ||
            typeof call.id !== "string" ||
            !call.id ||
            calls.has(call.id) ||
            !object(call.function) ||
            typeof call.function.arguments !== "string"
          ) {
            invalid("Invalid historical call.")
          }
          onlyKeys(call, ["id", "type", "function"])
          onlyKeys(call.function, ["name", "arguments"])
          const parsed = JSON.parse(
            replayToolCallArguments(call.function.arguments)
          )
          const input = object(parsed)
            ? parsed
            : { _invalid_tool_arguments: call.function.arguments }
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: toolName(call.function.name),
            input,
          })
          calls.set(call.id, false)
        }
      }
    } else invalid("Unsupported message role.")
    if (!blocks.length) invalid("Empty history frame.")
    const previous = frames.at(-1)
    if (role === "user" && previous?.type === "user")
      previous.message.content.push(...blocks)
    else frames.push({ type: role, message: { role, content: blocks } })
  }
  if (
    !frames.length ||
    frames[0].type !== "user" ||
    frames.at(-1)?.type !== "user" ||
    [...calls.values()].some((settled) => !settled)
  )
    invalid(
      "History must end in a complete user/result frame, not assistant prefill."
    )
  for (const frame of frames.slice(0, -1))
    if (frame.type === "user") frame.shouldQuery = false
  return { system: system.join("\n\n"), frames }
}
