import { listTasks } from "../../db/repositories/tasks"
import { listRules } from "../../db/repositories/action-allowlist"
import { listApprovals } from "../../db/repositories/approvals"
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
export function taskStateSection(
  conversationId: string
): ContextSection | null {
  const ACTIVE = new Set([
    "queued",
    "running",
    "waiting_for_approval",
    "paused",
    "interrupted",
  ])
  const tasks = listTasks({ sourceConversationId: conversationId }).filter(
    (t) => ACTIVE.has(t.status)
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

// Prior approval context (plan 021): what the user has already GRANTED or DECIDED,
// so the agent doesn't re-request an action that's already allowlisted or retry
// one the user denied. Two independent halves — both advisory, neither bypasses
// the live gate (a still-`pending` decision is shown as pending, not granted):
//   1. Durable "always allow" rules in scope (action_allowlist). Not task-scoped,
//      so meaningful on any non-chat turn. Needs a workspace to resolve scope.
//   2. This task's recent/pending gate decisions (approvals) — only when the turn
//      belongs to a durable task (taskId present). Absent on the live chat path.
// Returns null when neither half has anything (no empty block).
export function approvalsSection(opts: {
  conversationId: string
  workspacePath?: string
  taskId?: string
}): ContextSection | null {
  const blocks: string[] = []

  // Allowlist half. Dedup by (kind, identity, scope) — the table can hold several
  // rows for one identity at different scopes; the agent only needs to know it's
  // allowed, once. Cap like taskStateSection.
  const rules = listRules({
    workspacePath: opts.workspacePath ?? null,
    conversationId: opts.conversationId,
  })
  if (rules.length > 0) {
    const seen = new Set<string>()
    const ruleLines: string[] = []
    for (const r of rules) {
      const key = `${r.kind} ${r.identity} ${r.scope}`
      if (seen.has(key)) continue
      seen.add(key)
      ruleLines.push(`- ${r.kind} ${r.identity} [${r.scope}]`)
      if (ruleLines.length >= 10) break
    }
    blocks.push(
      "You've already been granted these — don't re-ask to run them:\n" +
        ruleLines.join("\n")
    )
  }

  // Task-approval half. The `request` blob is what the runner dual-wrote:
  // { tool, summary, reason, requestId, toolCallId } (plan 012).
  if (opts.taskId) {
    const approvals = listApprovals({ taskId: opts.taskId }).slice(0, 10)
    const decisionLines = approvals.map((a) => {
      const req = (a.request ?? {}) as { summary?: string; tool?: string }
      const label = req.summary ?? req.tool ?? "an action"
      if (a.status === "pending") {
        return `- still awaiting your decision (NOT yet granted): ${label}`
      }
      return `- ${a.status}: ${label}`
    })
    if (decisionLines.length > 0) {
      blocks.push(
        "Decisions already made for this task (don't re-request approved ones; don't retry denied ones):\n" +
          decisionLines.join("\n")
      )
    }
  }

  if (blocks.length === 0) return null
  const content = "## Prior approvals\n" + blocks.join("\n\n")
  return { name: "approvals", priority: SECTION_PRIORITY.approvals, content }
}
