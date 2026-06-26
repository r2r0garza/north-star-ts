import { useEffect, useRef, useState } from "react"
import { Plus } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import type { Conversation, Mode } from "@/types"

export const VIEWS = ["Chat", "Interactive", "North Star"] as const
export type View = (typeof VIEWS)[number]

// Mapping between the view label and the persisted conversation mode.
export const VIEW_TO_MODE: Record<View, Mode> = {
  Chat: "chat",
  Interactive: "interactive",
  "North Star": "north_star",
}
export const MODE_TO_VIEW: Record<Mode, View> = {
  chat: "Chat",
  interactive: "Interactive",
  north_star: "North Star",
}

// Label for the "+ New" button per view.
const NEW_LABEL: Record<View, string> = {
  Chat: "+ New Chat",
  Interactive: "+ New Session",
  "North Star": "+ New Task",
}

// A single session row. Right-click opens a context menu with Rename (inline
// edit) and Delete. Both persist to the DB and update the in-memory list.
function SessionRow({
  conversation,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: {
  conversation: Conversation
  isActive: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conversation.title ?? "")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  function startRename() {
    setDraft(conversation.title ?? "")
    setEditing(true)
  }

  function commit() {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== conversation.title) onRename(next)
  }

  if (editing) {
    return (
      <SidebarMenuItem>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            } else if (e.key === "Escape") {
              e.preventDefault()
              setEditing(false)
            }
          }}
          className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </SidebarMenuItem>
    )
  }

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarMenuButton
            isActive={isActive}
            onClick={onSelect}
            title={conversation.title ?? "Untitled"}
          >
            <span className="truncate">{conversation.title ?? "Untitled"}</span>
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={startRename}>Rename</ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={onDelete}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </SidebarMenuItem>
  )
}

export function AppSidebar({
  view,
  onViewChange,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onConversationDeleted,
  refreshKey,
}: {
  view: View
  onViewChange: (view: View) => void
  activeConversationId: string | null
  onSelectConversation: (id: string, mode: Mode) => void
  onNewConversation: () => void
  onConversationDeleted: (id: string) => void
  // Bumped by the app whenever conversations change, so the list refetches.
  refreshKey: number
}) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  // The conversation awaiting delete confirmation, if any. Set by a row's
  // Delete action; cleared on confirm or cancel.
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null)

  useEffect(() => {
    let cancelled = false
    window.cowork.db.conversations.list().then((rows) => {
      if (!cancelled) setConversations(rows)
    })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  // Conversations for the active view's mode, most-recent first (the repo
  // already orders by updated_at DESC).
  const mode = VIEW_TO_MODE[view]
  const items = conversations.filter((c) => c.mode === mode)

  async function renameConversation(id: string, title: string) {
    // Optimistic update, then persist.
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
    await window.cowork.db.conversations.update(id, { title })
  }

  async function confirmDelete() {
    const target = pendingDelete
    if (!target) return
    setPendingDelete(null)
    // Optimistic removal from the list, then persist + notify the shell (which
    // clears the active conversation if it was the one deleted).
    setConversations((prev) => prev.filter((c) => c.id !== target.id))
    await window.cowork.db.conversations.delete(target.id)
    onConversationDeleted(target.id)
  }

  return (
    <Sidebar>
      {/* Top padding clears the macOS traffic lights / sidebar toggle. Window
          dragging is handled by the top bar in Shell, not here — a drag region
          on the header would swallow the toggle button's clicks. */}
      <SidebarHeader className="h-12" />
      {/* View switcher — Chat / Interactive / North Star. */}
      <div className="px-2 pb-2">
        <ButtonGroup className="w-full">
          {VIEWS.map((v) => (
            <Button
              key={v}
              type="button"
              size="sm"
              variant={view === v ? "default" : "outline"}
              onClick={() => onViewChange(v)}
              className="flex-1"
            >
              {v}
            </Button>
          ))}
        </ButtonGroup>
      </div>
      {/* "+ New" — label depends on the active view. */}
      <div className="px-2 pb-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onNewConversation}
          className="w-full justify-start"
        >
          <Plus className="size-4" />
          {NEW_LABEL[view].replace(/^\+ /, "")}
        </Button>
      </div>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{view}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  No conversations yet.
                </p>
              )}
              {items.map((c) => (
                <SessionRow
                  key={c.id}
                  conversation={c}
                  isActive={c.id === activeConversationId}
                  onSelect={() => onSelectConversation(c.id, c.mode)}
                  onRename={(title) => renameConversation(c.id, title)}
                  onDelete={() => setPendingDelete(c)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter />

      {/* Confirmation before deleting a session — deletion is irreversible. */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this session?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.title ?? "Untitled"}” and all of its messages will
              be permanently deleted. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sidebar>
  )
}
