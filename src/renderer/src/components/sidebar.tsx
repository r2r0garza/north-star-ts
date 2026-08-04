import { useCallback, useEffect, useRef, useState } from "react"
import {
  BellDot,
  BookOpen,
  ChevronRight,
  FolderPlus,
  MoreHorizontal,
  Plus,
  Settings,
} from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { ProjectDialog } from "@/components/project-dialog"
import type { Conversation, Mode, Project, Workspace } from "@/types"

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
  Chat: "New Chat",
  Interactive: "New Session",
  "North Star": "New Task",
}

// A single session row. Right-click opens a context menu with Rename (inline
// edit) and Delete. Both persist to the DB and update the in-memory list.
function SessionRow({
  conversation,
  isActive,
  isRunning,
  isWaiting,
  moveTargets,
  onSelect,
  onRename,
  onDelete,
  onMoveToProject,
}: {
  conversation: Conversation
  isActive: boolean
  // A turn is currently streaming in this conversation — show a spinner.
  isRunning: boolean
  // The turn is blocked waiting on the user (approval/question/handoff) — show a
  // "needs you" indicator. Takes precedence over the spinner: while blocked the
  // turn is still technically running, but the user needs to act, not wait.
  isWaiting: boolean
  // Projects this conversation can be added to (excludes its current one and, for
  // workspace-view conversations, any project without a directory).
  moveTargets: Project[]
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
  // Move the conversation to a project, or null to remove it from its project.
  onMoveToProject: (projectId: string | null) => void
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
            {isWaiting ? (
              // Needs-you indicator — takes precedence over the spinner. Amber +
              // a subtle pulse so a blocked conversation stands out in the list.
              <BellDot
                className="ml-auto size-3.5 shrink-0 animate-pulse text-amber-500"
                aria-label="Waiting for your input"
              />
            ) : (
              isRunning && (
                <Spinner className="ml-auto size-3.5 text-muted-foreground" />
              )
            )}
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={startRename}>Rename</ContextMenuItem>
          {conversation.projectId ? (
            <ContextMenuItem onSelect={() => onMoveToProject(null)}>
              Remove from project
            </ContextMenuItem>
          ) : moveTargets.length > 0 ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger>Add to project</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {moveTargets.map((p) => (
                  <ContextMenuItem
                    key={p.id}
                    onSelect={() => onMoveToProject(p.id)}
                  >
                    <span className="truncate">{p.name}</span>
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={onDelete}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </SidebarMenuItem>
  )
}

// A collapsible group of conversations for one project (or the "No Project"
// bucket when `project` is null). The header carries a "+" to start a new
// conversation in the group and — for real projects — an Edit/Delete menu.
function ProjectSection({
  project,
  label,
  conversations,
  canCreate,
  createHint,
  moveTargetsFor,
  activeConversationId,
  runningConvos,
  waitingConvos,
  onNewConversation,
  onSelectConversation,
  onRenameConversation,
  onDeleteConversation,
  onMoveToProject,
  onEditProject,
  onDeleteProject,
}: {
  // The project this section represents, or null for the "No Project" bucket.
  project: Project | null
  label: string
  conversations: Conversation[]
  // Whether a new conversation can be created in this group for the active view
  // (Chat: always; Interactive/North Star: only projects with a directory).
  canCreate: boolean
  // Tooltip shown on the disabled "+" explaining why creation is blocked.
  createHint?: string
  // The projects a given conversation can be added to (excludes its current one
  // and, for workspace views, directory-less projects).
  moveTargetsFor: (conversation: Conversation) => Project[]
  activeConversationId: string | null
  runningConvos: Set<string>
  waitingConvos: Set<string>
  onNewConversation: () => void
  onSelectConversation: (id: string, mode: Mode) => void
  onRenameConversation: (id: string, title: string) => void
  onDeleteConversation: (conversation: Conversation) => void
  onMoveToProject: (id: string, projectId: string | null) => void
  onEditProject?: () => void
  onDeleteProject?: () => void
}) {
  return (
    <Collapsible defaultOpen className="group/section">
      <SidebarGroup className="py-1">
        <div className="flex items-center gap-1 px-2">
          <CollapsibleTrigger className="flex flex-1 items-center gap-1 overflow-hidden text-xs font-medium text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/section:rotate-90" />
            <span className="truncate" title={label}>
              {label}
            </span>
          </CollapsibleTrigger>
          <button
            type="button"
            onClick={onNewConversation}
            disabled={!canCreate}
            title={
              canCreate ? "New conversation" : createHint ?? "Not available"
            }
            aria-label="New conversation"
            className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Plus className="size-3.5" />
          </button>
          {project && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Project options"
                  className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onEditProject}>
                  Edit project
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={onDeleteProject}
                >
                  Delete project
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {conversations.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground/70">
                  No conversations yet.
                </p>
              )}
              {conversations.map((c) => (
                <SessionRow
                  key={c.id}
                  conversation={c}
                  isActive={c.id === activeConversationId}
                  isRunning={runningConvos.has(c.id)}
                  isWaiting={waitingConvos.has(c.id)}
                  moveTargets={moveTargetsFor(c)}
                  onSelect={() => onSelectConversation(c.id, c.mode)}
                  onRename={(title) => onRenameConversation(c.id, title)}
                  onDelete={() => onDeleteConversation(c)}
                  onMoveToProject={(projectId) =>
                    onMoveToProject(c.id, projectId)
                  }
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

export function AppSidebar({
  view,
  onViewChange,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onConversationDeleted,
  onSettingsClick,
  onSkillsClick,
  refreshKey,
  runningConvos,
  waitingConvos,
}: {
  view: View
  onViewChange: (view: View) => void
  activeConversationId: string | null
  onSelectConversation: (id: string, mode: Mode) => void
  // Start a fresh conversation, optionally scoped to a project (its directory is
  // auto-adopted for workspace views). Null/omitted = the "No Project" bucket.
  onNewConversation: (projectId?: string | null) => void
  onConversationDeleted: (id: string) => void
  onSettingsClick: () => void
  onSkillsClick: () => void
  // Bumped by the app whenever conversations change, so the list refetches.
  refreshKey: number
  // Conversations with a turn currently streaming — each shows a spinner.
  runningConvos: Set<string>
  // Conversations blocked waiting on the user (approval/question/handoff) — each
  // shows a "needs you" indicator, which takes precedence over the spinner.
  waitingConvos: Set<string>
}) {
  // The main agent's brand name (MAIN_AGENT_NAME, e.g. "North Star"), read from
  // the synchronous system bridge. Brands the North Star tab's label.
  const agentName = window.cowork.system().mainAgentName
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  // Workspaces, kept so a workspace_id can be resolved to a readable path for the
  // "workspace mismatch" alert below.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  // The conversation awaiting delete confirmation, if any.
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null)
  // The project awaiting delete confirmation, if any.
  const [pendingProjectDelete, setPendingProjectDelete] =
    useState<Project | null>(null)
  // A blocked "add to project" attempt: the conversation and target project
  // work in different directories, so the move is refused with an explanation.
  const [workspaceMismatch, setWorkspaceMismatch] = useState<{
    conversation: Conversation
    project: Project
  } | null>(null)
  // Project create/edit dialog. `editingProject` null = create mode.
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)

  // Fetch conversations + projects together. Re-run on the shell's refreshKey
  // (conversation changes) and after local project CRUD.
  const refetch = useCallback(async () => {
    const [convos, projs, ws] = await Promise.all([
      window.cowork.db.conversations.list(),
      window.cowork.db.projects.list(),
      window.cowork.db.workspaces.list(),
    ])
    setConversations(convos)
    setProjects(projs)
    setWorkspaces(ws)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [convos, projs, ws] = await Promise.all([
        window.cowork.db.conversations.list(),
        window.cowork.db.projects.list(),
        window.cowork.db.workspaces.list(),
      ])
      if (!cancelled) {
        setConversations(convos)
        setProjects(projs)
        setWorkspaces(ws)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  // Conversations for the active view's mode, most-recent first (the repo
  // already orders by updated_at DESC), grouped by project below.
  const mode = VIEW_TO_MODE[view]
  const items = conversations.filter((c) => c.mode === mode)
  const byProject = new Map<string | null, Conversation[]>()
  for (const c of items) {
    const key = c.projectId ?? null
    const list = byProject.get(key)
    if (list) list.push(c)
    else byProject.set(key, [c])
  }
  const noProjectItems = byProject.get(null) ?? []

  // A project can host new conversations in the active view when it's Chat (no
  // directory needed) or it has a directory (workspace-backed views).
  const canCreateInProject = (project: Project) =>
    mode === "chat" || !!project.workspaceId
  const CREATE_HINT =
    "Add a directory to this project to use it for Interactive and North Star."

  // Show a project section when it has conversations in this view OR a new
  // conversation can be started in it (so its "+" is reachable even when empty).
  const visibleProjects = projects.filter(
    (p) => (byProject.get(p.id)?.length ?? 0) > 0 || canCreateInProject(p)
  )

  async function renameConversation(id: string, title: string) {
    // Optimistic update, then persist.
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title } : c))
    )
    await window.cowork.db.conversations.update(id, { title })
  }

  // Projects a conversation can be added to: any project it isn't already in,
  // minus — for workspace-view conversations — projects without a directory
  // (those are Chat-only and can't back Interactive/North Star).
  //
  // Projects whose directory DIFFERS from the conversation's own are still
  // listed (not silently hidden) so the user gets an explicit explanation when
  // they try — moveConversationToProject blocks the move with an alert. Chat
  // conversations are grouping-only (no directory), so they're never restricted.
  function moveTargetsFor(conversation: Conversation): Project[] {
    return projects.filter(
      (p) =>
        p.id !== conversation.projectId &&
        (conversation.mode === "chat" || !!p.workspaceId)
    )
  }

  // Resolve a workspace_id to its absolute path for display (null/unknown → null).
  function workspacePath(workspaceId: string | null | undefined): string | null {
    if (!workspaceId) return null
    return workspaces.find((w) => w.id === workspaceId)?.path ?? null
  }

  // Whether moving `conversation` into `project` would change its working
  // directory. Only relevant for workspace-view conversations that already have a
  // workspace: if the project's directory differs, the move is refused (a
  // conversation's directory can't be silently switched out from under it).
  function isWorkspaceMismatch(
    conversation: Conversation,
    project: Project
  ): boolean {
    return (
      conversation.mode !== "chat" &&
      !!conversation.workspaceId &&
      !!project.workspaceId &&
      conversation.workspaceId !== project.workspaceId
    )
  }

  // Add a conversation to a project (or remove it, projectId = null). A project
  // with a directory owns the workspace, so moving into it adopts that directory
  // and moving out clears it — keeping the "directory locked to project" rule.
  // A workspace-view conversation can only join a project that shares its
  // directory; a mismatch is refused with an explanatory alert (see above).
  async function moveConversationToProject(
    id: string,
    projectId: string | null
  ) {
    const conversation = conversations.find((c) => c.id === id)
    const target = projectId
      ? projects.find((p) => p.id === projectId)
      : undefined
    // Block a directory-changing move: explain why instead of silently switching.
    if (conversation && target && isWorkspaceMismatch(conversation, target)) {
      setWorkspaceMismatch({ conversation, project: target })
      return
    }
    const patch: {
      projectId: string | null
      workspaceId?: string | null
    } = { projectId }
    if (projectId) {
      // Entering a project with a directory adopts it; a directory-less project
      // leaves the conversation's own workspace untouched.
      if (target?.workspaceId) patch.workspaceId = target.workspaceId
    } else {
      // Leaving a project drops the project-owned directory.
      patch.workspaceId = null
    }
    // Optimistic update, then persist + refetch (the active conversation may need
    // its locked-workspace state recomputed, which App does on its own load).
    setConversations((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              projectId,
              workspaceId:
                patch.workspaceId !== undefined
                  ? patch.workspaceId
                  : c.workspaceId,
            }
          : c
      )
    )
    await window.cowork.db.conversations.update(id, patch)
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

  async function confirmProjectDelete() {
    const target = pendingProjectDelete
    if (!target) return
    setPendingProjectDelete(null)
    await window.cowork.db.projects.delete(target.id)
    // Conversations' project_id is SET NULL on delete — refetch both so the
    // freed conversations reappear under "No Project".
    await refetch()
  }

  function openCreateProject() {
    setEditingProject(null)
    setProjectDialogOpen(true)
  }

  function openEditProject(project: Project) {
    setEditingProject(project)
    setProjectDialogOpen(true)
  }

  return (
    <Sidebar>
      {/* Top padding clears the macOS traffic lights / sidebar toggle. Window
          dragging is handled by the top bar in Shell, not here — a drag region
          on the header would swallow the toggle button's clicks. */}
      <SidebarHeader className="h-12" />
      {/* View switcher — Chat / Interactive / North Star. The North Star tab's
          LABEL is branded from MAIN_AGENT_NAME (the "North Star" value stays the
          internal key used for mode mapping). */}
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
              {v === "North Star" ? agentName : v}
            </Button>
          ))}
        </ButtonGroup>
      </div>
      {/* "+ New" (unassigned) and "New Project". */}
      <div className="flex gap-2 px-2 pb-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onNewConversation(null)}
          className="flex-1 justify-start"
        >
          <Plus className="size-4" />
          {NEW_LABEL[view]}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={openCreateProject}
          title="New project"
          aria-label="New project"
        >
          <FolderPlus className="size-4" />
        </Button>
      </div>
      <SidebarContent>
        {visibleProjects.map((p) => (
          <ProjectSection
            key={p.id}
            project={p}
            label={p.name}
            conversations={byProject.get(p.id) ?? []}
            canCreate={canCreateInProject(p)}
            createHint={CREATE_HINT}
            moveTargetsFor={moveTargetsFor}
            activeConversationId={activeConversationId}
            runningConvos={runningConvos}
            waitingConvos={waitingConvos}
            onNewConversation={() => onNewConversation(p.id)}
            onSelectConversation={onSelectConversation}
            onRenameConversation={renameConversation}
            onDeleteConversation={setPendingDelete}
            onMoveToProject={moveConversationToProject}
            onEditProject={() => openEditProject(p)}
            onDeleteProject={() => setPendingProjectDelete(p)}
          />
        ))}
        {/* The "No Project" bucket — always shown (existing/ungrouped chats). */}
        <ProjectSection
          project={null}
          label="No Project"
          conversations={noProjectItems}
          canCreate
          moveTargetsFor={moveTargetsFor}
          activeConversationId={activeConversationId}
          runningConvos={runningConvos}
          waitingConvos={waitingConvos}
          onNewConversation={() => onNewConversation(null)}
          onSelectConversation={onSelectConversation}
          onRenameConversation={renameConversation}
          onDeleteConversation={setPendingDelete}
          onMoveToProject={moveConversationToProject}
        />
      </SidebarContent>
      <SidebarFooter className="p-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onSkillsClick}
          className="w-full justify-start"
        >
          <BookOpen className="size-4" />
          Skills
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onSettingsClick}
          className="w-full justify-start"
        >
          <Settings className="size-4" />
          Settings
        </Button>
      </SidebarFooter>

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
              “{pendingDelete?.title ?? "Untitled"}” and all of its messages
              will be permanently deleted. This can’t be undone.
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

      {/* Confirmation before deleting a project. Conversations are kept — they
          move to "No Project" — so this is far less destructive than a session
          delete. */}
      <AlertDialog
        open={pendingProjectDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingProjectDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingProjectDelete?.name}” will be deleted. Its conversations
              are kept and moved to “No Project”.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmProjectDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Blocked "add to project": the conversation and the project work in
          different directories. Explain why and offer only a close — a
          conversation's working directory can't be silently reassigned. */}
      <AlertDialog
        open={workspaceMismatch !== null}
        onOpenChange={(open) => {
          if (!open) setWorkspaceMismatch(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Can’t add to this project</AlertDialogTitle>
            <AlertDialogDescription>
              This conversation works in{" "}
              <span className="font-mono">
                {workspacePath(workspaceMismatch?.conversation.workspaceId) ??
                  "its own folder"}
              </span>
              , but “{workspaceMismatch?.project.name}” is set to{" "}
              <span className="font-mono">
                {workspacePath(workspaceMismatch?.project.workspaceId) ??
                  "a different folder"}
              </span>
              . A conversation can only be added to a project with the same
              directory.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ProjectDialog
        open={projectDialogOpen}
        project={editingProject}
        onOpenChange={setProjectDialogOpen}
        onSaved={refetch}
      />
    </Sidebar>
  )
}
