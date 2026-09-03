import { describe, it, expect, vi } from "vitest"
import {
  conversationReadTool,
  conversationSearchTool,
  conversationTreeSearchTool,
} from "./conversation_recall_tools"

vi.mock("../../db/repositories/conversation-recall", () => ({
  conversationSearch: vi.fn(() => [{ seq: 1, snippet: "[needle]" }]),
  conversationRead: vi.fn(() => [
    { seq: 1, role: "user", content: "hello", createdAt: 0 },
  ]),
  conversationTreeSearch: vi.fn(() => [
    { source: "subagent", seq: 2, snippet: "[needle]" },
  ]),
}))

describe("conversation recall tools", () => {
  it("requires server-owned conversation context", async () => {
    const result = await conversationSearchTool.execute(
      { query: "needle" },
      { workspace: "" }
    )
    expect(result).toContain("ERROR[no_conversation]")
  })

  it("searches current conversation without accepting a conversation id", async () => {
    const result = await conversationSearchTool.execute(
      { query: "needle", conversation_id: "other" },
      { workspace: "", conversationId: "current" }
    )
    const parsed = JSON.parse(result)
    expect(parsed.scope).toBe("conversation")
    expect(parsed.provenance).toMatchObject({
      trust: "untrusted_data",
      channel: "recall",
      persisted: true,
    })
  })

  it("reads current conversation messages", async () => {
    const result = await conversationReadTool.execute(
      { start_seq: 1, end_seq: 3 },
      { workspace: "", conversationId: "current" }
    )
    expect(JSON.parse(result).messages[0]).toMatchObject({
      seq: 1,
      role: "user",
      content: "hello",
    })
  })

  it("searches the authorized conversation tree", async () => {
    const result = await conversationTreeSearchTool.execute(
      { query: "needle", include_tasks: false },
      { workspace: "", conversationId: "current" }
    )
    expect(JSON.parse(result).scope).toBe("conversation_tree")
  })
})
