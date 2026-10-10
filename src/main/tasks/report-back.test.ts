import { beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"
import type { TaskEventListener, TaskRunner } from "./runner"

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))
const { report } = vi.hoisted(() => ({ report: vi.fn() }))
vi.mock("../agent", () => ({ runCompletionReport: report }))
import { TaskReportBack } from "./report-back"
import { createConversation } from "../db/repositories/conversations"
import { createTask } from "../db/repositories/tasks"
import { appendEvent, listEvents } from "../db/repositories/task-events"
import { listMessages } from "../db/repositories/messages"

const sqliteLoads = sqliteLoadsForTests()
beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
  report
    .mockReset()
    .mockResolvedValue({ content: "Finished updating settings." })
})
function setup(status: "completed" | "failed" = "completed") {
  const source = createConversation({ mode: "chat" })
  const worker = createConversation({ mode: "chat" })
  const task = createTask({
    conversationId: worker.id,
    sourceConversationId: source.id,
    status,
    input: { kind: "todo_run", handoffVersion: 1, message: "Update settings" },
  })
  appendEvent({
    taskId: task.id,
    type: status === "completed" ? "task_completed" : "task_failed",
  })
  let listener!: TaskEventListener
  const runner = {
    subscribe: (fn: TaskEventListener) => {
      listener = fn
      return () => {}
    },
  } as TaskRunner
  const notified = vi.fn()
  const service = new TaskReportBack(runner, notified)
  return {
    source,
    task,
    service,
    notified,
    event: () => listener(task.id, { type: "task_completed" }, 1),
  }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 10))

describe.skipIf(!sqliteLoads)("background report-back", () => {
  it("recovers undelivered completion on startup and deduplicates live events and restarts", async () => {
    const s = setup()
    s.service.start()
    s.event()
    await flush()
    expect(report).toHaveBeenCalledTimes(1)
    expect(report.mock.calls[0][0]).toBe(s.source.id)
    expect(s.notified).toHaveBeenCalledWith(s.source.id)
    expect(
      listEvents(s.task.id).some(
        (event) => event.type === "completion_reported"
      )
    ).toBe(true)
    s.service.start()
    await flush()
    expect(report).toHaveBeenCalledTimes(1)
  })
  it("reports worker failure without a valid handoff rather than forwarding raw output", async () => {
    const s = setup("failed")
    s.service.start()
    await flush()
    expect(report.mock.calls[0][1]).toContain('"handoff":null')
    expect(report.mock.calls[0][1]).toContain('"executionStatus":"failed"')
  })
  it("leaves a persistent fallback if reporting is unavailable", async () => {
    report.mockResolvedValue({ error: "Provider unavailable" })
    const s = setup()
    s.service.start()
    await flush()
    expect(report.mock.calls[0][2]).toContain("couldn't generate")
    expect(s.notified).toHaveBeenCalledOnce()
  })
  it("does not start reports after shutdown", async () => {
    const s = setup()
    s.service.stop()
    s.service.start()
    await flush()
    expect(report).not.toHaveBeenCalled()
  })
})
