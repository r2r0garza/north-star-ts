import { listTasks } from "../../db/repositories/tasks"
import { listRules } from "../../db/repositories/action-allowlist"
import { listApprovals } from "../../db/repositories/approvals"
import { getConversationSummary } from "../../db/repositories/conversation-summaries"
import { readGitBranch } from "../../index/metadata"
import { LocalEnvironment } from "../env/local"
import { resolveModelLabel } from "../providers"
import type { LlmSelection } from "../providers"
import type { ContextSection } from "./context-builder"
import { SECTION_PRIORITY } from "./context-builder"
import type { BrowserState } from "../../browser/manager"

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

// Live agent-browser state: what the conversation's browser tab is showing right
// now. The tab is shared between the user (who can navigate/close from the
// sidebar/pop-out chrome) and the agent (browser_navigate/browser_close) — both
// keyed by conversationId — so a page the USER opened is visible here too.
//
// ALWAYS emits a section when the browser is available this turn (the caller
// gates on that), stating one of two facts EXPLICITLY:
//   - a page is open → name the current URL/title.
//   - nothing is open → say so.
// This is deliberately never omitted: a page opened and then closed (by the user
// or browser_close), or a fresh app session where nothing is live, must produce
// an explicit "nothing is open" — otherwise the model has no current fact to
// consult and falls back to whatever page it last mentioned in the conversation
// (reporting a stale, already-closed page as if it were still open).
export function browserStateSection(state: BrowserState | null): ContextSection {
  if (!state) {
    return {
      name: "browser_state",
      priority: SECTION_PRIORITY.browserState,
      content:
        "## Agent browser\n" +
        "No page is currently open in the agent browser. If the conversation " +
        "history mentions a page, it has since been closed — do NOT report it as " +
        "open. This line is the authoritative current state. Call browser_navigate " +
        "to open a page.",
      provenance: {
        trust: "system",
        channel: "runtime",
        source: "browser_state",
      },
    }
  }
  const lines = [`- Current page: ${state.url}`]
  if (state.title && state.title !== state.url) {
    lines.push(`- Title: ${state.title}`)
  }
  if (state.loading) lines.push("- Status: still loading")
  const content =
    "## Agent browser\n" +
    "A browser tab is open for this conversation (the user may have opened it, " +
    "or a previous turn did). This line is the authoritative current state — use " +
    "browser_snapshot / browser_screenshot to read it, or browser_close if it's " +
    "no longer needed:\n" +
    lines.join("\n")
  return {
    name: "browser_state",
    priority: SECTION_PRIORITY.browserState,
    content,
    provenance: {
      trust: "system",
      channel: "runtime",
      source: "browser_state",
    },
  }
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

// The rolling conversation summary (plan 019): a compact digest of the turns that
// have scrolled (or are scrolling) out of the ContextBuilder's recent-message
// walk-back, so a long conversation keeps its early thread (decisions,
// constraints, open threads). Generated out of band by the `summarize` task and
// read here each turn. Highest priority of the built-in sections — dropping it
// under budget pressure loses context the conversation can't otherwise recover.
// The summary replaces stored messages through `coversThrough`; the context
// builder appends every later message verbatim, so there is no overlap or gap.
// Returns null when no summary exists yet.
export function summarySection(
  conversationId: string
): (ContextSection & { coversThrough: number }) | null {
  const record = getConversationSummary(conversationId)
  if (!record || record.summary.trim().length === 0) return null
  const content =
    "## Conversation summary so far\n" +
    "A rolling digest of earlier turns in this conversation (older messages may " +
    "have scrolled out of the window below). Treat it as background context, not " +
    "the latest word — the recent messages are authoritative where they differ.\n\n" +
    record.summary
  return {
    name: "summary",
    priority: SECTION_PRIORITY.summary,
    content,
    coversThrough: record.coversThrough,
    provenance: {
      trust: "untrusted_data",
      channel: "memory",
      source: "conversation_summary",
      persisted: true,
    },
  }
}

// Run a short git command in `cwd` and return its trimmed stdout, or null if it
// fails (non-zero exit, timeout, git missing). Uses the host environment's exec —
// the same spawn/capture path the shell tool uses — with a tight timeout and byte
// cap so gathering context can never hang or flood the prompt. Read-only git
// plumbing, so it runs directly here (not through the approval gate, which is for
// the agent's own tool calls).
async function runGit(cwd: string, args: string): Promise<string | null> {
  try {
    const env = new LocalEnvironment(cwd)
    const res = await env.exec(`git ${args}`, {
      cwd,
      timeoutMs: 3000,
      maxOutputBytes: 4096,
    })
    if (res.exitCode !== 0 || res.timedOut) return null
    return res.stdout.toString("utf8").trim()
  } catch {
    return null
  }
}

// Dynamic per-turn environment orientation (mirrors the "# Environment" / git
// blocks a coding harness bakes in, but assembled fresh each turn from what's
// actually true). Composes only the parts that apply, so nothing here is a
// stale snapshot or a claim about a capability the session lacks:
//   - date + time + model: always (model omitted if it can't be resolved).
//   - platform + workspace line: only when a workspace path is present — platform
//     matters only when the agent can run commands, which chat can't.
//   - git block (branch + short status + recent commits): only when the workspace
//     is a git repo (readGitBranch reads .git/HEAD and returns null otherwise),
//     and only the sub-lines whose git command succeeded.
// Date is always present so this never returns null in practice; the `| null`
// return keeps it uniform with the other section renderers. Async because git
// needs a shell — render it before ContextBuilder.build(), which takes
// pre-rendered sections.
export async function environmentSection(opts: {
  workspacePath?: string
  llmSelection?: LlmSelection
  now?: Date
}): Promise<ContextSection | null> {
  const lines: string[] = []

  const now = opts.now ?? new Date()
  lines.push(`- Date: ${now.toLocaleDateString()}`)
  lines.push(`- Time: ${now.toLocaleTimeString()}`)

  const model = resolveModelLabel(opts.llmSelection)
  if (model) lines.push(`- Model: ${model}`)

  if (opts.workspacePath) {
    lines.push(`- Platform: ${process.platform}`)
    lines.push(`- Workspace: ${opts.workspacePath}`)

    // Git block — only for a real repo. readGitBranch is the zero-dependency
    // repo check; when it resolves, layer on status + recent commits best-effort.
    const branch = await readGitBranch(opts.workspacePath)
    if (branch) {
      const v = branch.value as
        | { branch?: string; detached?: boolean; sha?: string }
        | undefined
      const branchLabel = v?.branch
        ? v.branch
        : v?.sha
          ? `detached at ${v.sha}`
          : "unknown"
      lines.push(`- Git branch: ${branchLabel}`)

      // Distinguish empty output (clean tree) from a failed command (null): only
      // claim "clean" when git actually succeeded and returned nothing.
      const status = await runGit(opts.workspacePath, "status --short")
      if (status !== null) {
        lines.push(
          status.length > 0 ? `- Git status:\n${status}` : "- Git status: clean"
        )
      }

      const log = await runGit(opts.workspacePath, "log -5 --oneline")
      if (log) lines.push(`- Recent commits:\n${log}`)
    }
  }

  const content =
    "## Environment\n" +
    "Live context for this turn (assembled fresh; not a fixed snapshot):\n" +
    lines.join("\n")
  return {
    name: "environment",
    priority: SECTION_PRIORITY.environment,
    content,
    provenance: {
      trust: "system",
      channel: "runtime",
      source: "environment",
    },
  }
}
