import { listTasks } from "../../db/repositories/tasks"
import { getConversationSummary } from "../../db/repositories/conversation-summaries"
import { readGitBranch } from "../../index/metadata"
import { resolveModelLabel } from "../providers"
import type { LlmSelection } from "../providers"
import type { ContextSection } from "./context-builder"
import { SECTION_PRIORITY } from "./context-builder"
import type { BrowserState } from "../../browser/manager"
import type { SessionStatus } from "../../electron-apps/manager"

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

// Automatic-memory guidance, emitted only when memory skills are actually in
// the catalog (memory on, and not filtered out by an agent's skill policy).
// Fixed text: it sits in the cached system prompt, so it must not vary turn to
// turn — what memory holds lives in the memory-* skills, read on demand.
export function memorySection(): ContextSection {
  return {
    name: "memory",
    priority: SECTION_PRIORITY.skills,
    content: [
      "## Memory",
      "Automatic memory is on. A background service extracts durable facts from each finished turn and keeps them in the memory-* skills listed in the skill catalog:",
      "- memory-identity and memory-preferences: who the user is and how they like to work. Shared across workspaces.",
      "- memory-knowledge and memory-lessons: facts, conventions, decisions, and past failures for the current workspace.",
      "- memory-recent: summaries of recent sessions; its reference/ folder holds the raw turns.",
      "",
      "Check memory before acting whenever earlier context could change what you do: the user's preferences or constraints, project conventions or decisions, gotchas hit before, or anything the user refers back to (\"last time\", \"as I said\", \"do you remember\"). Read the relevant skill with read_skill; skip one whose description says it is empty. Where workspace memory and global memory conflict, workspace memory wins.",
      "",
      "Memory records what was true when it was written. Before relying on a remembered file, function, command, or setting, check that it still exists, and trust what you observe now over what memory says.",
      "",
      "You never write memory yourself: don't edit the memory files or keep notes for later sessions (those writes are refused). When the user asks you to remember something, corrects a remembered fact, or you learn something durable, state it plainly in your reply; the service records it after the turn.",
    ].join("\n"),
    provenance: {
      trust: "system",
      channel: "runtime",
      source: "memory_guidance",
    },
  }
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
export function browserStateSection(
  state: BrowserState | null
): ContextSection {
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

// Live Electron app sessions (plan 119), so a closed or crashed app is never
// described as running from history. Host-derived fields only: window titles
// and URLs are app content and stay in tool results.
export function electronStateSection(sessions: SessionStatus[]): ContextSection {
  const lines = sessions.map(
    (s) =>
      `- ${s.sessionId}: ${s.state}, entry ${s.entry}, ${s.windows.length} window(s)`
  )
  return {
    name: "electron_state",
    priority: SECTION_PRIORITY.electronState,
    content:
      "## Electron app sessions\n" +
      (lines.length
        ? "Authoritative current state of the apps this conversation launched:\n" +
          lines.join("\n")
        : "No Electron app launched by this conversation is running. If the history mentions one, it has since ended.") +
      "\nTo run or verify a workspace Electron app, use the electron_* tools, not Electron/Playwright scripts via exec_command. Build it first if needed, then electron_launch. Explore with electron_snapshot/electron_interact; once the behavior is known, encode it as an electron_run check (a workspace .json file can be rerun). Use electron_handoff for native dialogs, menus or sign-in. Packaged apps are unsupported. Close apps you no longer need.",
    provenance: { trust: "system", channel: "runtime", source: "electron_state" },
  }
}

// The rolling conversation summary (plan 019): a compact digest of the turns that
// have scrolled (or are scrolling) out of the ContextBuilder's recent-message
// walk-back, so a long conversation keeps its early thread (decisions,
// constraints, open threads). Generated out of band by the `summarize` task and
// read here each turn. Highest priority of the built-in sections — dropping it
// under budget pressure loses context the conversation can't otherwise recover.
// The summary replaces stored messages through `coversThrough`, declared via
// `replacesHistoryThrough`: the context builder never drops such a section and
// appends every later message verbatim, so there is no overlap or gap.
// Returns null when no summary exists yet.
export function summarySection(conversationId: string): ContextSection | null {
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
    replacesHistoryThrough: record.coversThrough,
    provenance: {
      trust: "untrusted_data",
      channel: "memory",
      source: "conversation_summary",
      persisted: true,
    },
  }
}

// Dynamic per-turn environment orientation (mirrors the "# Environment" / git
// blocks a coding harness bakes in, but assembled fresh each turn from what's
// actually true). Composes only the parts that apply, so nothing here is a
// stale snapshot or a claim about a capability the session lacks:
//   - date + model: always (model omitted if it can't be resolved).
//   - platform + workspace line: only when a workspace path is present — platform
//     matters only when the agent can run commands, which chat can't.
//   - git branch: only when the workspace is a git repo (readGitBranch reads
//     .git/HEAD and returns null otherwise).
// No time, git status or recent commits: this lands in the system prompt, and a
// line that changes every turn (or every edit) invalidates the provider's prompt
// cache and replayable thinking for the whole history. The agent can run git
// itself when it needs the live state.
// Date is always present so this never returns null in practice; the `| null`
// return keeps it uniform with the other section renderers. Async because
// readGitBranch reads from disk — render it before ContextBuilder.build(), which
// takes pre-rendered sections.
export async function environmentSection(opts: {
  workspacePath?: string
  llmSelection?: LlmSelection
  now?: Date
}): Promise<ContextSection | null> {
  const lines: string[] = []

  const now = opts.now ?? new Date()
  lines.push(`- Date: ${now.toLocaleDateString()}`)

  const model = resolveModelLabel(opts.llmSelection)
  if (model) lines.push(`- Model: ${model}`)

  if (opts.workspacePath) {
    lines.push(`- Platform: ${process.platform}`)
    lines.push(`- Workspace: ${opts.workspacePath}`)

    // Branch only — readGitBranch is the zero-dependency repo check.
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
