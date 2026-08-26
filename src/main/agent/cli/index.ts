import { app } from "electron"
import { mkdir, realpath, stat } from "fs/promises"
import { isAbsolute, join, resolve } from "path"
import { appendMessage, listMessages } from "../../db/repositories/messages"
import {
  deleteCliSession,
  ensureCliSession,
  touchCliSession,
} from "../../db/repositories/cli-sessions"
import type { Conversation } from "../../db/types"
import type { ChatEvent, ChatResult } from "../index"
import { normalizeClaudeModel, runClaudeCode } from "./claude"

export async function resolveCliCwd(input: {
  conversation: Conversation
  workspace?: string
  userDataPath?: string
}): Promise<string> {
  if (input.conversation.mode === "chat") {
    const cwd = join(
      input.userDataPath ?? app.getPath("userData"),
      "cli-chat-workdirs",
      input.conversation.id
    )
    await mkdir(cwd, { recursive: true })
    return realpath(cwd)
  }
  if (!input.workspace || !isAbsolute(input.workspace)) {
    throw new Error(
      "A valid absolute workspace path is required for Claude Code."
    )
  }
  const cwd = resolve(input.workspace)
  const info = await stat(cwd).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`Workspace does not exist: ${cwd}`)
  return realpath(cwd)
}

export async function runClaudeConversation(input: {
  conversation: Conversation
  workspace?: string
  userMessage?: string
  model?: string | null
  abort: AbortController
  onEvent: (event: ChatEvent) => void
}): Promise<ChatResult> {
  let prompt = input.userMessage
  if (prompt !== undefined) {
    prompt = prompt || "Hello"
    appendMessage({
      conversationId: input.conversation.id,
      role: "user",
      content: prompt,
    })
  } else {
    const latestUser = listMessages(input.conversation.id)
      .slice()
      .reverse()
      .find((message) => message.role === "user" && message.content)
    prompt = latestUser?.content ?? "Continue."
  }

  try {
    const cwd = await resolveCliCwd({
      conversation: input.conversation,
      workspace: input.workspace,
    })
    const { session, created } = ensureCliSession(
      input.conversation.id,
      "claude_code"
    )
    const toolNames = new Map<string, string>()
    const result = await runClaudeCode({
      cwd,
      message: prompt,
      sessionId: session.sessionId,
      resume: !created,
      model: normalizeClaudeModel(input.model),
      signal: input.abort.signal,
      onEvent: (event) => {
        if (event.type === "text" && event.text) {
          input.onEvent({ type: "token", delta: event.text })
        } else if (event.type === "tool_start" && event.id && event.name) {
          toolNames.set(event.id, event.name)
          input.onEvent({
            type: "tool",
            phase: "start",
            id: event.id,
            name: event.name,
            arguments: event.arguments ?? "{}",
          })
        } else if (event.type === "tool_done" && event.id) {
          input.onEvent({
            type: "tool",
            phase: "done",
            id: event.id,
            name: toolNames.get(event.id) ?? event.name ?? "Claude tool",
            result: event.result ?? "",
          })
        }
      },
    })
    touchCliSession(input.conversation.id, "claude_code")
    if (result.stopped) {
      appendMessage({
        conversationId: input.conversation.id,
        role: "assistant",
        content: "⏹ Stopped by user.",
      })
      return { stopped: true }
    }
    if (result.error) {
      // A failed first spawn (missing binary, auth failure, invalid setup) did
      // not establish a resumable native session. Let the next attempt use
      // --session-id again instead of trying --resume on a phantom session.
      if (created) deleteCliSession(input.conversation.id, "claude_code")
      appendMessage({
        conversationId: input.conversation.id,
        role: "assistant",
        content: `⚠️ The Claude Code turn ended early: ${result.error}`,
      })
      return { error: result.error }
    }
    appendMessage({
      conversationId: input.conversation.id,
      role: "assistant",
      content: result.content ?? "",
    })
    return { content: result.content }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendMessage({
      conversationId: input.conversation.id,
      role: "assistant",
      content: `⚠️ The Claude Code turn ended early: ${message}`,
    })
    return { error: message }
  }
}
