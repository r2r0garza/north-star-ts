import { beforeEach, describe, expect, it, vi } from "vitest"

const { deleteConversation, deleteConversations, deletePlanFiles } = vi.hoisted(
  () => ({
    deleteConversation: vi.fn(),
    deleteConversations: vi.fn(),
    deletePlanFiles: vi.fn(async () => ({ removed: 0, failed: 0 })),
  })
)

vi.mock("../db/repositories/conversations", () => ({
  deleteConversation,
  deleteConversations,
}))
vi.mock("../agent/tools/plan-file", () => ({ deletePlanFiles }))

import {
  cleanupConversationArtifacts,
  deleteConversationWithArtifacts,
  deleteConversationsWithArtifacts,
} from "./lifecycle"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("conversation lifecycle", () => {
  it("deletes database state before awaiting one conversation's artifacts", async () => {
    const order: string[] = []
    deleteConversation.mockImplementation(() => order.push("db"))
    deletePlanFiles.mockImplementation(async () => {
      order.push("files")
      return { removed: 1, failed: 0 }
    })

    await deleteConversationWithArtifacts("conversation-1")

    expect(order).toEqual(["db", "files"])
    expect(deletePlanFiles).toHaveBeenCalledWith(["conversation-1"])
  })

  it("deduplicates batch deletion IDs for database and artifact cleanup", async () => {
    await deleteConversationsWithArtifacts(["worker", "worker", "source"])

    expect(deleteConversations).toHaveBeenCalledWith(["worker", "source"])
    expect(deletePlanFiles).toHaveBeenCalledWith(["worker", "source"])
  })

  it("cleans artifacts after a caller-owned database transaction", async () => {
    await cleanupConversationArtifacts(["reviewer"])
    expect(deletePlanFiles).toHaveBeenCalledWith(["reviewer"])
  })
})
