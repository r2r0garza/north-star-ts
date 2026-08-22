import { useCallback, useEffect, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import { toast } from "sonner"
import {
  ArrowUp,
  Bot,
  BrainCircuit,
  ChevronDown,
  ClipboardList,
  FileText,
  FolderOpen,
  GitBranch,
  MousePointerClick,
  Plus,
  Square,
  Workflow,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Markdown } from "@/components/markdown"
import { VIEW_TO_MODE, type View } from "@/components/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from "@/components/ui/message-scroller"
import { Message, MessageContent } from "@/components/ui/message"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Marker, MarkerIcon, MarkerContent } from "@/components/ui/marker"
import { Spinner } from "@/components/ui/spinner"
import {
  Attachment,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentActions,
  AttachmentAction,
} from "@/components/ui/attachment"
import { ToolGroup, ApprovalCard } from "@/components/tool-group"
import { ChangedFilesBar } from "@/components/changed-files-bar"
import { QuestionPanel } from "@/components/question-panel"
import {
  MentionMenu,
  rankSkills,
  type MentionItem,
} from "@/components/mention-menu"
import {
  activeMentionToken,
  segmentMessage,
  expandMentions,
  type MentionKind,
  type ConfirmedMentions,
} from "@/lib/mention-tokens"
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox"
import {
  buildTimeline,
  toToolUse,
  isErrorResult,
  baseName as lastSegment,
  type TimelineItem,
  type ToolUse,
  type ChangedFile,
} from "@/lib/timeline"
import { cn } from "@/lib/utils"
import { maybeNotify } from "@/lib/notify"
import type {
  Question,
  QuestionAnswer,
  LlmSettings,
  AccountWithModels,
  SkillSummary,
  AgentSummary,
  PickedElement,
} from "@/types"

// One ordered piece of an in-flight turn: a run of streamed assistant text, or a
// group of tool calls. Segments are appended in the order events arrive, so the
// live turn interleaves text and tools exactly as it happened (a preamble, its
// tools, the next preamble, its tools, …) — matching how buildTimeline lays out
// the settled transcript. This replaces the old flat {text, tools}, which
// rendered every tool first and all text after, regardless of real order.
type LiveSegment =
  | { kind: "text"; text: string }
  | { kind: "tools"; calls: ToolUse[] }

// The live, in-flight state of one streaming turn, held per-conversation in
// `liveTurns` until the turn settles and reconciles into the persisted timeline.
// A pending approval lives inside a tools segment (on the matching call's
// `approval`), so restoring a switched-away turn restores its approval card too.
interface LiveTurn {
  segments: LiveSegment[]
  question: { requestId: string; questions: Question[] } | null
}
const EMPTY_LIVE: LiveTurn = { segments: [], question: null }

// Append streamed assistant text. Extends the trailing text segment when the
// last event was also text (so a token stream coalesces), otherwise starts a new
// text segment after a tools group — which is what creates the interleaving.
function appendLiveText(turn: LiveTurn, delta: string): LiveTurn {
  const last = turn.segments[turn.segments.length - 1]
  if (last?.kind === "text") {
    return {
      ...turn,
      segments: [
        ...turn.segments.slice(0, -1),
        { kind: "text", text: last.text + delta },
      ],
    }
  }
  return {
    ...turn,
    segments: [...turn.segments, { kind: "text", text: delta }],
  }
}

// Register a started tool call. Appends to the trailing tools group when the last
// event was also a tool (back-to-back calls in one round group together, like
// buildTimeline groups an assistant message's calls), else opens a new group.
function addLiveToolStart(turn: LiveTurn, call: ToolUse): LiveTurn {
  const last = turn.segments[turn.segments.length - 1]
  if (last?.kind === "tools") {
    return {
      ...turn,
      segments: [
        ...turn.segments.slice(0, -1),
        { kind: "tools", calls: [...last.calls, call] },
      ],
    }
  }
  return {
    ...turn,
    segments: [...turn.segments, { kind: "tools", calls: [call] }],
  }
}

// Update a tool call by id wherever it lives (result/status/approval), leaving
// all other segments untouched.
function updateLiveTool(
  turn: LiveTurn,
  id: string,
  fn: (call: ToolUse) => ToolUse
): LiveTurn {
  return {
    ...turn,
    segments: turn.segments.map((seg) =>
      seg.kind === "tools"
        ? {
            ...seg,
            calls: seg.calls.map((c) => (c.id === id ? fn(c) : c)),
          }
        : seg
    ),
  }
}

// All tool calls across a turn's segments, flattened in order — for derivations
// that don't care about interleaving (pending-approval lookup, changed-files,
// the "any tools yet?" check).
function liveToolsOf(turn: LiveTurn | undefined): ToolUse[] {
  if (!turn) return []
  return turn.segments.flatMap((s) => (s.kind === "tools" ? s.calls : []))
}

// Append final/terminal text (error or stop note) to the turn. Reuses the text
// coalescing so it lands after whatever streamed, with a separating blank line
// when text already exists.
function appendLiveFinalText(turn: LiveTurn, note: string): LiveTurn {
  const hasText = turn.segments.some((s) => s.kind === "text" && s.text)
  return appendLiveText(turn, hasText ? `\n\n${note}` : note)
}

// Collapse whitespace and clip to a single-line preview for a desktop
// notification body (the OS truncates anyway; this keeps it tidy).
function snippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// True when a keystroke is landing in an editable field, so global single-key
// shortcuts should stand down (don't hijack typing). Mirrors the guard in
// theme-provider's hotkey (which is file-local there).
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

// Split a workspace-relative POSIX path (from the `@`-mention file list) into its
// basename and parent dir for two-line display in the menu.
function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}
function dirName(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? "" : path.slice(0, i)
}

// A short human label for a picked element's chip, e.g. `button "Sign up"` or
// `a#nav-tasks`. Prefers role + name; falls back to tag + selector.
function pickedElementLabel(el: PickedElement): string {
  if (el.role && el.name) return `${el.role} "${el.name}"`
  if (el.name) return `"${el.name}"`
  return el.selector || el.tag
}

// The descriptor prepended to the outgoing message when an element is picked, so
// the agent has the concrete details to locate/act on it.
function formatPickedElement(el: PickedElement): string {
  const parts = [`tag=${el.tag}`, `selector=${el.selector}`]
  if (el.role) parts.push(`role=${el.role}`)
  if (el.name) parts.push(`name=${JSON.stringify(el.name)}`)
  return `[User pointed at a browser element — ${parts.join(", ")}]`
}

