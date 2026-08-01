import { useCallback, useEffect, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import {
  ArrowUp,
  BrainCircuit,
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
} from "@/lib/timeline"
import { cn } from "@/lib/utils"
import type {
  Question,
  QuestionAnswer,
  LlmSettings,
  AccountWithModels,
  SkillSummary,
  PickedElement,
} from "@/types"

// The live, in-flight state of one streaming turn, held per-conversation in
// `liveTurns` until the turn settles and reconciles into the persisted timeline.
// A pending approval lives inside `tools` (on the matching call's `approval`),
// so restoring a switched-away turn restores its approval card too.
interface LiveTurn {
  text: string
  tools: ToolUse[]
  question: { requestId: string; questions: Question[] } | null
}
const EMPTY_LIVE: LiveTurn = { text: "", tools: [], question: null }

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
  onConversationCreated,
  onConversationChanged,
  onOpenSettings,
  settingsOpen,
  rightPanelOpen,
  onRanInBackground,
  onRunningConvosChange,
  onWaitingConvosChange,
}: {
  view: View
  conversationId: string | null
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

  const [workspace, setWorkspace] = useState("")
  // Current git branch for the selected workspace folder, or null when not a
  // git repo (or no folder is selected). Shown as a small badge next to the
  // folder name in the Interactive / North Star composer.
  const [gitBranch, setGitBranch] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<string[]>([])
  const [message, setMessage] = useState("")
  // An element the user picked in the agent browser ("point at this button").
  // Held as a pending chip above the composer and prepended to the next message
  // on Send, then cleared. Null when nothing is pending.
  const [pickedElement, setPickedElement] = useState<PickedElement | null>(null)
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
        turn.tools.some((t) => t.approval?.status === "pending")
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
  const hasLlm = !!effAccountId && !!effModelId
  // Chat needs only a message (a file is optional); the workspace views need a
  // selected folder as well. All views need an LLM selection.
  const canSend =
    !!message.trim() && !loading && hasLlm && (isChat || !!workspace.trim())

  // Subscribe to elements picked in the agent browser (pick mode). The latest
  // pick replaces any pending one — a single chip, not a list. Cleared on Send
  // (prepended to the message) or via the chip's remove button.
  useEffect(() => {
    return window.cowork.onBrowserElementPicked((element) => {
      setPickedElement(element)
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
    // Switching to a different conversation no longer wipes any live state: each
    // streaming turn's text/tools/approval/question is held per-conversation in
    // `liveTurns` and rendered by looking up the id on screen. Leaving a turn that
    // is still streaming (or parked on an approval gate) and returning to it now
    // restores its live buffers — including the pending approval card — instead of
    // stranding it as a perpetual "Thinking…" spinner with no way to respond.
    if (!conversationId) {
      setTimeline([])
      setWorkspace("")
      setAttachments([])
      // A fresh conversation starts from the default selection (null = inherit).
      setSelAccountId(null)
      setSelModelId(null)
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
      if (convo?.workspaceId) {
        const ws = await window.cowork.db.workspaces.list()
        const match = ws.find((w) => w.id === convo.workspaceId)
        if (!cancelled) setWorkspace(match?.path ?? "")
      } else {
        setWorkspace("")
      }
    })
    return () => {
      cancelled = true
    }
  }, [conversationId])

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

  // Fetch the git branch for the current workspace folder. Clears when the
  // folder is deselected or when it's not a git repo.
  useEffect(() => {
    const path = workspace.trim()
    if (!path || isChat) {
      setGitBranch(null)
      return
    }
    let cancelled = false
    window.cowork.git.branch(path).then((branch) => {
      if (!cancelled) setGitBranch(branch)
    }).catch(() => {
      if (!cancelled) setGitBranch(null)
    })
    return () => {
      cancelled = true
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
    remember?: "workspace"
  ) {
    // The card is only shown for the conversation on screen, so flip its status
    // in that conversation's live turn (matched by requestId).
    if (conversationId) {
      updateLive(conversationId, (turn) => ({
        ...turn,
        tools: turn.tools.map((t) =>
          t.approval?.requestId === requestId
            ? { ...t, approval: { ...t.approval, status: decision } }
            : t
        ),
      }))
    }
    void window.cowork.chatApprove({ requestId, decision, remember })
  }

  async function sendMessage() {
    if (!canSend) return
    // Expand confirmed mention tokens before sending, so the model reliably
    // reads them: `/git-commit` → `git-commit skill`, `@src/foo.ts` → `src/foo.ts`.
    // The expanded text is also what's shown in the optimistic timeline, so the
    // transcript matches what the agent received.
    const base = expandMentions(message, confirmedMentions).trim()
    // Prepend a picked-element descriptor (if any) so the agent knows exactly
    // which on-page element the user is pointing at. It can act on it two ways:
    // edit the source that renders it (grep the selector/text), or
    // browser_snapshot + match the role/name to click it.
    const text = pickedElement
      ? `${formatPickedElement(pickedElement)}\n\n${base}`
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
        // Persist the chosen model on the new conversation. Null means "inherit
        // the default" — only store an explicit pick that differs from default.
        accountId: selAccountId,
        modelId: selModelId,
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
    setPickedElement(null)
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
        },
        // Events always route into THIS turn's own per-conversation live buffer
        // (keyed by turnConvoId), regardless of what's on screen. The render layer
        // decides what to show by looking up the viewed conversation's entry, so a
        // turn that keeps streaming after the user switches away no longer loses
        // its tokens/tools/approval — they're preserved and restored on return.
        (event) => {
          if (event.type === "token") {
            updateLive(turnConvoId, (turn) => ({
              ...turn,
              text: turn.text + event.delta,
            }))
          } else if (event.type === "tool" && event.phase === "start") {
            // A tool started — add a running row (label derived from its args).
            updateLive(turnConvoId, (turn) => ({
              ...turn,
              tools: [
                ...turn.tools,
                toToolUse({
                  id: event.id,
                  name: event.name,
                  arguments: event.arguments,
                }),
              ],
            }))
          } else if (event.type === "tool" && event.phase === "done") {
            // Its result arrived — attach it, clear any approval card, and flip
            // status (matched by id).
            updateLive(turnConvoId, (turn) => ({
              ...turn,
              tools: turn.tools.map((t) =>
                t.id === event.id
                  ? {
                      ...t,
                      result: event.result,
                      status: isErrorResult(event.result) ? "error" : "done",
                      approval: undefined,
                    }
                  : t
              ),
            }))
          } else if (event.type === "approval") {
            // The agent is paused waiting on a human decision — attach a pending
            // approval card to the matching (already-running) tool row.
            updateLive(turnConvoId, (turn) => ({
              ...turn,
              tools: turn.tools.map((t) =>
                t.id === event.id
                  ? {
                      ...t,
                      approval: {
                        requestId: event.requestId,
                        summary: event.summary,
                        reason: event.reason,
                        status: "pending",
                        kind: event.kind,
                      },
                    }
                  : t
              ),
            }))
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
          }
        }
      )
      // Surface the final text/error in this turn's live bubble. An error is
      // APPENDED (not `s || …`) so it shows even after a preamble already streamed
      // — otherwise a turn that ends mid-work after some text would stop silently.
      // (Transient — immediately superseded by the reconcile below, which also
      // reads the persisted error note.)
      if (data.error) {
        updateLive(turnConvoId, (turn) => ({
          ...turn,
          text: turn.text
            ? `${turn.text}\n\n⚠️ ${data.error}`
            : `Error: ${data.error}`,
        }))
      } else if (data.stopped) {
        // Clean user cancel — the "⏹ Stopped by user." note is persisted and
        // shown by the reconcile below; append a transient marker meanwhile.
        updateLive(turnConvoId, (turn) => ({
          ...turn,
          text: turn.text ? `${turn.text}\n\n⏹ Stopped` : "⏹ Stopped",
        }))
      } else if (data.content) {
        updateLive(turnConvoId, (turn) => ({
          ...turn,
          text: turn.text || data.content!,
        }))
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Request failed"
      updateLive(turnConvoId, (turn) => ({
        ...turn,
        text: turn.text ? `${turn.text}\n\n⚠️ ${msg}` : msg,
      }))
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
        accountId: selAccountId,
        modelId: selModelId,
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
  const liveText = liveTurn?.text ?? ""
  const liveTools = liveTurn?.tools ?? []
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

  // The composer's model picker. Spans every provider's models (grouped by
  // provider) in a type-to-filter combobox, so a session can switch provider+model
  // inline without visiting Settings. The choice is per-conversation: persisted
  // onto the conversation row if it exists, else held in state and carried into
  // create() on first send. Each item value encodes account + model
  // (`accountId::modelId`) to disambiguate the same model id across providers.
  // When nothing is configured it's a button to Settings → Providers.
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
  const modelPicker = hasLlm ? (
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
      onClick={() => onOpenSettings("providers")}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      Configure model…
    </button>
  )

  // Icon-only model picker shown when the right panel is open (squeezes the
  // toolbar). Uses the same Combobox but renders only the BrainCircuit icon;
  // the selected model name appears as a native tooltip.
  const modelPickerCompact = hasLlm ? (
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
      title="Configure model"
      onClick={() => onOpenSettings("providers")}
      className="flex items-center rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <BrainCircuit className="size-4" />
    </button>
  )

  // The composer (attachment chips + input box). Rendered both centered and
  // bottom-pinned, so it's defined once here.
  const composer = (
    <>
      {/* Picked browser element — removable chip, prepended to the next message. */}
      {pickedElement && (
        <AttachmentGroup className="mb-2">
          <Attachment
            size="sm"
            title={formatPickedElement(pickedElement)}
          >
            <AttachmentMedia variant="icon">
              <MousePointerClick />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>
                {pickedElementLabel(pickedElement)}
              </AttachmentTitle>
            </AttachmentContent>
            <AttachmentActions>
              <AttachmentAction
                onClick={() => setPickedElement(null)}
                aria-label="Remove picked element"
              >
                <X />
              </AttachmentAction>
            </AttachmentActions>
          </Attachment>
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
                <button
                  type="button"
                  onClick={pickWorkspace}
                  title={workspace ? lastSegment(workspace) : "Select workspace folder"}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <FolderOpen className="size-4" />
                  {workspace && !rightPanelOpen && (
                    <span className="max-w-40 truncate">
                      {lastSegment(workspace)}
                    </span>
                  )}
                </button>
                {gitBranch && !rightPanelOpen && (
                  <span title={gitBranch} className="flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    <GitBranch className="size-3 shrink-0" />
                    <span>{gitBranch}</span>
                  </span>
                )}
                {gitBranch && rightPanelOpen && (
                  <span title={gitBranch} className="flex items-center rounded bg-accent p-1 text-muted-foreground">
                    <GitBranch className="size-3" />
                  </span>
                )}
              </>
            )}
            {!rightPanelOpen && modelPicker}
            {rightPanelOpen && modelPickerCompact}
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
            {isChat ? (
              <>
                <p className="font-medium text-foreground">Chat</p>
                <p>Ask anything. Attach files with the + button.</p>
              </>
            ) : (
              <>
                <p className="font-medium text-foreground">North Star</p>
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
    <div className="relative flex h-svh w-full flex-col overflow-hidden">
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

              {/* The in-flight assistant turn: tool activity, then streamed text,
                  with a "Thinking…" status for the gap before the first event. */}
              {loading && (
                <MessageScrollerItem key="live" scrollAnchor>
                  <Message align="start">
                    <MessageContent>
                      {liveTools.length > 0 && <ToolGroup calls={liveTools} />}
                      {liveText ? (
                        <Bubble align="start" variant="muted">
                          <BubbleContent>
                            <Markdown content={liveText} />
                          </BubbleContent>
                        </Bubble>
                      ) : liveTools.length === 0 ? (
                        <Marker>
                          <MarkerIcon>
                            <Spinner />
                          </MarkerIcon>
                          <MarkerContent>Thinking…</MarkerContent>
                        </Marker>
                      ) : null}
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
              />
            </div>
          )}
          {composer}
        </div>
      </div>
    </div>
  )
}
