import { useEffect, useRef, useState } from "react"
import { ArrowUp, FileText, FolderOpen, Plus, Square, X } from "lucide-react"
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
import {
  buildTimeline,
  toToolUse,
  isErrorResult,
  baseName as lastSegment,
  type TimelineItem,
  type ToolUse,
} from "@/lib/timeline"
import { cn } from "@/lib/utils"

export default function App({
  view,
  conversationId,
  onConversationCreated,
  onConversationChanged,
}: {
  view: View
  conversationId: string | null
  onConversationCreated: (id: string) => void
  onConversationChanged: () => void
}) {
  // Chat runs without a workspace and attaches files instead; North Star and
  // Interactive are workspace-backed and share the same behavior.
  const isChat = view === "Chat"

  const [workspace, setWorkspace] = useState("")
  const [attachments, setAttachments] = useState<string[]>([])
  const [message, setMessage] = useState("")
  // The persisted transcript, rebuilt from stored rows (text bubbles + tool
  // groups, interleaved in order). Live in-flight state is held separately.
  const [timeline, setTimeline] = useState<TimelineItem[]>([])
  const [loading, setLoading] = useState(false)
  // The in-flight assistant turn: streamed text and the tool calls as they run.
  // Rendered live, then replaced by the reconciled `timeline` when the turn ends.
  const [liveText, setLiveText] = useState("")
  const [liveTools, setLiveTools] = useState<ToolUse[]>([])

  // The conversation the panel is currently showing. Used to ignore a settling
  // turn's reconcile if the user switched conversations mid-stream.
  const viewingRef = useRef<string | null>(conversationId)
  // The conversation whose turn is currently in flight (set in sendMessage,
  // which may create the conversation lazily). The Stop button cancels this one.
  const inFlightRef = useRef<string | null>(null)
  // Chat needs only a message (a file is optional); the workspace views need a
  // selected folder as well.
  const canSend =
    !!message.trim() && !loading && (isChat || !!workspace.trim())

  // Load the active conversation when it changes. A null id is a fresh,
  // not-yet-created conversation: clear the panel. Otherwise reload its stored
  // messages and linked workspace (so reopening restores both).
  useEffect(() => {
    let cancelled = false
    viewingRef.current = conversationId
    setLiveText("")
    setLiveTools([])
    if (!conversationId) {
      setTimeline([])
      setWorkspace("")
      setAttachments([])
      return
    }
    Promise.all([
      window.cowork.db.messages.list(conversationId),
      window.cowork.db.conversations.get(conversationId),
    ]).then(async ([rows, convo]) => {
      if (cancelled) return
      setTimeline(buildTimeline(rows))
      setAttachments([])
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
    setLiveTools((prev) =>
      prev.map((t) =>
        t.approval?.requestId === requestId
          ? { ...t, approval: { ...t.approval, status: decision } }
          : t
      )
    )
    void window.cowork.chatApprove({ requestId, decision, remember })
  }

  async function sendMessage() {
    if (!canSend) return
    const text = message.trim()
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
      })
      convoId = convo.id
      isNew = true
    }

    // Optimistically append the user message; the assistant turn renders from
    // the transient live state below until the turn settles and reconciles.
    setTimeline((prev) => [
      ...prev,
      { kind: "text", key: `local-${convoId}-${prev.length}`, role: "user", content: text },
    ])
    setMessage("")
    setAttachments([])
    setLiveText("")
    setLiveTools([])
    setLoading(true)
    inFlightRef.current = convoId

    try {
      const data = await window.cowork.chat(
        {
          conversationId: convoId,
          message: text,
          // Chat sends no workspace and inlines attachments instead.
          workspace: isChat ? undefined : workspace.trim(),
          attachments: isChat ? sentAttachments : undefined,
        },
        (event) => {
          if (event.type === "token") {
            setLiveText((s) => s + event.delta)
          } else if (event.type === "tool" && event.phase === "start") {
            // A tool started — add a running row (label derived from its args).
            setLiveTools((prev) => [
              ...prev,
              toToolUse({ id: event.id, name: event.name, arguments: event.arguments }),
            ])
          } else if (event.type === "tool" && event.phase === "done") {
            // Its result arrived — attach it, clear any approval card, and flip
            // status (matched by id).
            setLiveTools((prev) =>
              prev.map((t) =>
                t.id === event.id
                  ? {
                      ...t,
                      result: event.result,
                      status: isErrorResult(event.result) ? "error" : "done",
                      approval: undefined,
                    }
                  : t
              )
            )
          } else if (event.type === "approval") {
            // The agent is paused waiting on a human decision — attach a pending
            // approval card to the matching (already-running) tool row.
            setLiveTools((prev) =>
              prev.map((t) =>
                t.id === event.id
                  ? {
                      ...t,
                      approval: {
                        requestId: event.requestId,
                        summary: event.summary,
                        reason: event.reason,
                        status: "pending",
                      },
                    }
                  : t
              )
            )
          }
        }
      )
      // Surface the final text/error in the live bubble. An error is APPENDED
      // (not `s || …`) so it shows even after a preamble already streamed —
      // otherwise a turn that ends mid-work after some text would stop silently.
      // (Transient — immediately superseded by the reconcile below, which now
      // also reads the persisted error note.)
      if (data.error) {
        setLiveText((s) => (s ? `${s}\n\n⚠️ ${data.error}` : `Error: ${data.error}`))
      } else if (data.stopped) {
        // Clean user cancel — the "⏹ Stopped by user." note is persisted and
        // shown by the reconcile below; append a transient marker meanwhile.
        setLiveText((s) => (s ? `${s}\n\n⏹ Stopped` : "⏹ Stopped"))
      } else if (data.content) {
        setLiveText((s) => s || data.content!)
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Request failed"
      setLiveText((s) => (s ? `${s}\n\n⚠️ ${msg}` : msg))
    } finally {
      setLoading(false)
      inFlightRef.current = null
      // Reconcile the live turn with the persisted transcript so the rendered
      // content matches storage exactly — but only if the user is still viewing
      // this conversation. A freshly created one is promoted to active just
      // below, which reloads anyway.
      const stillViewing = isNew || viewingRef.current === convoId
      if (stillViewing) {
        try {
          const rows = await window.cowork.db.messages.list(convoId)
          if (viewingRef.current === convoId || isNew) {
            setTimeline(buildTimeline(rows))
            setLiveText("")
            setLiveTools([])
          }
        } catch {
          // Keep the optimistic view if the reconcile read fails.
        }
      }
      // Promote a freshly created conversation to active (also refreshes the
      // sidebar so its title appears); otherwise just refresh ordering/title.
      if (isNew) onConversationCreated(convoId)
      else onConversationChanged()
    }
  }

  // Cancel the in-flight turn. The main process aborts the LLM stream and
  // resolves chat() with `{ stopped: true }`, which unwinds sendMessage's
  // finally (reconcile + loading reset) normally.
  function stopMessage() {
    const id = inFlightRef.current
    if (id) window.cowork.chatStop(id)
  }

  // Before the first message is sent, an empty session shows the composer
  // centered (an inviting "start typing" state). Once there are messages it
  // moves to its usual bottom-pinned position.
  const isEmpty = timeline.length === 0 && !loading

  // Sequential gating means at most one approval is pending at a time, so a
  // single panel above the composer suffices. Purely derived — it disappears
  // automatically when resolved, when the tool completes, or when the turn ends.
  const pendingApproval = liveTools.find((t) => t.approval?.status === "pending")?.approval

  // The composer (attachment chips + input box). Rendered both centered and
  // bottom-pinned, so it's defined once here.
  const composer = (
    <>
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
      <div className="rounded-2xl border border-input bg-transparent focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              sendMessage()
            }
          }}
          rows={2}
          placeholder="Send a message…"
          className="field-sizing-content max-h-[24.25rem] w-full resize-none bg-transparent px-4 py-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between px-2.5 pb-2.5">
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
            <button
              type="button"
              onClick={pickWorkspace}
              title="Select workspace folder"
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <FolderOpen className="size-4" />
              {workspace && <span className="max-w-40 truncate">{lastSegment(workspace)}</span>}
            </button>
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
                <p className="font-medium text-foreground">Cowork</p>
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
              {timeline.map((item, i) => {
                const isLast = i === timeline.length - 1 && !loading
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
                            className={cn(item.role === "user" && "whitespace-pre-wrap")}
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

      {/* Composer — with the pending approval prompt popped out just above it,
          so it stays in one fixed place regardless of transcript scrolling. */}
      <div className="border-t bg-background">
        <div className="mx-auto w-full max-w-[min(90%,72rem)] px-4 py-4">
          {pendingApproval && (
            <div className="mb-3 animate-in fade-in-0 slide-in-from-bottom-4 duration-200">
              <ApprovalCard approval={pendingApproval} onApproval={resolveApproval} />
            </div>
          )}
          {composer}
        </div>
      </div>
    </div>
  )
}
