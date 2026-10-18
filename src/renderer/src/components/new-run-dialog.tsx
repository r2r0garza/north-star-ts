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
import { Textarea } from "@/components/ui/textarea"
import type { Project, Workspace } from "@/types"
import type { WorkflowDefinition } from "../../../shared/workflows"

export function NewRunDialog({
  open,
  onOpenChange,
  projects,
  workflows,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  workflows: WorkflowDefinition[]
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [workflowId, setWorkflowId] = useState<string | null>(null)
  const [objective, setObjective] = useState("")
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const project = projects.find((item) => item.id === projectId)
  const workspace = workspaces.find((item) => item.id === workspaceId)
  const workflow = workflows.find((item) => item.id === workflowId)

  useEffect(() => {
    if (!open) return
    let cancelled = false
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
  }, [open])

  function selectWorkspace(id: string) {
    setWorkspaceId(id)
    setProjectId(
      projects.find((item) => item.id === projectId && item.workspaceId === id)
        ?.id ??
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
        setObjective(defaultObjective.trim() ? defaultObjective : "")
      },
    },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        className="sm:max-w-lg"
        onBackdropClick={() => onOpenChange(false)}
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
                  disabled={pickingWorkspace}
                  className="flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-input px-2.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="truncate">
                    {picker.items.find((item) => item.id === picker.value)
                      ?.label ?? picker.placeholder}
                  </span>
                </ComboboxTrigger>
                <ComboboxContent portalContainer={contentRef}>
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
              {picker.id === "new-run-workspace" && (
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
            <Textarea
              id="new-run-objective"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {project ? `Project: ${project.name}.` : "This run has no project."}{" "}
            Run execution isn't connected yet.
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            className="sm:mr-auto"
            disabled={pickingWorkspace}
            onClick={() => {
              setProjectId(null)
              setWorkspaceId(null)
              setWorkflowId(null)
              setObjective("")
            }}
          >
            Clear fields
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              !workspace || !workflow || !objective.trim() || pickingWorkspace
            }
          >
            Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
