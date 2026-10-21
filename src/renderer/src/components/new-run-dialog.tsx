import { useEffect, useRef, useState } from "react"
import { FolderOpen } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox"
import { Label } from "@/components/ui/label"
import { MentionMenu, type MentionItem } from "@/components/mention-menu"
import {
  activeMentionToken,
  expandMentions,
  segmentMessage,
  type ConfirmedMentions,
} from "@/lib/mention-tokens"
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
import { Textarea } from "@/components/ui/textarea"
import type { Project, Workspace } from "@/types"
import type { WorkflowDefinition } from "../../../shared/workflows"

export function NewRunDialog({
  open,
  onOpenChange,
  projects,
  selectedProjectId,
  workflows,
  initialWorkflowId = null,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  selectedProjectId: string | null
  workflows: WorkflowDefinition[]
  initialWorkflowId?: string | null
  onStarted: (run: import("../../../shared/workflow-runs").WorkflowRun) => void
}) {
  const popupContainerRef = useRef<HTMLDivElement>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const lockedProject = selectedProjectId
    ? projects.find((item) => item.id === selectedProjectId)
    : undefined
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  const [objective, setObjective] = useState("")
  const [pendingObjective, setPendingObjective] = useState<string | null>(null)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [starting, setStarting] = useState(false)
  const startingRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const fileRequestRef = useRef(0)
  const [fileQuery, setFileQuery] = useState<string | null>(null)
  const [fileItems, setFileItems] = useState<string[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [confirmedFiles, setConfirmedFiles] = useState<Set<string>>(new Set())
  const confirmedMentions: ConfirmedMentions[] = [
    { kind: "file", values: confirmedFiles },
  ]

  function closeFileMenu() {
    fileRequestRef.current++
    setFileQuery(null)
    setFileItems([])
    setActiveFile(null)
  }

  function replaceObjective(text: string) {
    setObjective(text)
    setConfirmedFiles(new Set())
    closeFileMenu()
  }

  function editObjective(text: string, caret: number) {
    setObjective(text)
    setConfirmedFiles(
      new Set(
        segmentMessage(text, confirmedMentions)
          .filter((segment) => segment.kind === "file")
          .map((segment) => segment.text.slice(1))
      )
    )
    const token = activeMentionToken(text, caret)
    closeFileMenu()
    if (token?.kind === "file" && workspacePath && open) {
      setFileQuery(token.query)
      const request = ++fileRequestRef.current
      window.cowork.files.list(workspacePath, token.query).then(
        (paths) => {
          if (fileRequestRef.current !== request) return
          setFileItems(paths)
          setActiveFile(paths[0] ?? null)
        },
        () => {
          if (fileRequestRef.current !== request) return
          setFileItems([])
          setActiveFile(null)
        }
      )
    }
  }

  function selectFile(item: MentionItem) {
    const node = textareaRef.current
    if (!node || fileQuery === null) return
    const token = activeMentionToken(objective, node.selectionStart)
    if (token?.kind !== "file") return
    const insert = `@${item.value} `
    setObjective(
      objective.slice(0, token.start) + insert + objective.slice(token.end)
    )
    setConfirmedFiles((current) => new Set(current).add(item.value))
    closeFileMenu()
    requestAnimationFrame(() => {
      if (!node.isConnected) return
      node.focus()
      node.setSelectionRange(
        token.start + insert.length,
        token.start + insert.length
      )
    })
  }

  async function startRun() {
    if (
      startingRef.current ||
      !workspaceId ||
      !workspacePath ||
      !workflowId ||
      !objective.trim()
    )
      return
    startingRef.current = true
    setStarting(true)
    try {
      const run = await window.cowork.workflowRuns.start({
        workspaceId,
        projectId,
        workflowId,
        objective: expandMentions(objective, confirmedMentions),
      })
      onStarted(run)
      onOpenChange(false)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not start run"
      )
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }
  const project = projects.find((item) => item.id === projectId)
  const workspace = workspaces.find((item) => item.id === workspaceId)
  const workflow = workflows.find((item) => item.id === workflowId)
  const workspacePath = workspace?.path.trim() ?? ""
  const menuItems: MentionItem[] = fileItems.map((path) => ({
    value: path,
    primary: `@${path.split("/").pop()}`,
    secondary: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  }))

  useEffect(() => {
    setConfirmedFiles(new Set())
    closeFileMenu()
  }, [workspacePath])

  useEffect(() => {
    if (!open) closeFileMenu()
    return () => {
      fileRequestRef.current++
    }
  }, [open])

  const wasOpen = useRef(false)
  const openedFromShortcut = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      if (initialWorkflowId) {
        const initial = workflows.find((item) => item.id === initialWorkflowId)
        setWorkflowId(initial?.id ?? null)
        replaceObjective(initial?.defaultObjective ?? "")
        setPendingObjective(null)
      } else if (openedFromShortcut.current) {
        setWorkflowId(null)
        replaceObjective("")
        setPendingObjective(null)
      }
      openedFromShortcut.current = Boolean(initialWorkflowId)
    }
    wasOpen.current = open
  }, [open, initialWorkflowId, workflows])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    if (lockedProject) {
      setProjectId(lockedProject.id)
      setWorkspaceId(lockedProject.workspaceId)
    }
    window.cowork.db.workspaces.list().then(
      (list) => {
        if (!cancelled) setWorkspaces(list)
      },
      () => {
        if (!cancelled)
          toast.error("Could not load workspaces. Reopen New Run to try again.")
      }
    )
    return () => {
      cancelled = true
    }
  }, [open, lockedProject?.id])

  function selectWorkspace(id: string) {
    setWorkspaceId(id)
    setProjectId(
      lockedProject?.id ??
        projects.find(
          (item) => item.id === projectId && item.workspaceId === id
        )?.id ??
        projects.find((item) => item.workspaceId === id)?.id ??
        null
    )
  }

  async function pickWorkspace() {
    setPickingWorkspace(true)
    try {
      const picked = await window.cowork.pickWorkspace()
      if (!picked.path) return
      const selected = await window.cowork.db.workspaces.upsert(picked.path)
      setWorkspaces((current) => [
        ...current.filter((item) => item.id !== selected.id),
        selected,
      ])
      selectWorkspace(selected.id)
    } catch {
      toast.error("Could not select workspace. Please try again.")
    } finally {
      setPickingWorkspace(false)
    }
  }

  const pickers = [
    {
      id: "new-run-project",
      label: "Project (optional)",
      placeholder: "No project",
      items: [
        { id: "", label: "No project" },
        ...projects.map((item) => ({ id: item.id, label: item.name })),
      ],
      value: projectId ?? "",
      onSelect: (id: string) => {
        setProjectId(id || null)
        if (id)
          setWorkspaceId(
            projects.find((item) => item.id === id)?.workspaceId ?? null
          )
        else setWorkspaceId(null)
      },
    },
    {
      id: "new-run-workspace",
      label: "Workspace",
      placeholder: "Select a workspace",
      items: workspaces.map((item) => ({ id: item.id, label: item.path })),
      value: workspaceId,
      onSelect: selectWorkspace,
    },
    {
      id: "new-run-workflow",
      label: "Workflow",
      placeholder: "Select a workflow",
      items: [...workflows]
        .sort((a, b) =>
          a.name
            .trim()
            .localeCompare(b.name.trim(), undefined, { sensitivity: "base" })
        )
        .map((item) => ({ id: item.id, label: item.name })),
      value: workflowId,
      onSelect: (id: string) => {
        setWorkflowId(id)
        const defaultObjective =
          workflows.find((item) => item.id === id)?.defaultObjective ?? ""
        if (
          objective.trim() &&
          defaultObjective.trim() &&
          objective.trim() !== defaultObjective.trim()
        ) {
          setPendingObjective(defaultObjective)
        } else if (!objective.trim()) {
          replaceObjective(defaultObjective.trim() ? defaultObjective : "")
        }
      },
    },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onEscapeKeyDown={(event) => {
          if (fileQuery !== null) {
            event.preventDefault()
            closeFileMenu()
          }
        }}
        onInteractOutside={(event) => {
          if (pendingObjective !== null) event.preventDefault()
        }}
        onBackdropClick={() => {
          if (pendingObjective === null) onOpenChange(false)
        }}
      >
        <DialogHeader>
          <DialogTitle>New Run</DialogTitle>
          <DialogDescription>
            Choose a workspace and workflow, then enter the objective for this
            run.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {pickers.map((picker) => (
            <div key={picker.id} className="space-y-2">
              <Label htmlFor={picker.id}>{picker.label}</Label>
              <Combobox
                items={picker.items}
                value={
                  picker.items.find((item) => item.id === picker.value) ?? null
                }
                itemToStringLabel={(item) => item.label}
                onValueChange={(item) => {
                  if (item) picker.onSelect(item.id)
                }}
              >
                <ComboboxTrigger
                  id={picker.id}
                  disabled={
                    pickingWorkspace ||
                    (picker.id === "new-run-workflow" && !workspacePath) ||
                    (Boolean(lockedProject) &&
                      picker.id === "new-run-project") ||
                    (Boolean(lockedProject?.workspaceId) &&
                      picker.id === "new-run-workspace")
                  }
                  className="flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-input px-2.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="truncate">
                    {picker.items.find((item) => item.id === picker.value)
                      ?.label ?? picker.placeholder}
                  </span>
                </ComboboxTrigger>
                <ComboboxContent portalContainer={popupContainerRef}>
                  <ComboboxInput
                    placeholder={`Search ${picker.label === "Project (optional)" ? "projects" : `${picker.label.toLowerCase()}s`}…`}
                    showTrigger={false}
                  />
                  <ComboboxEmpty>No matches found.</ComboboxEmpty>
                  <ComboboxList>
                    {(item: { id: string; label: string }) => (
                      <ComboboxItem key={item.id} value={item}>
                        {item.label}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              {picker.id === "new-run-workspace" &&
                !lockedProject?.workspaceId && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={pickWorkspace}
                    disabled={pickingWorkspace}
                  >
                    <FolderOpen className="size-4" />
                    {pickingWorkspace ? "Choosing…" : "Choose folder"}
                  </Button>
                )}
            </div>
          ))}
          <div className="space-y-2">
            <Label htmlFor="new-run-objective">Objective</Label>
            <div className="relative">
              {open && fileQuery !== null && workspacePath && (
                <div onMouseDown={(event) => event.preventDefault()}>
                  <MentionMenu
                    items={menuItems}
                    activeValue={activeFile}
                    onActiveValueChange={setActiveFile}
                    onSelect={selectFile}
                    emptyLabel="No matching files"
                  />
                </div>
              )}
              <div
                ref={overlayRef}
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-hidden border border-transparent px-2.5 py-2 text-base break-words whitespace-pre-wrap text-transparent md:text-sm"
              >
                {segmentMessage(objective, confirmedMentions).map(
                  (segment, index) => (
                    <span
                      key={index}
                      className={
                        segment.kind ? "rounded bg-primary/15" : undefined
                      }
                    >
                      {segment.text}
                    </span>
                  )
                )}
              </div>
              <Textarea
                ref={textareaRef}
                id="new-run-objective"
                aria-describedby="new-run-objective-help"
                disabled={!workspacePath}
                rows={10}
                className="relative field-sizing-fixed overflow-y-auto"
                value={objective}
                onChange={(event) =>
                  editObjective(event.target.value, event.target.selectionStart)
                }
                onScroll={(event) => {
                  if (overlayRef.current) {
                    overlayRef.current.scrollTop = event.currentTarget.scrollTop
                    overlayRef.current.scrollLeft =
                      event.currentTarget.scrollLeft
                  }
                }}
                onBlur={closeFileMenu}
                onKeyDown={(event) => {
                  if (fileQuery === null || event.nativeEvent.isComposing)
                    return
                  if (event.key === "Escape") {
                    event.preventDefault()
                    event.stopPropagation()
                    closeFileMenu()
                    return
                  }
                  if (!menuItems.length) return
                  const index = menuItems.findIndex(
                    (item) => item.value === activeFile
                  )
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault()
                    const direction = event.key === "ArrowDown" ? 1 : -1
                    setActiveFile(
                      menuItems[
                        (index + direction + menuItems.length) %
                          menuItems.length
                      ].value
                    )
                  } else if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault()
                    selectFile(menuItems[index] ?? menuItems[0])
                  }
                }}
              />
            </div>
            <p
              id="new-run-objective-help"
              className="text-xs text-muted-foreground"
            >
              {workspacePath
                ? "Type @ to find and link workspace files."
                : "Select a project with a workspace, or choose a workspace, to enable Workflow and Objective."}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {project ? `Project: ${project.name}.` : "This run has no project."}{" "}
            Auto mode: steps execute without questions or confirmation prompts.
            Cancelling does not undo changes.
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            className="sm:mr-auto"
            disabled={pickingWorkspace || Boolean(lockedProject)}
            onClick={() => {
              setProjectId(null)
              setWorkspaceId(null)
              setWorkflowId(null)
              replaceObjective("")
            }}
          >
            Clear fields
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              !workspacePath ||
              !workflow?.steps.length ||
              !objective.trim() ||
              pickingWorkspace ||
              starting
            }
            onClick={startRun}
          >
            {starting ? "Starting…" : "Start"}
          </Button>
        </DialogFooter>
        <div
          ref={popupContainerRef}
          className="pointer-events-none absolute inset-0 [&>*]:pointer-events-auto"
        />
        <AlertDialog
          open={pendingObjective !== null}
          onOpenChange={(isOpen) => {
            if (!isOpen) setPendingObjective(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Use the workflow’s default objective?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Replace your current objective with: “{pendingObjective}”
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep my objective</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (pendingObjective !== null)
                    replaceObjective(pendingObjective)
                  setPendingObjective(null)
                }}
              >
                Use default
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
