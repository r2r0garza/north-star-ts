import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import type { ToolAction } from "../approval/types"
import { toolError } from "./output"
import { listTodos } from "../../db/repositories/todos"
import {
  TODO_RUN_KICKOFF,
  actionableTodos,
  todoRunTitle,
  todoSeed,
} from "../../tasks/todo-run"

// Hand the remaining work off to a durable background task. The agent builds a
// plan with todo_write, then calls this to run the whole list in the background
// while it (and the user) move on. This is a DEDICATED tool, separate from
// todo_write: building the list and dispatching it are different operations, and
// keeping them apart gives the approval gate a clean action to inspect.
//
// The DELEGATION itself is gated — handing execution to the background is the
// approved action (not the list). The tool routes a `delegate` ToolAction through
// ctx.gate, which pauses the turn and prompts the user; only on approval does it
// enqueue. Once enqueued, the TaskRunner owns execution, and any gated actions
// the task hits while working the list follow the normal background-task approval
// flow.
export const runTodosInBackgroundTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "run_todos_in_background",
      description:
        "Hand your current task list off to a background task that works through " +
        "every item to completion, so you don't have to do it inline. Use this once " +
        "you've built a plan with todo_write AND the remaining work is long-running " +
        "(several steps / minutes). Calling this PAUSES for the user to approve the " +
        "handoff — you cannot start a background task without their approval. After " +
        "it's approved, briefly tell the user you've handed the work off to the " +
        "background and why. If they deny it, keep working inline instead. Takes no " +
        "arguments — it runs the current conversation's task list.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  execute: async (_args: Record<string, unknown>, ctx: ToolContext) => {
    const conversationId = ctx.conversationId
    if (!conversationId) {
      return toolError(
        "no_conversation",
        "Background tasks need a conversation, which isn't available here."
      )
    }
    if (!ctx.enqueueTask) {
      return toolError(
        "unavailable",
        "Handing work to the background isn't available in this context."
      )
    }

    // Snapshot the current list. Only pending/in_progress items are work left to
    // do — if there's nothing actionable, there's nothing to delegate.
    const todos = listTodos(conversationId)
    const actionable = actionableTodos(todos)
    if (actionable.length === 0) {
      return toolError(
        "no_todos",
        "There are no pending tasks to run. Build a task list with todo_write first."
      )
    }

    // Gate the delegation. This is the approved action — handing execution to the
    // background — not the list itself. Pauses the turn until the user decides.
    // Fail-closed if no gate is wired (matches every other gated tool).
    const action: ToolAction = {
      tool: "run_todos_in_background",
      kind: "delegate",
      summary: `Run ${actionable.length} task${actionable.length === 1 ? "" : "s"} in the background`,
      identity: `delegate:${conversationId}`,
      detail: { count: actionable.length },
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked") {
      return toolError(
        "blocked",
        "Starting a background task is not permitted here."
      )
    }
    if (outcome === "denied") {
      return toolError(
        "denied",
        "The user declined to run this in the background. Continue the work inline."
      )
    }

    // Seed the full list (not just actionable items) into the forked worker
    // conversation so the background agent sees completed items too and never
    // re-does them. enqueue creates a private worker conversation with an empty
    // todos table; the runner seeds it from this snapshot.
    const task = ctx.enqueueTask({
      conversationId,
      message: TODO_RUN_KICKOFF,
      kind: "todo_run",
      title: todoRunTitle(actionable),
      seedTodos: todoSeed(todos),
    })

    return JSON.stringify({
      taskId: task.id,
      status: task.status,
      handedOff: actionable.length,
      note:
        "Work is now running in the background. Tell the user you've handed it off " +
        "and roughly what it covers.",
    })
  },
}
