import { useCallback, useEffect, useRef, useState } from "react"
import {
  CalendarIcon,
  FolderOpen,
  Layers,
  ListFilter,
  Play,
  Plus,
} from "lucide-react"
import { toast } from "sonner"
import { ScreenHeader } from "@/components/screen-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Calendar } from "@/components/ui/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Label } from "@/components/ui/label"
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
  ComboboxValue,
} from "@/components/ui/combobox"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { Project } from "@/types"
import { WorkflowLibrary } from "@/components/workflow-library"
import { WorkflowDetail } from "@/components/workflow-detail"
import { RunDetail } from "@/components/run-detail"
import { NewRunDialog } from "@/components/new-run-dialog"
import type { WorkflowDefinition } from "../../../shared/workflows"

const RUN_STATUSES = [
  "All statuses",
  "Active",
  "Completed",
  "Paused",
  "Cancelled",
  "Failed",
  "Interrupted",
]

export function WorkflowsScreen({
  onClose,
  requestedRun,
}: {
  onClose: () => void
  requestedRun?: { id: string; requestId: string } | null
}) {
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [runsError, setRunsError] = useState(false)
  const [savedRuns, setSavedRuns] = useState<
    import("../../../shared/workflow-runs").WorkflowRun[]
  >([])
  const [projects, setProjects] = useState<Project[]>([])
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([])
  const [creatingWorkflow, setCreatingWorkflow] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<WorkflowDefinition | null>(
    null
  )
  const [deletingWorkflow, setDeletingWorkflow] = useState(false)
  const [workflowsLoaded, setWorkflowsLoaded] = useState(false)
  const [workflowsLoading, setWorkflowsLoading] = useState(false)
  const [workflowsError, setWorkflowsError] = useState(false)
  const [libraryQuery, setLibraryQuery] = useState("")
  const workflowLoadInFlight = useRef(false)

  const loadWorkflows = useCallback(async () => {
    if (workflowLoadInFlight.current) return
    workflowLoadInFlight.current = true
    setWorkflowsLoading(true)
    try {
      setWorkflows(await window.cowork.db.workflows.list())
      setWorkflowsLoaded(true)
      setWorkflowsError(false)
    } catch {
      setWorkflowsError(true)
    } finally {
      workflowLoadInFlight.current = false
      setWorkflowsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadWorkflows()
  }, [loadWorkflows])
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(
    null
  )
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState("runs")
  const [newRunOpen, setNewRunOpen] = useState(false)
  const [initialWorkflowId, setInitialWorkflowId] = useState<string | null>(
    null
  )
  useEffect(() => {
    if (requestedRun) {
      setSelectedWorkflowId(null)
      setSelectedRunId(requestedRun.id)
      setActiveTab("runs")
    }
  }, [requestedRun])
  const selectedWorkflow = workflows.find(
    (workflow) => workflow.id === selectedWorkflowId
  )
  const [projectFilter, setProjectFilter] = useState<string | null>("all")
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [dateFilter, setDateFilter] = useState<Date>()
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState("")
  const projectRuns = savedRuns.filter(
    (run) => projectFilter === "all" || run.projectId === projectFilter
  )
  const runs = projectRuns
    .filter((run) => {
      const date = new Date(run.createdAt)
      return (
        (!dateFilter || date.toDateString() === dateFilter.toDateString()) &&
        (!statusFilter || run.status === statusFilter)
      )
    })
    .sort((a, b) => b.createdAt - a.createdAt)
  const newRunButton = (
    <Button
      size="sm"
      variant="outline"
      className="shrink-0"
      onClick={() => {
        setInitialWorkflowId(null)
        setNewRunOpen(true)
      }}
    >
      <Plus className="size-4" />
      New Run
    </Button>
  )

  useEffect(() => {
    let cancelled = false
    let loading = false
    async function refresh() {
      if (loading) return
      loading = true
      try {
        const list = await window.cowork.workflowRuns.list()
        if (!cancelled) {
          setSavedRuns(list)
          setRunsLoaded(true)
          setRunsError(false)
        }
      } catch {
        if (!cancelled) {
          setRunsError(true)
          toast.error("Could not load workflow runs")
        }
      } finally {
        loading = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let loadingProjects = false
    async function refreshProjects() {
      if (loadingProjects) return
      loadingProjects = true
      try {
        const list = await window.cowork.db.projects.list()
        if (!cancelled) setProjects(list)
      } catch {
        if (!cancelled) toast.error("Could not load projects")
      } finally {
        loadingProjects = false
      }
    }
    void refreshProjects()
    const projectsTimer = setInterval(() => void refreshProjects(), 1000)
    return () => {
      cancelled = true
      clearInterval(projectsTimer)
    }
  }, [])

  const filters = [
    { id: "all", name: "All", icon: Layers },
    { id: null, name: "None", icon: FolderOpen },
    ...[...projects]
      .sort((a, b) =>
        a.name.trim().localeCompare(b.name.trim(), undefined, {
          sensitivity: "base",
        })
      )
      .map((project) => ({
        id: project.id,
        name: project.name,
        icon: FolderOpen,
      })),
  ]
  const selectedName = filters.find(
    (filter) => filter.id === projectFilter
  )?.name
  const runDescription =
    projectFilter === "all"
      ? "Runs across all projects, including runs without a project."
      : projectFilter === null
        ? "Runs that aren't assigned to a project."
        : `Runs for ${selectedName}.`

  async function createWorkflow() {
    setCreatingWorkflow(true)
    try {
      const workflow = await window.cowork.db.workflows.create()
      setWorkflows((current) => [...current, workflow])
      setLibraryQuery("")
      setSelectedWorkflowId(workflow.id)
    } catch {
      toast.error("Could not create workflow. Please try again.")
    } finally {
      setCreatingWorkflow(false)
    }
  }

  async function importWorkflow() {
    try {
      const result = await window.cowork.db.workflows.importFile()
      if (result.canceled || !result.workflow) return
      setWorkflows((current) => [...current, result.workflow!])
      setLibraryQuery("")
      toast.info("Workflow imported")
    } catch {
      toast.error(
        "Could not import workflow. Check that the JSON file is valid."
      )
    }
  }

  async function exportWorkflow(workflow: WorkflowDefinition) {
    try {
      const result = await window.cowork.db.workflows.export(workflow)
      if (!result.canceled) toast.info("Workflow exported")
    } catch {
      toast.error("Could not export workflow. Please try again.")
    }
  }

  async function deleteWorkflow() {
    if (!pendingDelete || deletingWorkflow) return
    const id = pendingDelete.id
    setDeletingWorkflow(true)
    try {
      await window.cowork.db.workflows.delete(id)
      setWorkflows((current) =>
        current.filter((workflow) => workflow.id !== id)
      )
      setPendingDelete(null)
    } catch {
      toast.error("Could not delete workflow. Please try again.")
    } finally {
      setDeletingWorkflow(false)
    }
  }

  const selectedRun = savedRuns.find((run) => run.id === selectedRunId)

  if (selectedRun) {
    return (
      <RunDetail
        run={selectedRun}
        workflow={selectedRun.workflow}
        onBack={() => setSelectedRunId(null)}
        onClose={onClose}
      />
    )
  }

  if (selectedRunId && !selectedRun) {
    return (
      <div className="flex flex-1 flex-col pt-11">
        <ScreenHeader
          title="Workflow Run"
          backLabel="Back to runs"
          onBack={() => setSelectedRunId(null)}
          onClose={onClose}
        />
        <p role={runsError ? "alert" : "status"} className="p-4">
          {runsError
            ? "Could not load this workflow run. Retrying…"
            : !runsLoaded
              ? "Loading workflow run…"
              : "This workflow run is unavailable."}
        </p>
      </div>
    )
  }

  if (selectedWorkflow) {
    return (
      <WorkflowDetail
        workflow={selectedWorkflow}
        onChange={(updated) => {
          setWorkflows((current) =>
            current.map((workflow) =>
              workflow.id === updated.id ? updated : workflow
            )
          )
        }}
        onBack={() => setSelectedWorkflowId(null)}
        onClose={onClose}
      />
    )
  }

  return (
    <div
      data-slot="workflows-screen"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background pt-11 text-sm text-foreground"
    >
      <ScreenHeader
        title="Workflows"
        onBack={onClose}
        backLabel="Close workflows"
        onClose={onClose}
      />
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
          <TabsList
            variant="line"
            className="gap-1"
            aria-label="Workflow views"
          >
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="workflows">Library</TabsTrigger>
          </TabsList>
          {activeTab === "runs" && <Badge variant="outline">Auto mode</Badge>}
        </div>
        <TabsContent value="runs" className="min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 min-w-0">
            <nav
              aria-label="Run projects"
              className="flex w-60 shrink-0 flex-col border-r"
            >
              <div className="flex h-12 shrink-0 items-center px-3 text-xs font-medium text-muted-foreground">
                Projects
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-0.5 px-2 pb-2">
                  {filters.slice(0, 2).map((filter) => (
                    <button
                      key={filter.id ?? "none"}
                      type="button"
                      aria-pressed={projectFilter === filter.id}
                      onClick={() => setProjectFilter(filter.id)}
                      className={cn(
                        "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring",
                        projectFilter === filter.id
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      )}
                    >
                      <filter.icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{filter.name}</span>
                    </button>
                  ))}
                  <div role="separator" className="my-1 border-t" />
                  {filters.slice(2).map((filter) => (
                    <button
                      key={filter.id}
                      type="button"
                      aria-pressed={projectFilter === filter.id}
                      onClick={() => setProjectFilter(filter.id)}
                      className={cn(
                        "flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring",
                        projectFilter === filter.id
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      )}
                    >
                      <filter.icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{filter.name}</span>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </nav>
            <section
              aria-label="Project runs"
              className="flex min-h-0 min-w-0 flex-1 flex-col"
            >
              <header className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
                <div className="min-w-0 space-y-0.5">
                  <h2 className="truncate font-medium">
                    {projectFilter === "all"
                      ? "All runs"
                      : `${selectedName} · Runs`}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {runDescription}
                  </p>
                </div>
                {projectRuns.length > 0 && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant={
                        filtersOpen || dateFilter || statusFilter
                          ? "secondary"
                          : "outline"
                      }
                      size="icon-sm"
                      aria-label="Filter runs"
                      aria-expanded={filtersOpen}
                      aria-controls="run-filters"
                      onClick={() => setFiltersOpen((open) => !open)}
                    >
                      <ListFilter className="size-4" />
                    </Button>
                    {newRunButton}
                  </div>
                )}
              </header>
              {projectRuns.length > 0 && filtersOpen && (
                <div
                  id="run-filters"
                  role="region"
                  aria-label="Run filters"
                  className="flex shrink-0 flex-wrap items-end gap-3 border-b px-4 py-3"
                >
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="run-date">Date</Label>
                    <Popover
                      open={datePickerOpen}
                      onOpenChange={setDatePickerOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          id="run-date"
                          variant="outline"
                          className={cn(
                            "min-w-40 justify-start font-normal",
                            !dateFilter && "text-muted-foreground"
                          )}
                        >
                          <CalendarIcon className="size-4" />
                          {dateFilter
                            ? dateFilter.toLocaleDateString(undefined, {
                                dateStyle: "medium",
                              })
                            : "Pick a date"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-auto p-0">
                        <Calendar
                          mode="single"
                          captionLayout="dropdown"
                          selected={dateFilter}
                          defaultMonth={dateFilter}
                          onSelect={(date) => {
                            setDateFilter(date)
                            setDatePickerOpen(false)
                          }}
                          autoFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="run-status">Status</Label>
                    <Combobox
                      items={RUN_STATUSES}
                      value={statusFilter || "All statuses"}
                      onValueChange={(value) => {
                        if (value)
                          setStatusFilter(value === "All statuses" ? "" : value)
                      }}
                    >
                      <ComboboxTrigger
                        id="run-status"
                        className="flex h-8 min-w-40 items-center justify-between gap-2 rounded-lg border border-input px-2.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <ComboboxValue />
                      </ComboboxTrigger>
                      <ComboboxContent>
                        <ComboboxInput
                          placeholder="Search statuses…"
                          showTrigger={false}
                        />
                        <ComboboxEmpty>No statuses found.</ComboboxEmpty>
                        <ComboboxList>
                          {(status: string) => (
                            <ComboboxItem key={status} value={status}>
                              {status}
                            </ComboboxItem>
                          )}
                        </ComboboxList>
                      </ComboboxContent>
                    </Combobox>
                  </div>
                  <Button
                    variant="ghost"
                    disabled={!dateFilter && !statusFilter}
                    onClick={() => {
                      setDateFilter(undefined)
                      setStatusFilter("")
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              )}
              <ScrollArea className="min-h-0 flex-1">
                {runs.length > 0 ? (
                  <ul aria-label="Runs" className="space-y-3 p-4">
                    {runs.map((run) => (
                      <li key={run.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedRunId(run.id)}
                          className="flex w-full items-start justify-between gap-4 rounded-lg border p-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <div className="min-w-0 space-y-1">
                            <h3 className="font-medium">{run.title}</h3>
                            <p className="text-xs text-muted-foreground">
                              {run.projectName ?? "No project"} ·{" "}
                              {run.workspacePath}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-1">
                            <Badge
                              variant="secondary"
                              className={cn(
                                "w-24 justify-center",
                                run.status === "Completed" &&
                                  "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
                                run.status === "Active" &&
                                  "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
                                run.status === "Paused" &&
                                  "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
                                run.status === "Cancelled" &&
                                  "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300"
                              )}
                            >
                              {run.status}
                            </Badge>
                            <time
                              dateTime={new Date(run.createdAt).toISOString()}
                              className="text-xs text-muted-foreground"
                            >
                              {new Date(run.createdAt).toLocaleString(
                                undefined,
                                {
                                  dateStyle: "medium",
                                  timeStyle: "short",
                                }
                              )}
                            </time>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : projectRuns.length > 0 ? (
                  <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                    <h3 className="font-medium">No matching runs</h3>
                    <p className="text-muted-foreground">
                      Try another date or status, or clear the filters.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                    <Play className="size-8 text-muted-foreground" />
                    <h3 className="font-medium">No runs yet</h3>
                    <p className="max-w-sm text-muted-foreground">
                      {projectFilter === "all"
                        ? "Workflow runs will appear here."
                        : projectFilter === null
                          ? "Runs without a project will appear here."
                          : `Workflow runs for ${selectedName} will appear here.`}{" "}
                      Choose a workflow to get started.
                    </p>
                    {newRunButton}
                  </div>
                )}
              </ScrollArea>
            </section>
          </div>
        </TabsContent>
        <TabsContent value="workflows" className="min-h-0 overflow-hidden">
          <WorkflowLibrary
            workflows={workflows}
            loaded={workflowsLoaded}
            loading={workflowsLoading}
            error={workflowsError}
            creating={creatingWorkflow}
            query={libraryQuery}
            onQueryChange={setLibraryQuery}
            onRetry={() => void loadWorkflows()}
            onCreate={() => void createWorkflow()}
            onImport={() => void importWorkflow()}
            onEdit={(workflow) => setSelectedWorkflowId(workflow.id)}
            onRun={(workflow) => {
              setInitialWorkflowId(workflow.id)
              setActiveTab("runs")
              setNewRunOpen(true)
            }}
            onExport={(workflow) => void exportWorkflow(workflow)}
            onDelete={setPendingDelete}
          />
        </TabsContent>
      </Tabs>
      <NewRunDialog
        open={newRunOpen}
        onOpenChange={setNewRunOpen}
        projects={projects}
        selectedProjectId={projectFilter !== "all" ? projectFilter : null}
        workflows={workflows}
        initialWorkflowId={initialWorkflowId}
        onStarted={(run) => {
          setSavedRuns((current) => [run, ...current])
          setSelectedRunId(run.id)
        }}
      />
      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <DialogContent onBackdropClick={() => setPendingDelete(null)}>
          <DialogHeader>
            <DialogTitle>Delete workflow?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete “
              {pendingDelete?.name || "Untitled workflow"}”? This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deletingWorkflow}
              onClick={deleteWorkflow}
            >
              {deletingWorkflow ? "Deleting…" : "Delete workflow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