export default function App({
  view,
  conversationId,
  pendingProjectId,
  onConversationCreated,
  onConversationChanged,
  onOpenSettings,
  settingsOpen,
  rightPanelOpen,
  onWorkspaceChange,
  onReviewChanges,
  onOpenHtml,
  onRanInBackground,
  onRunningConvosChange,
  onWaitingConvosChange,
}: {
  view: View
  conversationId: string | null
  // The project a fresh (uncreated) conversation will belong to. Its directory
  // (if any) is auto-adopted and locked for workspace views; project_id is
  // stamped on the conversation at create time. Null = unassigned ("No Project").
  pendingProjectId: string | null
  onConversationCreated: (id: string) => void
  onConversationChanged: () => void
  // Open the Settings sheet to a given tab (the composer's provider/model picker
  // routes here to configure an LLM).
  onOpenSettings: (tab?: string) => void
  // Whether Settings is open — when it closes we re-read the active provider so
  // the composer picker and Send gate reflect any change.
  settingsOpen: boolean
  // When the right-hand panel (Info / Browser) is open the composer toolbar is
  // squeezed: collapse folder + branch to icon-only and hide the model picker
  // (no icon available for it).
  rightPanelOpen: boolean
  // Report the active conversation's workspace root up to the Shell (the sidebar
  // Changes review + browser opens need it for git diffs and file:// URLs).
  onWorkspaceChange?: (workspace: string) => void
  // Open the sidebar Changes review scoped to a turn's changed files.
  onReviewChanges?: (files: ChangedFile[]) => void
  // Open an html changed-file in the sidebar agent browser.
  onOpenHtml?: (relPath: string) => void
  // Called after "Run in background" starts a durable task, so the Shell can
  // reveal the Workspace Activity panel where the new task appears.
  onRanInBackground?: () => void
  // Reports the set of conversations with a turn currently streaming, so the
  // Shell can show a spinner on each active row in the sidebar. A single App
  // instance owns this state, but the sidebar is a sibling — this lifts it up.
  onRunningConvosChange?: (ids: Set<string>) => void
  // Reports the set of conversations whose turn is BLOCKED waiting on the user —
  // a pending approval, a clarifying question, or a browser handoff (all surface
  // as approval/question events). Distinct from running: these need the user to
  // act, so the sidebar shows a "needs you" indicator instead of the spinner.
  onWaitingConvosChange?: (ids: Set<string>) => void
}) {
  // Chat runs without a workspace and attaches files instead; North Star and
  // Interactive are workspace-backed and share the same behavior.
  const isChat = view === "Chat"

  // The main agent's brand name (MAIN_AGENT_NAME, e.g. "North Star"), read once
  // from the synchronous system bridge. Used to label the per-view empty-session
  // heading — "<agent> - Chat", "<agent> - Interactive", "<agent> - Autonomous
  // Tasks" (the North Star tab's heading is dynamic with the agent name).
  const agentName = window.cowork.system().mainAgentName

  const [workspace, setWorkspace] = useState("")
  // Whether the workspace is locked to a project's directory (the conversation
  // belongs to — or is being started in — a project that has one). When true the
  // composer's folder picker is hidden: the directory always comes from the
  // project, not a per-conversation pick.
  const [lockedWorkspace, setLockedWorkspace] = useState(false)
  // Current git branch for the selected workspace folder, or null when not a
  // git repo (or no folder is selected). Shown as a small badge next to the
  // folder name in the Interactive / North Star composer.
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<string[]>([])
  const [message, setMessage] = useState("")
  // Agent mode: controls how the agent behaves on workspace views.
  //   "default" — normal operation, confirms gated actions with the user.
  //   "plan"    — read-only planning turn; agent writes a plan and presents it
  //               for approval before touching the workspace.
  //   "auto"    — like "default" but all gated actions are auto-approved (no
  //               confirmation prompts).
  // Session-only (NOT persisted) — resets on reload/restart. Cleared back to
  // "default" when a plan is approved (plan_mode event), but NOT cleared when
  // "auto" is activated (auto_mode event).
  type AgentMode = "default" | "plan" | "auto"
  const [agentMode, setAgentMode] = useState<AgentMode>("default")
  // Elements the user picked in the agent browser ("point at this button"). More
  // than one can accumulate — via the sticky picker button or Alt/Option+click on
  // a live page — so several can be sent in ONE turn. Held as pending chips above
  // the composer and prepended to the next message on Send, then cleared.
  const [pickedElements, setPickedElements] = useState<PickedElement[]>([])
  // Mention pickers: `/skill` steers the agent toward a skill, `@file` points it
  // at a workspace file. Both share one menu anchored to the textarea.
  //   - `skills` is the catalog (loaded once per workspace, filtered client-side).
  //   - `menu` = { kind, query } for the trigger token being typed (null = closed).
  //   - `menuActive` is the highlighted value; `fileItems` is the server-filtered
  //     file list for the current `@` query (files can be huge, so unlike skills
  //     they're filtered in the main process per keystroke).
  //   - `confirmedSkills` / `confirmedFiles` are the values the user actually
  //     picked — the source of truth for which tokens get a badge and get expanded
  //     at send. A typed-but-unpicked `/foo` or `@bar` stays plain text.
  const [skills, setSkills] = useState<SkillSummary[]>([])
  // User-invocable custom agents for the composer's agent picker, and this
  // conversation's selection. `selAgentName` is null for the built-in main agent
  // (default). Persisted onto the conversation row; for a not-yet-created
  // conversation it's carried into create() on first send. Mirrors selModelId.
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [selAgentName, setSelAgentName] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ kind: MentionKind; query: string } | null>(
    null
  )
  const [menuActive, setMenuActive] = useState<string | null>(null)
  const [fileItems, setFileItems] = useState<string[]>([])
  const [confirmedSkills, setConfirmedSkills] = useState<Set<string>>(new Set())
  const [confirmedFiles, setConfirmedFiles] = useState<Set<string>>(new Set())
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  // Guards async file-list responses: only the latest `@` query's result is
  // applied, so a slow walk for an earlier query can't clobber a newer one.
  const fileReqRef = useRef(0)
  // The persisted transcript, rebuilt from stored rows (text bubbles + tool
  // groups, interleaved in order). Live in-flight state is held separately.
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  // Conversations with a turn currently streaming in the main process. A single
  // App instance is shared across all conversations (only the `conversationId`
  // prop changes when you switch), so "loading" is derived per-conversation from
  // this set — switching away from a streaming turn no longer shows its spinner
  // (or its Stop button) on the conversation you switched to.
  const [runningConvos, setRunningConvos] = useState<Set<string>>(new Set())
  // The in-flight assistant turn for each streaming conversation: streamed text,
  // the tool calls as they run, and any pending approval/question. Keyed by
  // conversation — NOT a single shared buffer — so switching away from a turn
  // that's still streaming (or parked on an approval gate in the main process)
  // preserves its live state, and switching back restores it exactly. A single
  // App instance is shared across all conversations, so a shared buffer would be
  // wiped on switch: the returning conversation would show a perpetual "Thinking…"
  // spinner with no approval card and no way to send (the session-bleed bug).
  // Each entry is dropped when its turn settles (reconciled into `timeline`).
  const [liveTurns, setLiveTurns] = useState<Map<string, LiveTurn>>(new Map())
  // Surface the running set to the Shell (for the sidebar's per-row spinner)
  // whenever it changes.
  useEffect(() => {
    onRunningConvosChange?.(runningConvos)
  }, [runningConvos, onRunningConvosChange])
  // Derive the "waiting on the user" set from the live turns and surface it to
  // the Shell (for the sidebar's per-row "needs you" indicator). A conversation
  // is waiting when its turn is blocked on a pending approval or a question
  // (browser handoffs come through as questions). Recomputed whenever liveTurns
  // changes — the same map the approval/question events already update.
  useEffect(() => {
    const waiting = new Set<string>()
    for (const [id, turn] of liveTurns) {
      const blocked =
        turn.question !== null ||
        liveToolsOf(turn).some((t) => t.approval?.status === "pending")
      if (blocked) waiting.add(id)
    }
    onWaitingConvosChange?.(waiting)
  }, [liveTurns, onWaitingConvosChange])
  // Mutate one conversation's live turn immutably; seeds an empty turn if absent.
  const updateLive = useCallback(
    (convoId: string, fn: (prev: LiveTurn) => LiveTurn) => {
      setLiveTurns((prev) => {
        const next = new Map(prev)
        next.set(convoId, fn(prev.get(convoId) ?? EMPTY_LIVE))
        return next
      })
    },
    []
  )
  // Drop one conversation's live turn (its content has been reconciled into the
  // persisted transcript, or the turn is being restarted).
  const clearLive = useCallback((convoId: string) => {
    setLiveTurns((prev) => {
      if (!prev.has(convoId)) return prev
      const next = new Map(prev)
      next.delete(convoId)
      return next
    })
  }, [])

  // All providers + their models (for the composer's grouped picker) and the
  // default selection (the starting point for a fresh conversation). Reloaded
  // when Settings closes so changes there show immediately.
  const [accountsWithModels, setAccountsWithModels] = useState<
    AccountWithModels[]
  >([])
  const [defaultLlm, setDefaultLlm] = useState<LlmSettings | null>(null)
  // This conversation's selection (provider account + model gateway id). Persisted
  // onto the conversation row; for a not-yet-created conversation it's carried into
  // create() on first send. Null fields fall back to the default.
  const [selAccountId, setSelAccountId] = useState<string | null>(null)
  const [selModelId, setSelModelId] = useState<string | null>(null)

  const reloadLlm = useCallback(async () => {
    const [list, dflt] = await Promise.all([
      window.cowork.providers.listWithModels(),
      window.cowork.providers.getDefault(),
    ])
    setAccountsWithModels(list)
    setDefaultLlm(dflt)
  }, [])

  // Initial load + reload whenever Settings closes.
  useEffect(() => {
    if (!settingsOpen) void reloadLlm()
  }, [settingsOpen, reloadLlm])

  // The effective selection = the conversation's own pick, else the default.
  const effAccountId = selAccountId ?? defaultLlm?.activeAccountId ?? null
  const effModelId = selModelId ?? defaultLlm?.activeModelId ?? null
  const effectiveAccount = effAccountId
    ? accountsWithModels.find((a) => a.account.id === effAccountId)
    : null
  const effectiveModel = effectiveAccount?.models.find(
    (m) => m.modelId === effModelId
  )

  // The conversation the panel is currently showing. Updated synchronously when
  // the prop changes (in the load effect) so streaming callbacks can tell, at the
  // moment an event arrives, whether it belongs to the conversation on screen.
  const viewingRef = useRef<string | null>(conversationId)
  // A conversation just created by sendMessage and promoted to active mid-send.
  // Set so the load effect knows to skip its clear/reload for that one render —
  // App already holds the optimistic transcript and the live stream for it, and
  // nothing is persisted yet to load. Consumed (cleared) on the first effect run.
  const justCreatedRef = useRef<string | null>(null)
  // Whether the conversation currently on screen has a turn streaming. Derived
  // from runningConvos, NOT a standalone flag: a single App instance is shared
  // across conversations, so a per-conversation derivation is what stops one
  // conversation's spinner/Stop button from showing on another.
  const loading = conversationId !== null && runningConvos.has(conversationId)
  // A usable provider + model must be selected before any turn. Mirrors the
  // main-process resolveLlm gate (the backstop there returns the same error if a
  // stale selection slips through).
  const hasLlm = !!effAccountId && !!effModelId && !!effectiveModel
  const hasSelectableModels = accountsWithModels.some(
    (account) => account.models.length > 0
  )
  const hasEnabledProviders = accountsWithModels.length > 0
  // Chat needs only a message (a file is optional); the workspace views need a
  // selected folder as well. All views need an LLM selection.
  const canSend =
    !!message.trim() && !loading && hasLlm && (isChat || !!workspace.trim())

  // Subscribe to elements picked in the agent browser. Each pick APPENDS a chip
  // (sticky picker button, or Alt/Option+click on a live page), so several can be
  // sent in one turn. De-dupe on selector so re-picking the same element is a
  // no-op. Cleared on Send (prepended to the message) or via a chip's remove.
  useEffect(() => {
    return window.cowork.onBrowserElementPicked((element) => {
      setPickedElements((prev) =>
        prev.some((e) => e.selector === element.selector)
          ? prev
          : [...prev, element]
      )
    })
  }, [])

  // Load the active conversation when it changes. A null id is a fresh,
  // not-yet-created conversation: clear the panel. Otherwise reload its stored
  // messages and linked workspace (so reopening restores both).
  useEffect(() => {
    let cancelled = false
    viewingRef.current = conversationId
    // A conversation sendMessage just created and promoted mid-turn: App already
    // shows its optimistic transcript and is streaming its live turn, and nothing
    // is persisted yet to reload. Skip the clear+reload entirely (and consume the
    // flag) so we don't wipe the in-flight stream the user is watching.
    if (conversationId && justCreatedRef.current === conversationId) {
      justCreatedRef.current = null
      return
    }
    // A genuine switch to (or reset from) another conversation: agent mode is
    // session-only and per-conversation, so clear it. This runs AFTER the
    // just-created guard above, so promoting a fresh conversation mid-send (which
    // changes conversationId) does NOT clear the agent mode the turn was sent with.
    setAgentMode("default")
    // Switching to a different conversation no longer wipes any live state: each
    // streaming turn's text/tools/approval/question is held per-conversation in
    // `liveTurns` and rendered by looking up the id on screen. Leaving a turn that
    // is still streaming (or parked on an approval gate) and returning to it now
    // restores its live buffers — including the pending approval card — instead of
    // stranding it as a perpetual "Thinking…" spinner with no way to respond.
    if (!conversationId) {
      setTimeline([])
      setAttachments([])
      // A fresh conversation starts from the default selection (null = inherit).
      setSelAccountId(null)
      setSelModelId(null)
      // No custom agent by default (null = built-in main agent).
      setSelAgentName(null)
      // If starting in a project that has a directory, adopt + lock it; otherwise
      // clear the picker (unassigned / directory-less project).
      if (pendingProjectId) {
        void window.cowork.db.projects.get(pendingProjectId).then(async (p) => {
          if (cancelled) return
          if (p?.workspaceId) {
            const ws = await window.cowork.db.workspaces.list()
            const match = ws.find((w) => w.id === p.workspaceId)
            if (cancelled) return
            setWorkspace(match?.path ?? "")
            setLockedWorkspace(!!match)
          } else {
            setWorkspace("")
            setLockedWorkspace(false)
          }
        })
      } else {
        setWorkspace("")
        setLockedWorkspace(false)
      }
      return
    }
    Promise.all([
      window.cowork.db.messages.list(conversationId),
      window.cowork.db.conversations.get(conversationId),
    ]).then(async ([rows, convo]) => {
      if (cancelled) return
      setTimeline(buildTimeline(rows))
      setAttachments([])
      // Restore the conversation's own model selection (null falls back to default).
      setSelAccountId(convo?.accountId ?? null)
      setSelModelId(convo?.modelId ?? null)
      // Restore the conversation's selected custom agent (null = main agent).
      setSelAgentName(convo?.agentName ?? null)
      // If the conversation belongs to a project with a directory, that directory
      // is the source of truth and the picker is locked. Otherwise fall back to
      // the conversation's own workspace_id (legacy / unassigned).
      let locked = false
      if (convo?.projectId) {
        const project = await window.cowork.db.projects.get(convo.projectId)
        if (cancelled) return
        if (project?.workspaceId) {
          const ws = await window.cowork.db.workspaces.list()
          const match = ws.find((w) => w.id === project.workspaceId)
          if (cancelled) return
          setWorkspace(match?.path ?? "")
          locked = !!match
        }
      }
      setLockedWorkspace(locked)
      if (!locked) {
        if (convo?.workspaceId) {
          const ws = await window.cowork.db.workspaces.list()
          const match = ws.find((w) => w.id === convo.workspaceId)
          if (!cancelled) setWorkspace(match?.path ?? "")
        } else {
          setWorkspace("")
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [conversationId, pendingProjectId])

  // Fetch the skill catalog for the slash menu. Extracted so it can be re-run on
  // demand (see below): the main process reads skills fresh from disk every turn,
  // but this renderer copy would otherwise only refresh on workspace change, so an
  // on-disk add/move wouldn't show up until a new session. Stable per workspace.
  const reloadSkills = useCallback(() => {
    let cancelled = false
    window.cowork.skills
      .list(workspace.trim() || undefined)
      .then((list) => {
        if (!cancelled) setSkills(list)
      })
      .catch(() => {
        if (!cancelled) setSkills([])
      })
    return () => {
      cancelled = true
    }
  }, [workspace])

  // Initial load + reload on workspace change (project-level skills live under
  // <workspace>/.cowork/skills and <workspace>/.github/skills).
  useEffect(() => reloadSkills(), [reloadSkills])

  // Load the user-invocable custom agents for the picker. Reloads on workspace
  // change (workspace-level agents live under <workspace>/.cowork/agents and
  // <workspace>/.github/agents), mirroring skills.
  useEffect(() => {
    let cancelled = false
    window.cowork.agents
      .list(workspace.trim() || undefined)
      .then((list) => {
        if (!cancelled) setAgents(list)
      })
      .catch(() => {
        if (!cancelled) setAgents([])
      })
    return () => {
      cancelled = true
    }
  }, [workspace])

  // Report the workspace root up to the Shell so the sidebar Changes review + the
  // browser file:// opens can use it. Chat has no workspace → report empty.
  useEffect(() => {
    onWorkspaceChange?.(isChat ? "" : workspace.trim())
  }, [workspace, isChat, onWorkspaceChange])

  // Fetch the git branch for the current workspace folder. Clears when the
  // folder is deselected or when it's not a git repo. Also re-runs whenever the
  // window regains focus: the branch can change out from under us (the user
  // switches branches in their IDE while the app is in the background), and a
  // one-shot read on folder-select would otherwise show a stale branch forever.
  useEffect(() => {
    const path = workspace.trim()
    if (!path || isChat) {
      setGitBranch(null)
      return
    }
    let cancelled = false
    const refresh = () => {
      window.cowork.git
        .branch(path)
        .then((branch) => {
          if (!cancelled) setGitBranch(branch)
        })
        .catch(() => {
          if (!cancelled) setGitBranch(null)
        })
    }
    refresh()
    window.addEventListener("focus", refresh)
    return () => {
      cancelled = true
      window.removeEventListener("focus", refresh)
    }
  }, [workspace, isChat])

  // The confirmed mentions, in the shape the token helpers consume. Both the
  // overlay (badges) and send-time expansion read this.
  const confirmedMentions: ConfirmedMentions[] = [
    { kind: "skill", values: confirmedSkills },
    { kind: "file", values: confirmedFiles },
  ]

  // The menu's rendered items for the current trigger. Skills are ranked
  // client-side (small list); files arrive pre-filtered from the main process.
  // Both the render and arrow-key navigation read this same ordered list.
  const menuItems: MentionItem[] =
    menu?.kind === "skill"
      ? rankSkills(skills, menu.query).map((s) => ({
          value: s.name,
          primary: `/${s.name}`,
          secondary: s.description,
        }))
      : menu?.kind === "file"
        ? fileItems.map((path) => ({
            value: path,
            primary: `@${baseName(path)}`,
            secondary: dirName(path),
          }))
        : []
  const menuOpen = menu !== null

  // Fetch the workspace file list for an `@` query (server-side filtered).
  // Stale-guarded so only the latest query's result is applied.
  function fetchFiles(query: string) {
    const req = ++fileReqRef.current
    window.cowork.files
      .list(workspace.trim(), query)
      .then((paths) => {
        if (fileReqRef.current === req) {
          setFileItems(paths)
          setMenuActive((prev) => prev ?? paths[0] ?? null)
        }
      })
      .catch(() => {
        if (fileReqRef.current === req) setFileItems([])
      })
  }

  // Handle composer edits: update the text, (re)detect the trigger token at the
  // caret to drive the menu, and drop any confirmed mention whose token the user
  // has since deleted (so stale badges/expansions don't linger). The `@` menu is
  // only offered in workspace-backed views (Chat has no workspace to list).
  function handleMessageChange(text: string, caret: number) {
    setMessage(text)
    const token = activeMentionToken(text, caret)
    const allowed = token && (token.kind === "skill" || !isChat)
    if (token && allowed) {
      // Re-scan skills as the `/` menu opens (only on the open transition, not
      // every keystroke) so on-disk adds/moves show up without a new session.
      if (token.kind === "skill" && menu?.kind !== "skill") reloadSkills()
      setMenu({ kind: token.kind, query: token.query })
      if (token.kind === "skill") {
        // Preselect the top-ranked skill so Enter works without arrowing first.
        setMenuActive(rankSkills(skills, token.query)[0]?.name ?? null)
      } else {
        // Files are async: clear the highlight and fetch; fetchFiles seeds it.
        setMenuActive(null)
        fetchFiles(token.query)
      }
    } else {
      setMenu(null)
      setMenuActive(null)
    }
    // Reconcile confirmed mentions against tokens still present in the text.
    const present = segmentMessage(text, confirmedMentions).filter(
      (s) => s.kind
    )
    reconcileConfirmed(setConfirmedSkills, present, "skill")
    reconcileConfirmed(setConfirmedFiles, present, "file")
  }

  // Drop confirmed values of one kind whose marker no longer appears in `present`
  // (the segmented mention tokens still in the text).
  function reconcileConfirmed(
    setter: typeof setConfirmedSkills,
    present: { text: string; kind: MentionKind | null }[],
    kind: MentionKind
  ) {
    setter((prev) => {
      if (prev.size === 0) return prev
      const stillThere = new Set(
        present.filter((s) => s.kind === kind).map((s) => s.text.slice(1)) // strip the leading trigger char
      )
      if (stillThere.size === prev.size) return prev
      return stillThere
    })
  }

  // Insert the chosen mention's canonical token in place of the trigger token
  // being typed, mark it confirmed (badge + send-time expansion), close the menu,
  // and restore the caret just after the inserted token.
  function selectMention(item: MentionItem) {
    if (!menu) return
    const el = textareaRef.current
    const caret = el?.selectionStart ?? message.length
    const token = activeMentionToken(message, caret)
    if (!token) return
    const insert = `${token.trigger}${item.value} `
    const next =
      message.slice(0, token.start) + insert + message.slice(token.end)
    const nextCaret = token.start + insert.length
    setMessage(next)
    if (menu.kind === "skill") {
      setConfirmedSkills((prev) => new Set(prev).add(item.value))
    } else {
      setConfirmedFiles((prev) => new Set(prev).add(item.value))
    }
    setMenu(null)
    setMenuActive(null)
    // Restore focus + caret after React commits the new value.
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (node) {
        node.focus()
        node.setSelectionRange(nextCaret, nextCaret)
      }
    })
  }

  // Keyboard handling for the composer. When the menu is open, intercept
  // navigation/selection keys BEFORE the Enter-to-send path below; otherwise
  // fall through to the existing send behavior.
  function handleComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen && menuItems.length > 0) {
      const idx = menuItems.findIndex((it) => it.value === menuActive)
      if (e.key === "ArrowDown") {
        e.preventDefault()
        const next = menuItems[(idx + 1 + menuItems.length) % menuItems.length]
        setMenuActive(next.value)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        const prev = menuItems[(idx - 1 + menuItems.length) % menuItems.length]
        setMenuActive(prev.value)
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const chosen = menuItems[idx] ?? menuItems[0]
        if (chosen) selectMention(chosen)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setMenu(null)
        setMenuActive(null)
        return
      }
    }
    // Menu closed (or empty): existing Enter-to-send, Shift+Enter for newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  async function pickWorkspace() {
    try {
      const data = await window.cowork.pickWorkspace()
      if (data.path) {
        setWorkspace(data.path)
        // If a conversation already exists, record the workspace on it now;
        // otherwise it's linked when the conversation is created on first send.
        if (conversationId) {
          const ws = await window.cowork.db.workspaces.upsert(data.path)
          await window.cowork.db.conversations.update(conversationId, {
            workspaceId: ws.id,
          })
          onConversationChanged()
        }
      }
    } catch (error) {
      pushError(error)
    }
  }

  async function attachFiles() {
    try {
      const data = await window.cowork.pickFiles()
      if (data.paths?.length) {
        // Merge with existing, de-duplicating by path.
        setAttachments((prev) => [...new Set([...prev, ...data.paths!])])
      }
    } catch (error) {
      pushError(error)
    }
  }

  // Surface a picker failure as an assistant text item in the transcript.
  function pushError(error: unknown) {
    const content = error instanceof Error ? error.message : "Picker failed"
    setTimeline((prev) => [
      ...prev,
      { kind: "text", key: `err-${prev.length}`, role: "assistant", content },
    ])
  }

  function removeAttachment(path: string) {
    setAttachments((prev) => prev.filter((p) => p !== path))
  }

  // Resolve an inline approval request. Optimistically flips the card's status
  // (so the buttons disappear immediately), then unblocks the paused agent loop
  // over IPC. The matching tool's "done" event will clear the card shortly after.
  function resolveApproval(
    requestId: string,
    decision: "approved" | "denied",
    remember?: "workspace" | "conversation"
  ) {
    // The card is only shown for the conversation on screen, so flip its status
    // in that conversation's live turn (matched by requestId, wherever its
    // segment is).
    if (conversationId) {
      updateLive(conversationId, (turn) => ({
        ...turn,
        segments: turn.segments.map((seg) =>
          seg.kind === "tools"
            ? {
                ...seg,
                calls: seg.calls.map((t) =>
                  t.approval?.requestId === requestId
                    ? { ...t, approval: { ...t.approval, status: decision } }
                    : t
                ),
              }
            : seg
        ),
      }))
    }
    void window.cowork.chatApprove({ requestId, decision, remember })
  }

  // Change the agent mode from the composer dropdown. Updates session state and,
  // when a turn is currently running, pushes the Auto flag to that live turn so
  // switching to Auto mid-turn actually applies (the backend gate reads it live;
  // turning Auto on there also clears any pending approval). Plan can't be
  // toggled onto a running turn (it gates the toolset at turn start), so only the
  // Auto flag is propagated — mode still updates locally for the next turn.
  function changeAgentMode(mode: AgentMode) {
    setAgentMode(mode)
    if (loading && conversationId) {
      void window.cowork.chatSetAutoMode(conversationId, mode === "auto")
    }
  }

  // Fire a desktop notification about a turn in `convoId`, labeling it with the
  // conversation's title when available. Self-gates on settings + focus/view (see
  // maybeNotify): the window being focused on THIS conversation suppresses it.
  const notify = useCallback(
    async (
      convoId: string,
      kind: Parameters<typeof maybeNotify>[0]["kind"],
      body: string
    ) => {
      let title = agentName
      try {
        const convo = await window.cowork.db.conversations.get(convoId)
        if (convo?.title?.trim()) title = convo.title.trim()
      } catch {
        // Title lookup is best-effort — fall back to the agent name.
      }
      void maybeNotify({
        kind,
        title,
        body,
        conversationId: convoId,
        isViewing: viewingRef.current === convoId,
      })
    },
    [agentName]
  )

  async function sendMessage() {
    if (!canSend) return
    // Expand confirmed mention tokens before sending, so the model reliably
    // reads them: `/git-commit` → `git-commit skill`, `@src/foo.ts` → `src/foo.ts`.
    // The expanded text is also what's shown in the optimistic timeline, so the
    // transcript matches what the agent received.
    const base = expandMentions(message, confirmedMentions).trim()
    // Prepend a descriptor per picked element (if any) so the agent knows exactly
    // which on-page element(s) the user is pointing at. It can act on each two
    // ways: edit the source that renders it (grep the selector/text), or
    // browser_snapshot + match the role/name to click it.
    const text = pickedElements.length
      ? `${pickedElements.map(formatPickedElement).join("\n")}\n\n${base}`
      : base
    const sentAttachments = attachments

    // Ensure a conversation exists — created lazily on first send. For
    // workspace views, link the picked workspace at creation time.
    let convoId = conversationId
    let isNew = false
    if (!convoId) {
      let workspaceId: string | undefined
      if (!isChat && workspace.trim()) {
        const ws = await window.cowork.db.workspaces.upsert(workspace.trim())
        workspaceId = ws.id
      }
      const convo = await window.cowork.db.conversations.create({
        mode: VIEW_TO_MODE[view],
        workspaceId,
        // Stamp the project the conversation was started in (null = "No Project").
        projectId: pendingProjectId,
        // Persist the chosen model on the new conversation. Null means "inherit
        // the default" — only store an explicit pick that differs from default.
        accountId: selAccountId,
        modelId: selModelId,
        // Persist the selected custom agent (null = built-in main agent).
        agentName: selAgentName,
      })
      convoId = convo.id
      isNew = true
    }

    // From here, treat `convoId` as a non-null local so the guards below read
    // cleanly (it's assigned in both branches above).
    const turnConvoId = convoId as string

    // Optimistically append the user message; the assistant turn renders from
    // the transient live state below until the turn settles and reconciles.
    setTimeline((prev) => [
      ...prev,
      {
        kind: "text",
        key: `local-${turnConvoId}-${prev.length}`,
        role: "user",
        content: text,
      },
    ])
    setMessage("")
    setConfirmedSkills(new Set())
    setConfirmedFiles(new Set())
    setMenu(null)
    setMenuActive(null)
    setAttachments([])
    setPickedElements([])
    // Start this conversation's live turn from a clean slate (its buffers are
    // keyed by conversation, so this never touches another conversation's turn).
    setLiveTurns((prev) => {
      const next = new Map(prev)
      next.set(turnConvoId, EMPTY_LIVE)
      return next
    })
    // Mark this conversation as streaming (per-conversation, so switching away
    // doesn't carry the spinner/Stop button to another conversation).
    setRunningConvos((prev) => new Set(prev).add(turnConvoId))

    // Promote a freshly created conversation to active NOW, not after the turn,
    // so its live stream renders in place under a stable id. viewingRef is set
    // synchronously (the load effect reads it), and justCreatedRef tells that
    // effect to skip its reload so the optimistic transcript isn't wiped.
    if (isNew) {
      justCreatedRef.current = turnConvoId
      viewingRef.current = turnConvoId
      onConversationCreated(turnConvoId)
    }

    try {
      const data = await window.cowork.chat(
        {
          conversationId: turnConvoId,
          message: text,
          // Chat sends no workspace and inlines attachments instead.
          workspace: isChat ? undefined : workspace.trim(),
          attachments: isChat ? sentAttachments : undefined,
          // Plan mode is interactive/north_star only (never Chat); auto mode is
          // available everywhere, including Chat (suppresses browser_navigate
          // prompts).
          planMode: !isChat && agentMode === "plan",
          autoMode: agentMode === "auto",
        },
        // Events always route into THIS turn's own per-conversation live buffer
        // (keyed by turnConvoId), regardless of what's on screen. The render layer
        // decides what to show by looking up the viewed conversation's entry, so a
        // turn that keeps streaming after the user switches away no longer loses
        // its tokens/tools/approval — they're preserved and restored on return.
        (event) => {
          if (event.type === "token") {
            updateLive(turnConvoId, (turn) => appendLiveText(turn, event.delta))
          } else if (event.type === "tool" && event.phase === "start") {
            // A tool started — add a running row (label derived from its args) to
            // the current tools segment, or open a new one after streamed text.
            updateLive(turnConvoId, (turn) =>
              addLiveToolStart(
                turn,
                toToolUse({
                  id: event.id,
                  name: event.name,
                  arguments: event.arguments,
                })
              )
            )
          } else if (event.type === "tool" && event.phase === "done") {
            // Its result arrived — attach it, clear any approval card, and flip
            // status (matched by id, wherever its segment is).
            updateLive(turnConvoId, (turn) =>
              updateLiveTool(turn, event.id, (t) => ({
                ...t,
                result: event.result,
                status: isErrorResult(event.result) ? "error" : "done",
                approval: undefined,
              }))
            )
          } else if (event.type === "approval") {
            // The agent is paused waiting on a human decision — attach a pending
            // approval card to the matching (already-running) tool row.
            updateLive(turnConvoId, (turn) =>
              updateLiveTool(turn, event.id, (t) => ({
                ...t,
                approval: {
                  requestId: event.requestId,
                  summary: event.summary,
                  reason: event.reason,
                  status: "pending",
                  kind: event.kind,
                },
              }))
            )
            void notify(
              turnConvoId,
              "needsInput",
              event.summary || "The agent needs your approval to continue."
            )
          } else if (event.type === "question") {
            // The agent paused to ask the user — show the question panel above
            // the composer until answered.
            updateLive(turnConvoId, (turn) => ({
              ...turn,
              question: {
                requestId: event.requestId,
                questions: event.questions,
              },
            }))
            void notify(
              turnConvoId,
              "needsInput",
              event.questions[0]?.question ||
                "The agent has a question for you."
            )
          } else if (event.type === "plan_mode") {
            // Only the backend knows whether the configured execution environment
            // started successfully, so reflect its confirmed state instead of
            // optimistically clearing the toggle when approval is submitted.
            // When plan mode turns off and we're still in "plan" mode (not "auto"),
            // reset to "default". If auto_mode already fired this event cycle,
            // agentMode is already "auto" — leave it alone.
            if (!event.enabled) {
              setAgentMode((prev) => (prev === "plan" ? "default" : prev))
            } else {
              setAgentMode("plan")
            }
          } else if (event.type === "auto_mode") {
            // The user approved the plan with "Auto mode" — activate auto for
            // the remainder of this turn and beyond (until conversation switch).
            if (event.enabled) setAgentMode("auto")
          }
        }
      )
      // Surface the final text/error in this turn's live bubble. An error is
      // APPENDED (not `s || …`) so it shows even after a preamble already streamed
      // — otherwise a turn that ends mid-work after some text would stop silently.
      // (Transient — immediately superseded by the reconcile below, which also
      // reads the persisted error note.)
      if (data.error) {
        if (data.errorCode === "execution_backend_unavailable") {
          toast.error("Selected execution backend is unavailable", {
            id: `backend-unavailable-${turnConvoId}`,
            description:
              "Start the configured runtime or choose another backend in Settings.",
            duration: 10000,
            action: {
              label: "Open settings",
              onClick: () => onOpenSettings("backend"),
            },
          })
        }
        updateLive(turnConvoId, (turn) =>
          appendLiveFinalText(
            turn,
            turn.segments.some((s) => s.kind === "text" && s.text)
              ? `⚠️ ${data.error}`
              : `Error: ${data.error}`
          )
        )
      } else if (data.stopped) {
        // Clean user cancel — the "⏹ Stopped by user." note is persisted and
        // shown by the reconcile below; append a transient marker meanwhile.
        updateLive(turnConvoId, (turn) =>
          appendLiveFinalText(turn, "⏹ Stopped")
        )
      } else if (data.content) {
        // Final answer with no streamed text (rare): seed a text segment so the
        // bubble isn't empty. If text already streamed, it's already shown.
        updateLive(turnConvoId, (turn) =>
          turn.segments.some((s) => s.kind === "text" && s.text)
            ? turn
            : appendLiveText(turn, data.content!)
        )
      }
      // Desktop notification on settle: error vs done. A clean user-initiated
      // stop is silent (the user is right here). The body is a short snippet of
      // the outcome; maybeNotify suppresses it when the window is focused on this
      // very conversation.
      if (data.error) {
        void notify(turnConvoId, "turnError", snippet(data.error))
      } else if (!data.stopped) {
        void notify(turnConvoId, "turnComplete", "The agent finished its turn.")
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Request failed"
      updateLive(turnConvoId, (turn) =>
        appendLiveFinalText(
          turn,
          turn.segments.some((s) => s.kind === "text" && s.text)
            ? `⚠️ ${msg}`
            : msg
        )
      )
      void notify(turnConvoId, "turnError", snippet(msg))
    } finally {
      // Clear this conversation's running flag (drops its spinner/Stop button).
      setRunningConvos((prev) => {
        if (!prev.has(turnConvoId)) return prev
        const next = new Set(prev)
        next.delete(turnConvoId)
        return next
      })
      // Reconcile the settled turn into the persisted transcript so the rendered
      // content matches storage exactly, then drop its live buffer. If this turn's
      // conversation is on screen, refresh the timeline in place; either way the
      // live entry is dropped (its content is now persisted and rebuilt by
      // buildTimeline whenever the conversation is next viewed).
      try {
        const rows = await window.cowork.db.messages.list(turnConvoId)
        if (viewingRef.current === turnConvoId) setTimeline(buildTimeline(rows))
      } catch {
        // Keep the optimistic view if the reconcile read fails.
      }
      clearLive(turnConvoId)
      // Refresh the sidebar ordering/title. (A freshly created conversation was
      // already promoted to active up front, before the turn started streaming.)
      onConversationChanged()
    }
  }

  // Start the current message as a durable background task instead of a live
  // turn. The runner persists the message, queues the task, and streams progress
  // to the Workspace Activity panel — so this does NOT use the live chat path or
  // touch the transcript view here. Workspace-backed views only for now (Chat's
  // attachment-only path can come later).
  async function runInBackground() {
    if (!canSend || isChat) return
    const text = message.trim()

    // Ensure a conversation exists — created lazily, mirroring sendMessage. For
    // workspace views, link the picked workspace at creation time.
    let convoId = conversationId
    let isNew = false
    if (!convoId) {
      let workspaceId: string | undefined
      if (workspace.trim()) {
        const ws = await window.cowork.db.workspaces.upsert(workspace.trim())
        workspaceId = ws.id
      }
      const convo = await window.cowork.db.conversations.create({
        mode: VIEW_TO_MODE[view],
        workspaceId,
        projectId: pendingProjectId,
        accountId: selAccountId,
        modelId: selModelId,
        agentName: selAgentName,
      })
      convoId = convo.id
      isNew = true
    }

    await window.cowork.tasks.start({ conversationId: convoId, message: text })
    setMessage("")
    setAttachments([])
    // Promote a freshly created conversation (also refreshes the sidebar); else
    // just refresh ordering. Either way reveal the activity panel so the new task
    // is visible.
    if (isNew) onConversationCreated(convoId)
    else onConversationChanged()
    onRanInBackground?.()
  }

  // Cancel the in-flight turn for the conversation on screen. The Stop button is
  // only shown while THIS conversation is loading (loading is derived from
  // runningConvos), so the displayed conversationId is the one to cancel. The
  // main process aborts the LLM stream and resolves chat() with `{ stopped: true }`,
  // which unwinds that turn's sendMessage finally normally.
  function stopMessage() {
    if (conversationId) window.cowork.chatStop(conversationId)
  }

  // The live turn for the conversation on screen (if any). All the render-time
  // live state — streamed text, tool rows, pending approval/question — reads from
  // this, so switching conversations just changes which entry we look up rather
  // than wiping a shared buffer.
  const liveTurn = conversationId ? liveTurns.get(conversationId) : undefined
  const liveSegments = liveTurn?.segments ?? []
  // Flattened tool list — for the pending-approval lookup and the "any tools
  // yet?" checks. Ordering is preserved in `liveSegments` for rendering.
  const liveTools = liveToolsOf(liveTurn)
  const liveQuestion = liveTurn?.question ?? null

  // Submit the user's answers to a pending ask_user_question. Clear the panel
  // immediately (the agent resumes with the answers as the tool result).
  function answerQuestion(answers: QuestionAnswer[]) {
    if (!liveQuestion || !conversationId) return
    void window.cowork.chatAnswer({
      requestId: liveQuestion.requestId,
      answers,
    })
    updateLive(conversationId, (turn) => ({ ...turn, question: null }))
  }

  // Back out of the pending question entirely. Stopping the turn resolves the
  // backend's blocked `ask` as "cancelled", so the loop unwinds without another
  // round-trip. For the plan approval this means the plan isn't implemented and
  // plan mode stays on (setPlanMode(false) only runs on approval), so the user
  // can redirect or start a fresh plan. Clear the panel immediately.
  function cancelQuestion() {
    if (!conversationId) return
    window.cowork.chatStop(conversationId)
    updateLive(conversationId, (turn) => ({ ...turn, question: null }))
  }

  // A question carrying a body to review (currently the plan approval) can be
  // backed out of, not just answered — hence a Cancel. Plain clarifying
  // questions keep the answer-or-stop behavior unchanged.
  const questionCancellable =
    liveQuestion?.questions.some((q) => q.body) === true

  // The mode the dropdown reflects. Plan mode is workspace-only; Chat has no Plan
  // item, so a "plan" state carried into Chat (a fresh, still-null conversation
  // shared across views never re-runs the reset effect) shows as Default —
  // matching the send path, which never sends planMode in Chat.
  const displayedMode: AgentMode =
    isChat && agentMode === "plan" ? "default" : agentMode

  // What to actually render as the transcript. When a live turn is on screen, the
  // assistant response after the last user message is owned by the live buffer
  // (streamed text + tool rows + approval card). But switching away and back
  // reloads this conversation's rows from the DB — and the agent persists its
  // assistant tool_calls row mid-turn, before the approval gate blocks. Left
  // as-is that row would render a second, "interrupted" copy of the same tools
  // group alongside the live one. So while a live turn exists, drop everything
  // after the last user message: the live buffer is the single source of truth
  // for the in-flight response. (No live turn → render the full timeline.)
  const displayTimeline = (() => {
    if (!liveTurn) return timeline
    let lastUser = -1
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i]
      if (item.kind === "text" && item.role === "user") {
        lastUser = i
        break
      }
    }
    return lastUser === -1 ? timeline : timeline.slice(0, lastUser + 1)
  })()

  // Before the first message is sent, an empty session shows the composer
  // centered (an inviting "start typing" state). Once there are messages it
  // moves to its usual bottom-pinned position.
  const isEmpty = timeline.length === 0 && !loading

  // Sequential gating means at most one approval is pending at a time, so a
  // single panel above the composer suffices. Purely derived — it disappears
  // automatically when resolved, when the tool completes, or when the turn ends.
  const pendingApproval = liveTools.find(
    (t) => t.approval?.status === "pending"
  )?.approval

  // When an approval appears, pull focus out of the message box so the single-key
  // approval shortcuts (Enter / S / Esc) work instead of typing into the composer.
  useEffect(() => {
    if (pendingApproval) textareaRef.current?.blur()
  }, [pendingApproval])

  // Likewise when a question panel appears: blur the composer so the panel's
  // arrow/Enter navigation works instead of typing into the message box. Mirrors
  // the approval blur above; the two are mutually exclusive (sequential gating).
  useEffect(() => {
    if (liveQuestion) textareaRef.current?.blur()
  }, [liveQuestion])

  // Keyboard shortcuts for the pending approval, active only while one is shown:
  //   Enter → Approve once   S → Approve for session/workspace   Esc → Reject
  // The "S" scope mirrors ApprovalCard exactly: no session option for delegate;
  // "conversation" for web, "workspace" otherwise. Guarded by isTypingTarget so a
  // focused field (e.g. an open question's Other box) keeps its own keys — though
  // the blur above means the composer isn't focused while this is active.
  useEffect(() => {
    if (!pendingApproval) return
    const { requestId, kind } = pendingApproval
    // Global DOM KeyboardEvent (App imports React's KeyboardEvent type for the
    // composer handler; this window listener needs the DOM one).
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (e.defaultPrevented || e.repeat) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      if (e.key === "Enter") {
        e.preventDefault()
        resolveApproval(requestId, "approved")
      } else if (e.key === "Escape") {
        e.preventDefault()
        resolveApproval(requestId, "denied")
      } else if (e.key.toLowerCase() === "s") {
        // Session/workspace approve — only when the card offers it (not delegate).
        if (kind === "delegate") return
        e.preventDefault()
        resolveApproval(
          requestId,
          "approved",
          kind === "web" ? "conversation" : "workspace"
        )
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [pendingApproval])

  // The composer's model picker. Spans every provider's models (grouped by
  // provider) in a type-to-filter combobox, so a session can switch provider+model
  // inline without visiting Settings. The choice is per-conversation: persisted
  // onto the conversation row if it exists, else held in state and carried into
  // create() on first send. Each item value encodes account + model
  // (`accountId::modelId`) to disambiguate the same model id across providers.
  // Fallback state:
  // - no enabled providers: send the user to Settings → Providers
  // - enabled providers but no models: send the user to Settings → Models
  async function selectModel(accountId: string, modelId: string) {
    setSelAccountId(accountId)
    setSelModelId(modelId)
    if (conversationId) {
      await window.cowork.db.conversations.update(conversationId, {
        accountId,
        modelId,
      })
    }
  }
  // Select the custom agent for this conversation (null = built-in main agent).
  // Persisted immediately when the conversation exists; otherwise carried into
  // create() on first send, mirroring selectModel.
  async function selectAgent(agentName: string | null) {
    setSelAgentName(agentName)
    if (conversationId) {
      await window.cowork.db.conversations.update(conversationId, { agentName })
    }
  }
  // Combobox items use { value: "accountId::modelId", label } objects — Base UI
  // filters and displays on `label` automatically. Grouped by provider account.
  const modelGroups = accountsWithModels
    .filter((a) => a.models.length > 0)
    .map((a) => ({
      value: a.account.id,
      label: a.account.displayName,
      items: a.models.map((m) => ({
        value: `${a.account.id}::${m.modelId}`,
        label: m.modelName && m.modelName.trim() ? m.modelName : m.modelId,
      })),
    }))
  const selectedItem =
    effAccountId && effModelId
      ? (modelGroups
          .flatMap((g) => g.items)
          .find((it) => it.value === `${effAccountId}::${effModelId}`) ?? null)
      : null
  const configureModelTarget = hasEnabledProviders ? "models" : "providers"
  const configureModelLabel = hasEnabledProviders
    ? "Configure model…"
    : "Configure provider…"
  const modelPicker = hasSelectableModels ? (
    <Combobox
      items={modelGroups}
      value={selectedItem}
      isItemEqualToValue={(a, b) => a?.value === b?.value}
      onValueChange={(item) => {
        if (!item) return
        const sep = item.value.indexOf("::")
        if (sep < 0) return
        void selectModel(item.value.slice(0, sep), item.value.slice(sep + 2))
      }}
    >
      <ComboboxTrigger className="flex h-7 max-w-52 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        <ComboboxValue placeholder="Model">
          {(value: { label: string } | null) => (
            <span className="truncate">{value ? value.label : "Model"}</span>
          )}
        </ComboboxValue>
      </ComboboxTrigger>
      <ComboboxContent className="w-72 min-w-72">
        <ComboboxInput placeholder="Search models…" showTrigger={false} />
        <ComboboxEmpty>No models found.</ComboboxEmpty>
        <ComboboxList>
          {(group: {
            value: string
            label: string
            items: { value: string; label: string }[]
          }) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.label}</ComboboxLabel>
              <ComboboxCollection>
                {(item: { value: string; label: string }) => (
                  <ComboboxItem key={item.value} value={item}>
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  ) : (
    <button
      type="button"
      onClick={() => onOpenSettings(configureModelTarget)}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {configureModelLabel}
    </button>
  )

  // Icon-only model picker shown when the right panel is open (squeezes the
  // toolbar). Uses the same Combobox but renders only the BrainCircuit icon;
  // the selected model name appears as a native tooltip.
  const modelPickerCompact = hasSelectableModels ? (
    <Combobox
      items={modelGroups}
      value={selectedItem}
      isItemEqualToValue={(a, b) => a?.value === b?.value}
      onValueChange={(item) => {
        if (!item) return
        const sep = item.value.indexOf("::")
        if (sep < 0) return
        void selectModel(item.value.slice(0, sep), item.value.slice(sep + 2))
      }}
    >
      <ComboboxTrigger
        title={selectedItem ? selectedItem.label : "Select model"}
        className="flex h-7 items-center rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <BrainCircuit className="size-4" />
      </ComboboxTrigger>
      <ComboboxContent className="w-72 min-w-72">
        <ComboboxInput placeholder="Search models…" showTrigger={false} />
        <ComboboxEmpty>No models found.</ComboboxEmpty>
        <ComboboxList>
          {(group: {
            value: string
            label: string
            items: { value: string; label: string }[]
          }) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.label}</ComboboxLabel>
              <ComboboxCollection>
                {(item: { value: string; label: string }) => (
                  <ComboboxItem key={item.value} value={item}>
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  ) : (
    <button
      type="button"
      title={configureModelLabel.replace("…", "")}
      onClick={() => onOpenSettings(configureModelTarget)}
      className="flex items-center rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <BrainCircuit className="size-4" />
    </button>
  )

  // Custom agent picker. Only shown when the user has at least one invocable
  // agent on disk (~/.cowork/agents or the workspace agent dirs). A type-to-filter
  // combobox mirroring the model picker: a flat item list where value "" is the
  // "Default (no agent)" entry (clears the selection → built-in main agent) and
  // each other item is an agent (filtered by name). Compact (icon-only) when the
  // right panel squeezes the toolbar. The selected agent's prompt is prepended
  // to ours per turn.
  const agentItems: { value: string; label: string; description?: string }[] = [
    { value: "", label: "Default (no agent)" },
    ...agents.map((a) => ({
      value: a.name,
      label: a.name,
      description: a.description,
    })),
  ]
  const selectedAgentItem =
    agentItems.find((it) => it.value === (selAgentName ?? "")) ?? null
  const renderAgentItem = (item: {
    value: string
    label: string
    description?: string
  }) => (
    <ComboboxItem key={item.value || "__default__"} value={item}>
      <span className="flex flex-col gap-0.5">
        <span>{item.label}</span>
        {item.description && (
          <span className="line-clamp-2 text-[10px] text-muted-foreground">
            {item.description}
          </span>
        )}
      </span>
    </ComboboxItem>
  )
  const onAgentValueChange = (item: { value: string } | null) => {
    if (!item) return
    void selectAgent(item.value || null)
  }
  const agentPicker =
    agents.length > 0 ? (
      <Combobox
        items={agentItems}
        value={selectedAgentItem}
        isItemEqualToValue={(a, b) => a?.value === b?.value}
        onValueChange={onAgentValueChange}
      >
        <ComboboxTrigger
          className={cn(
            "flex h-7 max-w-52 items-center gap-1 rounded-md px-2 text-xs transition-colors",
            selAgentName
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          <Bot className="size-4 shrink-0" />
          <ComboboxValue placeholder="Agent">
            {(value: { value: string; label: string } | null) => (
              <span className="truncate">
                {value && value.value ? value.label : "Agent"}
              </span>
            )}
          </ComboboxValue>
        </ComboboxTrigger>
        <ComboboxContent className="w-72 min-w-72">
          <ComboboxInput placeholder="Search agents…" showTrigger={false} />
          <ComboboxEmpty>No agents found.</ComboboxEmpty>
          <ComboboxList>{renderAgentItem}</ComboboxList>
        </ComboboxContent>
      </Combobox>
    ) : null

  // Icon-only agent picker shown when the right panel is open (squeezes the
  // toolbar). Same Combobox; renders only the Bot icon, selected agent as tooltip.
  const agentPickerCompact =
    agents.length > 0 ? (
      <Combobox
        items={agentItems}
        value={selectedAgentItem}
        isItemEqualToValue={(a, b) => a?.value === b?.value}
        onValueChange={onAgentValueChange}
      >
        <ComboboxTrigger
          title={selAgentName ? `Agent: ${selAgentName}` : "Select agent"}
          className={cn(
            "flex h-7 items-center rounded-md px-2 transition-colors",
            selAgentName
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          <Bot className="size-4" />
        </ComboboxTrigger>
        <ComboboxContent className="w-72 min-w-72">
          <ComboboxInput placeholder="Search agents…" showTrigger={false} />
          <ComboboxEmpty>No agents found.</ComboboxEmpty>
          <ComboboxList>{renderAgentItem}</ComboboxList>
        </ComboboxContent>
      </Combobox>
    ) : null

  // The composer (attachment chips + input box). Rendered both centered and
  // bottom-pinned, so it's defined once here.
  const composer = (
    <>
      {/* Picked browser elements — removable chips, prepended to the next
          message. Several can accumulate (sticky picker / Alt+click). */}
      {pickedElements.length > 0 && (
        <AttachmentGroup className="mb-2">
          {pickedElements.map((el, i) => (
            <Attachment
              key={`${el.selector}-${i}`}
              size="sm"
              title={formatPickedElement(el)}
            >
              <AttachmentMedia variant="icon">
                <MousePointerClick />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{pickedElementLabel(el)}</AttachmentTitle>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  onClick={() =>
                    setPickedElements((prev) => prev.filter((_, j) => j !== i))
                  }
                  aria-label="Remove picked element"
                >
                  <X />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ))}
        </AttachmentGroup>
      )}
      {/* Attachment cards (Chat only) — removable, shown above the input. */}
      {isChat && attachments.length > 0 && (
        <AttachmentGroup className="mb-2">
          {attachments.map((path) => (
            <Attachment key={path} size="sm" title={path}>
              <AttachmentMedia variant="icon">
                <FileText />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{lastSegment(path)}</AttachmentTitle>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  onClick={() => removeAttachment(path)}
                  aria-label={`Remove ${lastSegment(path)}`}
                >
                  <X />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          ))}
        </AttachmentGroup>
      )}
      <div className="relative rounded-2xl border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        {menuOpen && (
          <MentionMenu
            items={menuItems}
            activeValue={menuActive}
            onActiveValueChange={setMenuActive}
            onSelect={selectMention}
            emptyLabel={
              menu?.kind === "file" ? "No matching files" : "No matching skills"
            }
          />
        )}
        {/* Input box: a transparent-text mirror behind the textarea paints a
            rounded tint behind confirmed mention tokens (the "badge"). The two
            share identical typography/padding so the tint lines up exactly. */}
        <div className="relative">
          <div
            ref={overlayRef}
            aria-hidden
            className="pointer-events-none absolute inset-0 overflow-hidden px-4 py-3 text-sm leading-relaxed break-words whitespace-pre-wrap text-transparent"
          >
            {segmentMessage(message, confirmedMentions).map((seg, i) =>
              seg.kind ? (
                <span key={i} className="rounded bg-primary/15">
                  {seg.text}
                </span>
              ) : (
                <span key={i}>{seg.text}</span>
              )
            )}
          </div>
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) =>
              handleMessageChange(e.target.value, e.target.selectionStart)
            }
            onKeyDown={handleComposerKeyDown}
            onScroll={(e) => {
              if (overlayRef.current)
                overlayRef.current.scrollTop = e.currentTarget.scrollTop
            }}
            rows={2}
            placeholder="Send a message…"
            className="relative field-sizing-content max-h-[24.25rem] w-full resize-none bg-transparent px-4 py-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex items-center justify-between px-2.5 pb-2.5">
          <div className="flex items-center gap-1">
            {isChat ? (
              <button
                type="button"
                onClick={attachFiles}
                title="Attach files"
                aria-label="Attach files"
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Plus className="size-4" />
              </button>
            ) : (
              <>
                {lockedWorkspace ? (
                  // The directory comes from the conversation's project and can't
                  // be changed here — show it as a static, non-clickable label.
                  <span
                    title={`${lastSegment(workspace)} — set by the project`}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground"
                  >
                    <FolderOpen className="size-4" />
                    {workspace && !rightPanelOpen && (
                      <span className="max-w-40 truncate">
                        {lastSegment(workspace)}
                      </span>
                    )}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={pickWorkspace}
                    title={
                      workspace
                        ? lastSegment(workspace)
                        : "Select workspace folder"
                    }
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <FolderOpen className="size-4" />
                    {workspace && !rightPanelOpen && (
                      <span className="max-w-40 truncate">
                        {lastSegment(workspace)}
                      </span>
                    )}
                  </button>
                )}
                {gitBranch && !rightPanelOpen && (
                  <span
                    title={gitBranch}
                    className="flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    <GitBranch className="size-3 shrink-0" />
                    <span>{gitBranch}</span>
                  </span>
                )}
                {gitBranch && rightPanelOpen && (
                  <span
                    title={gitBranch}
                    className="flex items-center rounded bg-accent p-1 text-muted-foreground"
                  >
                    <GitBranch className="size-3" />
                  </span>
                )}
              </>
            )}
            {!rightPanelOpen && modelPicker}
            {rightPanelOpen && modelPickerCompact}
            {!rightPanelOpen && agentPicker}
            {rightPanelOpen && agentPickerCompact}
            {/* Agent mode dropdown. Session-only. "Default" = normal; "Plan" =
                read-only planning turn until approved; "Auto" = all gated
                actions auto-approved. Chat offers only Default/Auto — plan mode
                needs the workspace toolset. In Chat a stale "plan" (carried from
                a workspace view via a shared fresh conversation) displays as
                Default, matching the send path which never sends planMode in Chat. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Agent mode: ${displayedMode}`}
                  title={
                    displayedMode === "plan"
                      ? "Plan mode on — agent plans before touching the workspace"
                      : displayedMode === "auto"
                        ? "Auto mode on — agent acts without asking for confirmations"
                        : "Default mode — agent confirms actions before running them"
                  }
                  className={cn(
                    "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
                    displayedMode !== "default"
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <ClipboardList className="size-4 shrink-0" />
                  {!rightPanelOpen && (
                    <span className="capitalize">{displayedMode}</span>
                  )}
                  <ChevronDown className="size-3 shrink-0 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-36">
                <DropdownMenuItem
                  onClick={() => changeAgentMode("default")}
                  className={cn(
                    displayedMode === "default" && "bg-accent font-medium"
                  )}
                >
                  Default
                </DropdownMenuItem>
                {!isChat && (
                  <DropdownMenuItem
                    onClick={() => changeAgentMode("plan")}
                    className={cn(
                      displayedMode === "plan" && "bg-accent font-medium"
                    )}
                  >
                    Plan
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => changeAgentMode("auto")}
                  className={cn(
                    displayedMode === "auto" && "bg-accent font-medium"
                  )}
                >
                  Auto
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Run the message as a durable background task (workspace views
                only). Lives next to Send; disabled by the same gate. */}
            {!isChat && !loading && (
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={runInBackground}
                disabled={!canSend}
                title="Run in background"
                aria-label="Run in background"
                className="size-8 rounded-full"
              >
                <Workflow className="size-4" />
              </Button>
            )}
            {loading ? (
              <Button
                type="button"
                size="icon"
                onClick={stopMessage}
                title="Stop"
                aria-label="Stop"
                className="size-8 rounded-full"
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="button"
                size="icon"
                onClick={sendMessage}
                disabled={!canSend}
                title="Send"
                aria-label="Send"
                className="size-8 rounded-full"
              >
                <ArrowUp className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  )

  // Empty session: center the heading + composer vertically so the user can
  // start typing right away.
  if (isEmpty) {
    return (
      <div className="relative flex h-svh w-full flex-col items-center justify-center overflow-hidden px-4">
        <div className="w-full max-w-[min(90%,48rem)]">
          <div className="mb-6 text-center text-sm text-muted-foreground">
            {view === "Chat" ? (
              <>
                <p className="font-medium text-foreground">
                  {agentName} - Chat
                </p>
                <p>Ask anything. Attach files with the + button.</p>
              </>
            ) : view === "Interactive" ? (
              <>
                <p className="font-medium text-foreground">
                  {agentName} - Interactive
                </p>
                <p>Pick a workspace folder, then ask the agent about it.</p>
              </>
            ) : (
              <>
                <p className="font-medium text-foreground">
                  {agentName} - Autonomous Tasks
                </p>
                <p>Pick a workspace folder, then ask the agent about it.</p>
              </>
            )}
          </div>
          {composer}
        </div>
      </div>
    )
  }

  return (
    // pt-11 clears the Shell's floating top drag bar (h-11, holding the
    // Info/Browser/Changes toggle): the scroll region starts BELOW it, so
    // messages scrolling up are clipped at the bar's edge instead of passing
    // under it. The composer sits inside this column, so it's unaffected.
    <div className="relative flex h-svh w-full flex-col overflow-hidden pt-11">
      {/* Conversation — MessageScroller handles auto-follow + scroll-to-bottom.
          The window drag bar lives in Shell, above this column. */}
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-[min(90%,72rem)] gap-4 px-4 py-6">
              {displayTimeline.map((item, i) => {
                const isLast = i === displayTimeline.length - 1 && !loading
                if (item.kind === "tools") {
                  return (
                    <MessageScrollerItem key={item.key} scrollAnchor={isLast}>
                      <Message align="start">
                        <MessageContent>
                          <ToolGroup calls={item.calls} />
                          <ChangedFilesBar
                            calls={item.calls}
                            workspace={workspace.trim()}
                            onOpenHtml={(p) => onOpenHtml?.(p)}
                            onReviewAll={(files) => onReviewChanges?.(files)}
                          />
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  )
                }
                const align = item.role === "user" ? "end" : "start"
                return (
                  <MessageScrollerItem key={item.key} scrollAnchor={isLast}>
                    <Message align={align}>
                      <MessageContent>
                        <Bubble
                          align={align}
                          variant={item.role === "user" ? "default" : "muted"}
                        >
                          <BubbleContent
                            className={cn(
                              item.role === "user" && "whitespace-pre-wrap"
                            )}
                          >
                            {item.role === "assistant" ? (
                              <Markdown content={item.content} />
                            ) : (
                              item.content
                            )}
                          </BubbleContent>
                        </Bubble>
                      </MessageContent>
                    </Message>
                  </MessageScrollerItem>
                )
              })}

              {/* The in-flight assistant turn: text and tool activity rendered in
                  the order they streamed (interleaved via segments), so it reads
                  the same live as it does once settled. "Thinking…" fills the gap
                  before the first event. */}
              {loading && (
                <MessageScrollerItem key="live" scrollAnchor>
                  <Message align="start">
                    <MessageContent>
                      {liveSegments.map((seg, si) =>
                        seg.kind === "tools" ? (
                          <div key={`s${si}`}>
                            <ToolGroup calls={seg.calls} />
                            <ChangedFilesBar
                              calls={seg.calls}
                              workspace={workspace.trim()}
                              onOpenHtml={(p) => onOpenHtml?.(p)}
                              onReviewAll={(files) => onReviewChanges?.(files)}
                            />
                          </div>
                        ) : seg.text ? (
                          <Bubble key={`s${si}`} align="start" variant="muted">
                            <BubbleContent>
                              <Markdown content={seg.text} />
                            </BubbleContent>
                          </Bubble>
                        ) : null
                      )}
                      {liveSegments.length === 0 && (
                        <Marker>
                          <MarkerIcon>
                            <Spinner />
                          </MarkerIcon>
                          <MarkerContent>Thinking…</MarkerContent>
                        </Marker>
                      )}
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          {/* Scroll-to-bottom button — self-manages its visibility. */}
          <MessageScrollerButton direction="end" />
        </MessageScroller>
      </MessageScrollerProvider>

      {/* Composer — with the pending approval or question prompt popped out just
          above it, so it stays in one fixed place regardless of transcript
          scrolling. Gating is sequential, so these are mutually exclusive. */}
      <div className="border-t bg-background">
        <div className="mx-auto w-full max-w-[min(90%,72rem)] px-4 py-4">
          {pendingApproval && (
            <div className="mb-3 animate-in duration-200 fade-in-0 slide-in-from-bottom-4">
              <ApprovalCard
                approval={pendingApproval}
                onApproval={resolveApproval}
              />
            </div>
          )}
          {liveQuestion && (
            <div className="mb-3 animate-in duration-200 fade-in-0 slide-in-from-bottom-4">
              <QuestionPanel
                questions={liveQuestion.questions}
                onSubmit={answerQuestion}
                onCancel={questionCancellable ? cancelQuestion : undefined}
              />
            </div>
          )}
          {composer}
        </div>
      </div>
    </div>
  )
}
