import type { Todo, TodoStatus } from "../db/types"

// Shared shape of a `todo_run` handoff (plan 016), used by BOTH entry points —
// the agent tool (run_todos_in_background) and the user button
// (task:start-todos) — so the kickoff message, title, and seed snapshot stay
// identical no matter who triggered it. Both converge on TaskRunner.enqueue.

// The fixed first user turn of the forked worker conversation: work the seeded
// list to completion.
export const TODO_RUN_KICKOFF =
  "Work through your task list to completion. Do each pending item in order, " +
  "marking it in_progress when you start and completed as soon as it's done " +
  "(use the todo_write tool). When every item is completed, summarize what you did."

// Items that still represent work to do.
export function actionableTodos(todos: Todo[]): Todo[] {
  return todos.filter(
    (t) => t.status === "pending" || t.status === "in_progress"
  )
}

// A short task title from the actionable count + the first item's text.
export function todoRunTitle(actionable: Todo[]): string {
  const n = actionable.length
  const first = actionable[0]?.content ?? ""
  return `${n} task${n === 1 ? "" : "s"}: ${first.slice(0, 50)}`
}

// Title for a FINISHED inline todo list recorded into History (plan: inline
// task history). Uses the total count + first item's text — mirrors
// todoRunTitle's shape but counts the whole finished list, not just actionable
// items (there are none left once finished).
export function finishedTodoTitle(todos: Todo[]): string {
  const n = todos.length
  const first = todos[0]?.content ?? ""
  return `${n} task${n === 1 ? "" : "s"}: ${first.slice(0, 50)}`
}

// The seed snapshot enqueue expects — the FULL list (completed items included,
// so the background agent never re-does them), mapped to the seedTodos shape.
export function todoSeed(
  todos: Todo[]
): Array<{ itemId: string; content: string; status: TodoStatus }> {
  return todos.map((t) => ({
    itemId: t.itemId,
    content: t.content,
    status: t.status,
  }))
}
