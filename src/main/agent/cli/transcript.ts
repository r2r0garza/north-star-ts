import {
  appendMessage,
  type AppendMessageInput,
} from "../../db/repositories/messages"
import type { ToolCallRecord } from "../../db/types"
import type { CliTurnEvent } from "./claude"

type AssistantEntry = {
  kind: "assistant"
  content: string
  toolCalls: ToolCallRecord[]
}

type ToolEntry = {
  kind: "tool"
  id: string
  name: string
  result: string
}

type TranscriptEntry = AssistantEntry | ToolEntry

// CLI adapters stream a display-oriented event feed, while the renderer reloads
// settled turns from the messages table. Keep a small ordered projection of that
// feed and write the same assistant-tool/tool-result shape used by the built-in
// agent once the child process settles.
export class CliTranscriptRecorder {
  private readonly entries: TranscriptEntry[] = []
  private readonly calls = new Map<string, ToolCallRecord>()
  private readonly completed = new Set<string>()
  private persisted = false

  constructor(
    private readonly conversationId: string,
    private readonly append: (
      input: AppendMessageInput
    ) => unknown = appendMessage
  ) {}

  record(event: CliTurnEvent): void {
    if (this.persisted) return

    if (event.type === "text" && event.text) {
      const last = this.entries.at(-1)
      // Claude may place text and tool_use blocks in either order inside one
      // assistant message. Keep both on the same durable assistant row until a
      // tool result creates the protocol boundary.
      if (last?.kind === "assistant") {
        last.content += event.text
      } else {
        this.entries.push({
          kind: "assistant",
          content: event.text,
          toolCalls: [],
        })
      }
      return
    }

    if (
      event.type === "tool_start" &&
      event.id &&
      event.name &&
      !this.calls.has(event.id)
    ) {
      const call: ToolCallRecord = {
        id: event.id,
        name: event.name,
        arguments: event.arguments ?? "{}",
      }
      this.calls.set(call.id, call)

      const last = this.entries.at(-1)
      if (last?.kind === "assistant") {
        last.toolCalls.push(call)
      } else {
        this.entries.push({ kind: "assistant", content: "", toolCalls: [call] })
      }
      return
    }

    if (
      event.type === "tool_done" &&
      event.id &&
      this.calls.has(event.id) &&
      !this.completed.has(event.id)
    ) {
      const call = this.calls.get(event.id)!
      this.completed.add(event.id)
      this.entries.push({
        kind: "tool",
        id: call.id,
        name: call.name,
        result: event.result ?? "",
      })
    }
  }

  // Pass fallbackText for a successful turn. It is stored only when the CLI did
  // not stream any assistant text, matching the renderer's live fallback rule.
  // Stopped/error turns omit it and append their own terminal note afterward.
  persist(fallbackText?: string): void {
    if (this.persisted) return
    this.persisted = true

    const hasAssistantText = this.entries.some(
      (entry) => entry.kind === "assistant" && entry.content.length > 0
    )
    if (!hasAssistantText && fallbackText !== undefined) {
      const last = this.entries.at(-1)
      if (last?.kind === "assistant" && last.toolCalls.length === 0) {
        last.content += fallbackText
      } else {
        this.entries.push({
          kind: "assistant",
          content: fallbackText,
          toolCalls: [],
        })
      }
    }

    for (const entry of this.entries) {
      if (entry.kind === "assistant") {
        this.append({
          conversationId: this.conversationId,
          role: "assistant",
          content: entry.content || null,
          toolCalls: entry.toolCalls.length > 0 ? entry.toolCalls : null,
        })
      } else {
        this.append({
          conversationId: this.conversationId,
          role: "tool",
          content: entry.result,
          toolCallId: entry.id,
          toolName: entry.name,
        })
      }
    }
  }
}
