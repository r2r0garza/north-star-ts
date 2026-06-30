import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Todo } from "../../db/types"
import type { GateOutcome, ToolAction } from "../approval/types"

// Mock the todos repo so the tool test runs without a database.
const listTodos = vi.fn<(c: string) => Todo[]>()
vi.mock("../../db/repositories/todos", () => ({
  listTodos: (c: string) => listTodos(c),
}))

import { runTodosInBackgroundTool } from "./run_todos_in_background"
import type { EnqueueTask, ToolContext } from "./types"

function todo(itemId: string, status: Todo["status"], content = itemId): Todo {
  return { conversationId: "conv-1", itemId, seq: 0, content, status, createdAt: 0, updatedAt: 0 }
}

// A ToolContext with a gate that returns a fixed outcome and a spy enqueueTask.
function makeCtx(opts: {
  gateOutcome?: GateOutcome
  noGate?: boolean
  noEnqueue?: boolean
}): { ctx: ToolContext; enqueue: ReturnType<typeof vi.fn>; gateCalls: ToolAction[] } {
  const gateCalls: ToolAction[] = []
  const enqueue = vi.fn<EnqueueTask>(() => ({ id: "task-1", status: "queued" }))
  const ctx: ToolContext = {
    workspace: "",
    conversationId: "conv-1",
    gate: opts.noGate
      ? undefined
      : async (action) => {
          gateCalls.push(action)
          return opts.gateOutcome ?? "approved"
        },
    enqueueTask: opts.noEnqueue ? undefined : (enqueue as unknown as EnqueueTask),
  }
  return { ctx, enqueue, gateCalls }
}

beforeEach(() => {
  listTodos.mockReset()
})

describe("run_todos_in_background", () => {
  it("fails closed without a conversation", async () => {
    const result = await runTodosInBackgroundTool.execute({}, { workspace: "" })
    expect(result).toContain("ERROR[no_conversation]")
  })

  it("reports unavailable when no enqueueTask is wired", async () => {
    listTodos.mockReturnValue([todo("a", "pending")])
    const { ctx } = makeCtx({ noEnqueue: true })
    const result = await runTodosInBackgroundTool.execute({}, ctx)
    expect(result).toContain("ERROR[unavailable]")
  })

  it("errors (and never gates) when there are no actionable todos", async () => {
    listTodos.mockReturnValue([todo("a", "completed"), todo("b", "cancelled")])
    const { ctx, enqueue, gateCalls } = makeCtx({ gateOutcome: "approved" })
    const result = await runTodosInBackgroundTool.execute({}, ctx)
    expect(result).toContain("ERROR[no_todos]")
    expect(gateCalls).toHaveLength(0)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("gates the delegation and enqueues a todo_run task on approval", async () => {
    listTodos.mockReturnValue([
      todo("a", "completed", "done item"),
      todo("b", "pending", "todo item"),
      todo("c", "in_progress", "wip item"),
    ])
    const { ctx, enqueue, gateCalls } = makeCtx({ gateOutcome: "approved" })
    const result = await runTodosInBackgroundTool.execute({}, ctx)

    // The gated action describes the delegation, not the list.
    expect(gateCalls).toHaveLength(1)
    expect(gateCalls[0]).toMatchObject({ kind: "delegate", identity: "delegate:conv-1" })

    // Enqueued once with kind todo_run and the FULL snapshot (completed included).
    expect(enqueue).toHaveBeenCalledTimes(1)
    const input = enqueue.mock.calls[0][0]
    expect(input).toMatchObject({ conversationId: "conv-1", kind: "todo_run" })
    expect(input.seedTodos).toEqual([
      { itemId: "a", content: "done item", status: "completed" },
      { itemId: "b", content: "todo item", status: "pending" },
      { itemId: "c", content: "wip item", status: "in_progress" },
    ])

    const parsed = JSON.parse(result)
    expect(parsed.taskId).toBe("task-1")
    expect(parsed.handedOff).toBe(2) // pending + in_progress
  })

  it("does not enqueue when the user denies the delegation", async () => {
    listTodos.mockReturnValue([todo("a", "pending")])
    const { ctx, enqueue } = makeCtx({ gateOutcome: "denied" })
    const result = await runTodosInBackgroundTool.execute({}, ctx)
    expect(result).toContain("ERROR[denied]")
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("fails closed (no enqueue) when no gate is wired", async () => {
    listTodos.mockReturnValue([todo("a", "pending")])
    const { ctx, enqueue } = makeCtx({ noGate: true })
    const result = await runTodosInBackgroundTool.execute({}, ctx)
    expect(result).toContain("ERROR[denied]")
    expect(enqueue).not.toHaveBeenCalled()
  })
})
