import { useEffect, useRef, useState } from "react"
import { ArrowDown, ArrowUp, FolderOpen, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Markdown } from "@/components/markdown"
import { VIEW_TO_MODE, type View } from "@/components/sidebar"
import type { Message } from "@/types"
import { cn } from "@/lib/utils"

interface ChatMessage {
  role: "user" | "assistant"
  content: string
}

// Shows only the last segment of a path, e.g. "/Users/me/perficient" -> "perficient".
function lastSegment(path: string) {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/)
  return parts[parts.length - 1] || path
}

// Map stored messages to the renderer's two-bubble shape: only user and
// non-empty assistant text rows are shown. Tool rows and tool-call-only
// assistant rows stay in the DB (for the LLM) but aren't rendered.
function toChatMessages(rows: Message[]): ChatMessage[] {
  return rows
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        !!m.content &&
        m.content.trim().length > 0
    )
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content! }))
}

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
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [tool, setTool] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  // The conversation the panel is currently showing. Used to ignore a settling
  // turn's reconcile if the user switched conversations mid-stream.
  const viewingRef = useRef<string | null>(conversationId)
  // Chat needs only a message (a file is optional); the workspace views need a
  // selected folder as well.
  const canSend =
    !!message.trim() && !loading && (isChat || !!workspace.trim())

  const scrollToBottom = (behavior: ScrollBehavior = "smooth") =>
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior })

  // Track whether the user is at (or near) the bottom. Scrolling up sets this
  // false, which cancels auto-scroll; scrolling back down re-enables it.
  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setAtBottom(distance < 80)
  }

  // Auto-scroll to follow new content, but only while the user is pinned to the
  // bottom — never yank them back up if they've scrolled away to read.
  useEffect(() => {
    if (atBottom) scrollToBottom()
  }, [messages, loading, atBottom])

  // Load the active conversation when it changes. A null id is a fresh,
  // not-yet-created conversation: clear the panel. Otherwise reload its stored
  // messages and linked workspace (so reopening restores both).
  useEffect(() => {
    let cancelled = false
    viewingRef.current = conversationId
    if (!conversationId) {
      setMessages([])
      setWorkspace("")
      setAttachments([])
      return
    }
    Promise.all([
      window.cowork.db.messages.list(conversationId),
      window.cowork.db.conversations.get(conversationId),
    ]).then(async ([rows, convo]) => {
      if (cancelled) return
      setMessages(toChatMessages(rows))
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
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: error instanceof Error ? error.message : "Picker failed" },
      ])
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
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: error instanceof Error ? error.message : "Picker failed" },
      ])
    }
  }

  function removeAttachment(path: string) {
    setAttachments((prev) => prev.filter((p) => p !== path))
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

    // Append the user message and an empty assistant bubble to stream into.
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ])
    setMessage("")
    setAttachments([])
    setLoading(true)
    // Sending re-engages auto-scroll so the user follows their own message,
    // even if they'd scrolled up while reading earlier replies.
    setAtBottom(true)
    setTool(null)

    // Append a streamed token to the last (assistant) bubble.
    const appendToLast = (delta: string) =>
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, content: last.content + delta }
        return next
      })

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
            appendToLast(event.delta)
          } else if (event.type === "tool") {
            setTool(event.phase === "start" ? event.name : null)
          }
        }
      )
      // On error (or if nothing streamed), fill the bubble with the final text.
      if (data.error) {
        appendToLast(`Error: ${data.error}`)
      } else if (data.content) {
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          if (!last.content) next[next.length - 1] = { ...last, content: data.content! }
          return next
        })
      }
    } catch (error) {
      appendToLast(error instanceof Error ? error.message : "Request failed")
    } finally {
      setLoading(false)
      setTool(null)
      // Reconcile the optimistic bubbles with the persisted transcript so the
      // rendered text matches storage exactly — but only if the user is still
      // viewing this conversation (for an existing one). A freshly created
      // conversation is promoted to active just below, which reloads anyway.
      const stillViewing = isNew || viewingRef.current === convoId
      if (stillViewing) {
        try {
          const rows = await window.cowork.db.messages.list(convoId)
          if (viewingRef.current === convoId || isNew) setMessages(toChatMessages(rows))
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

  // Before the first message is sent, an empty session shows the composer
  // centered (an inviting "start typing" state). Once there are messages it
  // moves to its usual bottom-pinned position.
  const isEmpty = messages.length === 0

  // The composer (attachment chips + input box). Rendered both centered and
  // bottom-pinned, so it's defined once here.
  const composer = (
    <>
      {/* Attachment chips (Chat only) — removable, shown above the input. */}
      {isChat && attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((path) => (
            <span
              key={path}
              className="flex items-center gap-1 rounded-md border bg-muted px-2 py-1 text-xs text-foreground"
              title={path}
            >
              <span className="max-w-40 truncate">{lastSegment(path)}</span>
              <button
                type="button"
                onClick={() => removeAttachment(path)}
                aria-label={`Remove ${lastSegment(path)}`}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
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
          <Button
            type="button"
            size="icon"
            onClick={sendMessage}
            disabled={!canSend}
            className="size-8 rounded-full"
          >
            <ArrowUp className="size-4" />
          </Button>
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
      {/* Conversation (the window drag bar lives in Shell, above this column) */}
      <div ref={scrollRef} onScroll={handleScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[min(90%,72rem)] flex-col gap-4 px-4 py-6">
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1
            // The streaming assistant bubble shows a status until tokens arrive.
            const pending = m.role === "assistant" && !m.content && isLast && loading
            return (
              <div
                key={i}
                className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                    m.role === "user"
                      ? "bg-primary text-primary-foreground whitespace-pre-wrap"
                      : "bg-muted text-foreground",
                    pending && "text-muted-foreground"
                  )}
                >
                  {pending ? (
                    tool ? (
                      `Using ${tool}…`
                    ) : (
                      "Thinking…"
                    )
                  ) : m.role === "assistant" ? (
                    <Markdown content={m.content} />
                  ) : (
                    m.content
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Scroll-to-bottom button — shown only when the user has scrolled up. */}
      {!atBottom && messages.length > 0 && (
        <button
          type="button"
          onClick={() => scrollToBottom()}
          aria-label="Scroll to bottom"
          className="absolute bottom-32 left-1/2 z-10 -translate-x-1/2 rounded-full border bg-background p-2 text-muted-foreground shadow-md transition-colors hover:text-foreground"
        >
          <ArrowDown className="size-4" />
        </button>
      )}

      {/* Composer */}
      <div className="border-t bg-background">
        <div className="mx-auto w-full max-w-[min(90%,72rem)] px-4 py-4">{composer}</div>
      </div>
    </div>
  )
}
