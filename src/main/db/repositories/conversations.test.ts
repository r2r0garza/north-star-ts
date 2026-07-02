import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import {
  createConversation,
  getConversation,
  updateConversation,
} from "./conversations"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)(
  "conversations — per-conversation LLM selection",
  () => {
    it("defaults a new conversation's account/model to null (inherit default)", () => {
      const c = createConversation({ mode: "chat" })
      expect(c.accountId).toBeNull()
      expect(c.modelId).toBeNull()
    })

    it("persists an explicit selection at create time", () => {
      const c = createConversation({
        mode: "chat",
        accountId: "acc-1",
        modelId: "model-x",
      })
      expect(getConversation(c.id)?.accountId).toBe("acc-1")
      expect(getConversation(c.id)?.modelId).toBe("model-x")
    })

    it("updates the selection and can clear it back to null", () => {
      const c = createConversation({ mode: "north_star" })
      updateConversation(c.id, { accountId: "acc-2", modelId: "model-y" })
      expect(getConversation(c.id)?.modelId).toBe("model-y")
      updateConversation(c.id, { accountId: null, modelId: null })
      expect(getConversation(c.id)?.accountId).toBeNull()
      expect(getConversation(c.id)?.modelId).toBeNull()
    })

    it("leaves the selection untouched when updating only the title", () => {
      const c = createConversation({
        mode: "chat",
        accountId: "acc-1",
        modelId: "model-x",
      })
      updateConversation(c.id, { title: "Renamed" })
      const updated = getConversation(c.id)!
      expect(updated.title).toBe("Renamed")
      expect(updated.accountId).toBe("acc-1")
      expect(updated.modelId).toBe("model-x")
    })
  }
)
