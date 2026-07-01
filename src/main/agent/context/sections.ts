import { listTasks } from "../../db/repositories/tasks"
import type { ContextSection } from "./context-builder"
import { SECTION_PRIORITY } from "./context-builder"

// Renderers for the ContextBuilder's droppable sections (plan 014). Each returns
// a ContextSection or null (omitted). The builder budgets + composes them; these
// just turn a data source into a compact prompt block. The skills/todos/index
// sections are built inline in runAgentLoop (they already have their strings);
// these cover the sources that need a DB read + formatting.

// Active background tasks spawned FROM this conversation (durable tasks run in
// their own forked worker conversation and link back via source_conversation_id).
// Surfaces them so the agent knows what's already running/queued and doesn't
// re-spawn duplicate work. Terminal tasks are omitted — this is "what's live",
// not history. Returns null when there are none.
export function taskStateSection(conversationId: string): ContextSection | null {
  const ACTIVE = new Set(["queued", "running", "waiting_for_approval", "paused", "interrupted"])
  const tasks = listTasks({ sourceConversationId: conversationId }).filter((t) =>
    ACTIVE.has(t.status)
  )
  if (tasks.length === 0) return null

  const lines = tasks
    .slice(0, 10)
    .map((t) => `- ${t.title ?? "Untitled task"} — ${t.status}`)
  const content =
    "## Background tasks\n" +
    "Tasks you have running in the background for this session (don't re-start these):\n" +
    lines.join("\n")
  return { name: "task_state", priority: SECTION_PRIORITY.taskState, content }
}
