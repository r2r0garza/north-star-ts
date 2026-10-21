import type { Todo, TodoStatus } from "../db/types"

// Compact status markers for the re-injected list, so the model sees progress
// at a glance without re-doing finished work.
const MARKERS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  cancelled: "[~]",
}

// Render the conversation's task list for injection into the system prompt each
// turn. Returns null when empty so the caller appends nothing. The full list is
// shown (with markers) so the model knows what's done and what's left; this is
// what lets a multi-step plan survive context compression.
export function buildTodoListPrompt(todos: Todo[]): string | null {
  if (todos.length === 0) return null
  const lines = todos.map(
    (t) => `${MARKERS[t.status] ?? "[?]"} ${t.itemId}. ${t.content}`
  )
  return [
    "## Current task list",
    "",
    "This is your task list for this conversation (preserved across turns and " +
      "context compression). Keep it current with the todo_write tool. Do not " +
      "re-do items already marked completed. Revise this list rather than " +
      "starting a new one, mark an item completed only when its whole scope is " +
      "done and verified, and do not end your turn while items you can still do " +
      "remain open.",
    "",
    ...lines,
  ].join("\n")
}
