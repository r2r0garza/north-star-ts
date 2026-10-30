import type { Message, Todo, TodoStatus } from "../db/types"

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

// Whether `history` (the messages about to be sent) holds a successful
// todo_write result. Each one carries the full list, so the latest is a
// complete copy and re-injecting the list into the system prompt is redundant.
// shortcut: assumes tool results are sent verbatim; revisit when in-turn
// compaction (plan 118) starts clearing old tool-result bodies.
export function todoListInHistory(history: Message[]): boolean {
  return history.some((m) => {
    if (m.role !== "tool" || m.toolName !== "todo_write") return false
    try {
      return Array.isArray(JSON.parse(m.content ?? "").todos)
    } catch {
      return false
    }
  })
}
