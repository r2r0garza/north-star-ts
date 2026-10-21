import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"
import { createConversation } from "../db/repositories/conversations"
import {
  openSteering,
  queueSteering,
  cancelSteering,
  consumeSteering,
  steeringState,
} from "./steering"
let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))
const available = sqliteLoadsForTests()
beforeEach(() => {
  if (available) {
    db = new Database(":memory:")
    runMigrations(db)
  }
})
describe.skipIf(!available)("steering queue", () => {
  it("preserves order, deduplicates retries and conditionally cancels", () => {
    const { id } = createConversation({ mode: "chat" })
    const close = openSteering(id, "run", () => {})
    const input = (key: string) => ({
      id: key,
      message: key,
      attachments: [],
      skills: [],
    })
    queueSteering(id, "run", input("first"))
    queueSteering(id, "run", input("first"))
    queueSteering(id, "run", input("second"))
    queueSteering(id, "run", input("third"))
    cancelSteering(id, "second")
    const delivered: string[] = []
    consumeSteering(id, (message) => delivered.push(message.id))
    expect(delivered).toEqual(["first", "third"])
    expect(
      consumeSteering(id, () => {
        throw new Error("duplicate")
      })
    ).toBe(false)
    expect(cancelSteering(id, "first").messages).toEqual([])
    close()
  })
  it("returns pending messages on stop and never delivers them to a later run", () => {
    const { id } = createConversation({ mode: "chat" })
    const close = openSteering(id, "old", () => {})
    const input = {
      id: "pending",
      message: "Keep this",
      attachments: ["/tmp/file"],
      skills: [],
    }
    queueSteering(id, "old", input)
    close()
    expect(steeringState(id).messages[0]).toMatchObject({
      status: "returned",
      ...input,
    })
    const closeNext = openSteering(id, "new", () => {})
    expect(() => queueSteering(id, "old", { ...input, id: "late" })).toThrow(
      "no longer running"
    )
    expect(
      consumeSteering(id, () => {
        throw new Error("wrong run")
      })
    ).toBe(false)
    closeNext()
  })
})
