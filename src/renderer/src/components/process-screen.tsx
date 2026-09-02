import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  Circle,
  CheckCircle2,
  Download,
  FileText,
  XCircle,
  FolderOpen,
  GripVertical,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  SkipForward,
  Trash2,
  Upload,
  XIcon,
} from "lucide-react"
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TaskTranscriptSheet } from "@/components/task-transcript-sheet"
import { ChangedFilesBar } from "@/components/changed-files-bar"
import { DiffView } from "@/components/diff-view"
import { Markdown } from "@/components/markdown"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import {
  buildTimeline,
  changedFilesFromCalls,
  type ChangedFile,
} from "@/lib/timeline"
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
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Kbd } from "@/components/ui/kbd"
import { ScrollArea } from "@/components/ui/scroll-area"
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
import { toast } from "sonner"
import { cn, formatRelativeTime } from "@/lib/utils"
import { agentDisplay, agentRunTitle } from "@/lib/agent-display"
import type {
  AgentSummary,
  EdgeTrigger,
  PhaseGatePolicy,
  PhaseRouting,
  PhaseRunStatus,
  ProcessDefinition,
  ProcessGraph,
  ProcessPhase,
  ProcessPhaseAgent,
  ProcessPhaseAttempt,
  ProcessPhaseRun,
  ProcessRun,
  Approval,
  Task,
  TaskEventPayload,
  TaskLiveEvent,
  GitDiffResult,
} from "@/types"

// The durable approval row's `request` blob for a process gate (mirrors
// GateRequest in the scheduler). Carries the gated phase's own phaseRunId, which
// keys the monitor's gate map — so we can drop a settled gate on reconcile. A
// process_flag_gate (plan 031.2) additionally carries the flag's target + reason
// so the monitor renders the confirmation card off the approvals row alone.
export interface ProcessGateRequest {
  kind: "process_phase_gate" | "process_validator_gate" | "process_flag_gate"
  phaseKey: string
  phaseRunId: string
  requestId: string
  approvalPacket?: ProcessApprovalPacket
  flagId?: string
  flagTargetKey?: string
  flagReason?: string
}

export interface GateInfo {
  requestId: string
  gateKind: "phase" | "validator"
}

interface ApprovalArtifact {
  path: string
  name: string
  kind: "edit" | "write"
  fileType: "code" | "html" | "document"
  provenance: "phase_attributed" | "workspace"
}

interface ApprovalValidation {
  label: string
  status: "passed" | "failed" | "unknown"
  command: string | null
  output: string | null
}

export interface ProcessApprovalPacket {
  requestId: string
  processRunId: string
  phaseRunId: string
  reworkRound: number
  createdAt: number
  summary: {
    outcome: string
    materialChanges: string[]
    validationSummary: string
    caveats: string[]
  }
  artifacts: ApprovalArtifact[]
  validations: ApprovalValidation[]
  downstream: Array<{ phaseId: string; name: string }>
  evidenceWarnings: string[]
  transcriptTaskId: string | null
}

interface ApprovalReviewTarget {
  phaseRun: ProcessPhaseRun
  name: string
  gateKind?: "phase" | "validator"
  requestId?: string
  packet?: ProcessApprovalPacket
  files?: ChangedFile[]
  canRequestChanges: boolean
}

interface FileTextResult {
  content: string | null
  truncated: boolean
  error: string | null
}

// A pending cross-phase rework flag awaiting human confirmation (plan 031.2),
// rendered on the FLAGGING phase-run's card.
export interface FlagGateInfo {
  requestId: string
  targetKey: string
  reason: string
}

// The Process view — an in-panel destination (rendered in the center region of
// the app shell, beside the still-visible sidebar) for the Process engine (plan
// 025). Browsing is a card grid of authored process DEFINITIONS, sorted
// alphabetically by name and filterable by a free-text query. Selecting a card
// takes over the panel with that definition's two surfaces:
//   • a list-based DAG BUILDER (phases + per-phase "depends on" multiselect +
//     an inspector for agent pool / routing / gate policy / fan-out; the graph
//     is rendered implicitly by the depends-on edges), and
//   • a live run MONITOR that colors phases off the `process_phase` events on
//     the run's backing task tail, with inline approval cards for gated phases.
//
// All engine internals (scheduling, routing, fan-out, resume) live in the main
// process; this screen only authors definitions and drives/observes runs via
// the `window.cowork.db.processes.*` CRUD + `window.cowork.process.*` verbs.

// Which surface the main pane shows for the selected definition.
type PaneMode = "builder" | "run"

// Sentinel for the validator "Reviewer" dropdown's default (the phase's own
// agent). Radix Select forbids an empty-string item value, so null maps to this.
const OWN_AGENT = "__own__"

// Sentinel for the sub-process picker's "none" option (plan 038.1) — same Radix
// empty-value constraint as OWN_AGENT. Maps to null (an ordinary agent phase).
const NO_SUBPROCESS = "__none__"

function agentValue(agent: AgentSummary): string {
  return agent.ref ?? agent.name
}

function agentLabel(agent: AgentSummary): string {
  return agent.label ?? agent.name
}

function AgentIdentityBadge({
  value,
  metadata,
  onRemove,
}: {
  value: string
  metadata?: AgentSummary
  onRemove?: () => void
}) {
  const display = agentDisplay(value, metadata)
  const details = [display.source, display.scope].filter(Boolean).join(" · ")

  return (
    <Badge
      variant={onRemove ? "secondary" : "outline"}
      className={cn(
        "max-w-full gap-1.5 pr-1 pl-2",
        onRemove ? "py-1" : "h-5 text-[10px]"
      )}
      title={details ? `${display.name} · ${details}` : display.name}
    >
      <Bot className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{display.name}</span>
      {display.source && (
        <span className="shrink-0 border-l border-foreground/10 pl-1.5 text-[10px] font-normal text-muted-foreground">
          {display.source}
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-sm p-0.5 transition-colors hover:bg-background/60 hover:text-foreground"
          aria-label={`Remove ${display.name}`}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </Badge>
  )
}

export function ProcessScreen({ onClose }: { onClose: () => void }) {
  const [definitions, setDefinitions] = useState<ProcessDefinition[] | null>(
    null
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pane, setPane] = useState<PaneMode>("builder")
  // The run being monitored (set when a run is started or opened from history).
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  // Available agents to populate each phase's pool picker. Empty until 027 lets
  // users author agents in-app; the builder degrades gracefully (a free-text
  // agent name still works via the pool row).
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [pendingDelete, setPendingDelete] = useState<ProcessDefinition | null>(
    null
  )
  // Free-text filter over the process cards (matches name + description).
  const [query, setQuery] = useState("")

  const loadDefinitions = useCallback(async () => {
    const list = await window.cowork.db.processes.list()
    setDefinitions(list)
  }, [])

  // Load on mount. The component is mounted only while the Process view is open
  // (main.tsx renders it conditionally), so it starts fresh each time.
  useEffect(() => {
    loadDefinitions()
    window.cowork.agents
      .list()
      .then(setAgents)
      .catch(() => setAgents([]))
  }, [loadDefinitions])

  // Esc closes the view, dropping the user back to their last open conversation.
  // Matches the sidebar-navigation behavior.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  // Guard against acting on a definition that vanished from a refreshed list.
  useEffect(() => {
    if (
      selectedId &&
      definitions &&
      !definitions.some((d) => d.id === selectedId)
    ) {
      setSelectedId(null)
      setActiveRunId(null)
    }
  }, [definitions, selectedId])

  const selected = useMemo(
    () => definitions?.find((d) => d.id === selectedId) ?? null,
    [definitions, selectedId]
  )

  // The definitions to show: filtered by the free-text query (matches name +
  // description), sorted alphabetically by name.
  const visible = useMemo(() => {
    if (!definitions) return []
    const q = query.trim().toLowerCase()
    return [...definitions]
      .filter(
        (d) =>
          !q ||
          d.name.toLowerCase().includes(q) ||
          (d.description ?? "").toLowerCase().includes(q)
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      )
  }, [definitions, query])

  async function createDefinition() {
    try {
      const def = await window.cowork.db.processes.create({
        name: "New Process",
      })
      loadDefinitions()
      setSelectedId(def.id)
      setPane("builder")
      setActiveRunId(null)
    } catch (err) {
      toast.error(`Could not create process: ${err}`)
    }
  }

  async function importDefinition() {
    try {
      const result = await window.cowork.process.importDefinition()
      if (result.canceled) return
      await loadDefinitions()
      setSelectedId(result.processId)
      setPane("builder")
      setActiveRunId(null)
      if (result.warnings.length > 0) {
        toast.warning(
          `Imported with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`,
          { description: result.warnings.slice(0, 2).join(" ") }
        )
      } else {
        toast.success(`Imported ${result.path}`)
      }
    } catch (err) {
      toast.error(`Could not import process: ${err}`)
    }
  }

  async function exportDefinition(definition: ProcessDefinition) {
    try {
      const result = await window.cowork.process.exportDefinition(definition.id)
      if (result.canceled) return
      toast.success(`Exported ${definition.name}`)
    } catch (err) {
      toast.error(`Could not export process: ${err}`)
    }
  }

  // Return from a builder/run takeover to the card browser.
  function backToCards() {
    setSelectedId(null)
    setActiveRunId(null)
    setPane("builder")
  }

  async function confirmDelete() {
    const target = pendingDelete
    setPendingDelete(null)
    if (!target) return
    try {
      await window.cowork.db.processes.delete(target.id)
      if (selectedId === target.id) {
        setSelectedId(null)
        setActiveRunId(null)
      }
      loadDefinitions()
      toast.success("Process deleted")
    } catch (err) {
      toast.error(`Could not delete process: ${err}`)
    }
  }

  return (
    <div
      data-slot="process-screen"
      className="flex min-h-0 flex-1 flex-col bg-background pt-11 text-sm text-foreground"
    >
      {/* Header row (matches the app's h-11 top bar; the Shell drag bar sits
          above via pt-11). */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close processes"
          className="group/back flex items-center gap-2 rounded-md text-left"
        >
          <ArrowLeft className="size-4 text-muted-foreground transition-colors group-hover/back:text-foreground" />
          <h1 className="font-heading text-base font-medium">Processes</h1>
        </button>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      {selected ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={backToCards}
                aria-label="Back to processes"
              >
                <ArrowLeft />
              </Button>
              <div className="min-w-0">
                <p className="truncate font-medium">{selected.name}</p>
                {selected.description && (
                  <p className="truncate text-xs text-muted-foreground">
                    {selected.description}
                  </p>
                )}
              </div>
            </div>
            <ButtonGroup>
              <Button
                type="button"
                size="sm"
                variant={pane === "builder" ? "default" : "outline"}
                onClick={() => setPane("builder")}
              >
                Builder
              </Button>
              <Button
                type="button"
                size="sm"
                variant={pane === "run" ? "default" : "outline"}
                onClick={() => setPane("run")}
              >
                Runs
              </Button>
            </ButtonGroup>
          </div>
          {pane === "builder" ? (
            <ProcessBuilder
              key={selected.id}
              definition={selected}
              agents={agents}
              definitions={definitions ?? []}
              onDefinitionChanged={loadDefinitions}
            />
          ) : (
            <RunMonitor
              key={selected.id}
              definition={selected}
              activeRunId={activeRunId}
              onSelectRun={setActiveRunId}
            />
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Toolbar — New Process action + count. */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
            <span className="text-xs text-muted-foreground">
              {definitions === null
                ? "…"
                : `${definitions.length} ${definitions.length === 1 ? "process" : "processes"}`}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={importDefinition}
              >
                <Upload className="size-4" />
                Import
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={createDefinition}
              >
                <Plus className="size-4" />
                New Process
              </Button>
            </div>
          </div>

          <div className="shrink-0 border-b px-4 py-2">
            <FilterInput
              value={query}
              onChange={setQuery}
              placeholder="Filter processes…"
            />
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              {definitions !== null && definitions.length === 0 && (
                <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                  No processes yet. Create one to build a DAG.
                </p>
              )}
              {definitions !== null &&
                definitions.length > 0 &&
                visible.length === 0 && (
                  <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                    No processes match your filter.
                  </p>
                )}
              {visible.length > 0 && (
                <CardGrid>
                  {visible.map((d) => (
                    <ProcessCard
                      key={d.id}
                      definition={d}
                      onOpen={() => {
                        setSelectedId(d.id)
                        setPane("builder")
                        setActiveRunId(null)
                      }}
                      onExport={() => exportDefinition(d)}
                      onDelete={() => setPendingDelete(d)}
                    />
                  ))}
                </CardGrid>
              )}
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Confirmation before deleting a definition — deletion is irreversible and
          cascades to phases / agents / edges (but not past runs). */}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this process?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.name}” and its phases, agent pools, and edges
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
    </div>
  )
}

// The card-filter text field: a search icon + input, with a clear button once
// the user has typed.
function FilterInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => onChange("")}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}

// A responsive grid of process cards.
function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,20rem))] gap-3">
      {children}
    </div>
  )
}

// One clickable process card: name + (clamped) description, with a hover delete.
function ProcessCard({
  definition,
  onOpen,
  onExport,
  onDelete,
}: {
  definition: ProcessDefinition
  onOpen: () => void
  onExport: () => void
  onDelete: () => void
}) {
  return (
    <Card
      size="sm"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className="cursor-pointer transition-shadow hover:ring-foreground/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <CardHeader>
        <CardTitle className="truncate">{definition.name}</CardTitle>
        <CardAction className="flex items-center gap-1">
          <button
            type="button"
            aria-label={`Export ${definition.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onExport()
            }}
            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/card:opacity-100 hover:bg-muted hover:text-foreground focus:opacity-100"
          >
            <Download className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${definition.name}`}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/card:opacity-100 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </button>
        </CardAction>
        {definition.description && (
          <CardDescription className="line-clamp-2">
            {definition.description}
          </CardDescription>
        )}
      </CardHeader>
    </Card>
  )
}

// The last path segment of a folder (its display name), trailing slashes
// trimmed. The full path stays in the pill's title tooltip and is what's passed
// to the run — this is display-only so a long path can't blow out the modal.
function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "")
  const seg = trimmed.split(/[/\\]/).pop()
  return seg || trimmed || path
}

// A stable, human-ish phase key derived from a name (the scheduler keys events
// on it). Kept lowercase-alnum-underscore so it reads in the monitor.
function slugifyKey(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "phase"
  )
}

// A phase's key is derived from its name (plan 030c) so the dot-folder path
// (`.<key>/`) is human-readable (`.plan/`, not `.phase_1_1/`). Since the DB
// enforces UNIQUE (process_id, key), a same-name collision appends `_<n>` until
// unique against the OTHER phases' keys in the same process.
function deriveKey(name: string, otherKeys: Iterable<string>): string {
  const base = slugifyKey(name)
  const taken = new Set(otherKeys)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`
    if (!taken.has(candidate)) return candidate
  }
}

// ─── The DAG builder ────────────────────────────────────────────────────────
// List-based (plan 026 v1): phases as cards, dependencies as per-phase "depends
// on" checkboxes (the graph is implicit in the edges). Every mutation writes
// through the `db.processes.*` CRUD then reloads the whole graph — the
// mutate-then-refetch pattern from SkillsScreen — since agent-pool and edge rows
// have no update verb (edit = delete + recreate).
function ProcessBuilder({
  definition,
  agents,
  definitions,
  onDefinitionChanged,
}: {
  definition: ProcessDefinition
  agents: AgentSummary[]
  definitions: ProcessDefinition[]
  onDefinitionChanged: () => void
}) {
  const [graph, setGraph] = useState<ProcessGraph | null>(null)

  const reload = useCallback(() => {
    window.cowork.db.processes.get(definition.id).then(setGraph)
  }, [definition.id])

  useEffect(() => {
    setGraph(null)
    reload()
  }, [reload])

  const phases = useMemo(
    () =>
      graph ? [...graph.phases].sort((a, b) => a.position - b.position) : [],
    [graph]
  )

  async function saveDefinition(patch: {
    name?: string
    description?: string | null
    requireFlagApproval?: boolean
  }) {
    try {
      await window.cowork.db.processes.update(definition.id, patch)
      onDefinitionChanged()
      reload()
    } catch (err) {
      toast.error(`Could not save process: ${err}`)
    }
  }

  async function addPhase() {
    const n = phases.length + 1
    const name = `Phase ${n}`
    try {
      await window.cowork.db.processes.phases.create({
        processId: definition.id,
        key: deriveKey(
          name,
          phases.map((p) => p.key)
        ),
        name,
        position: n,
      })
      reload()
    } catch (err) {
      toast.error(`Could not add phase: ${err}`)
    }
  }

  // Drag-to-reorder. `position` is display/authoring order only (execution order
  // is the process_edges DAG). On drop we renumber the whole list to 1..n, which
  // also closes any gaps left behind by deletes. Positions have no UNIQUE
  // constraint, so transient overlaps during the writes are safe.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  async function reorderPhases(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id || !graph) return
    const oldIndex = phases.findIndex((p) => p.id === active.id)
    const newIndex = phases.findIndex((p) => p.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const prevPos = new Map(phases.map((p) => [p.id, p.position]))
    const reordered = arrayMove(phases, oldIndex, newIndex)
    // Optimistic: renumber to 1..n and reflect immediately.
    const renumbered = reordered.map((p, i) => ({ ...p, position: i + 1 }))
    setGraph({ ...graph, phases: renumbered })

    try {
      await Promise.all(
        renumbered
          .filter((p) => prevPos.get(p.id) !== p.position)
          .map((p) =>
            window.cowork.db.processes.phases.update(p.id, {
              position: p.position,
            })
          )
      )
      reload()
    } catch (err) {
      toast.error(`Could not reorder phases: ${err}`)
      reload()
    }
  }

  if (graph === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    )
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
        {/* Definition meta. */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            Name
          </label>
          <Input
            defaultValue={definition.name}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && v !== definition.name) saveDefinition({ name: v })
            }}
          />
          <label className="text-xs font-medium text-muted-foreground">
            Description
          </label>
          <Textarea
            defaultValue={definition.description ?? ""}
            placeholder="What this process does…"
            className="min-h-16 resize-y"
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v !== (definition.description ?? "")) {
                saveDefinition({ description: v || null })
              }
            }}
          />
          {/* Cross-phase flag-back autonomy (plan 031.2). When OFF (the default,
              requireFlagApproval true), a phase's flag_for_rework raises a
              confirmation card before the send-back; when ON, the engine routes
              flags autonomously. */}
          <label
            className="mt-1 flex items-center gap-2 text-xs"
            title="When on, a phase that flags an earlier phase for rework is routed automatically, with no confirmation card"
          >
            <Switch
              checked={!definition.requireFlagApproval}
              onCheckedChange={(v) =>
                saveDefinition({ requireFlagApproval: !v })
              }
            />
            <span className="text-muted-foreground">
              Autonomous rework routing (skip flag confirmation)
            </span>
          </label>
        </div>

        {/* Phases. */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="font-heading text-sm font-medium">
              Phases
              <span className="ml-1 text-muted-foreground">
                ({phases.length})
              </span>
            </h3>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addPhase}
            >
              <Plus className="size-4" />
              Add phase
            </Button>
          </div>
          {phases.length === 0 && (
            <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              No phases yet. Add one to start building the DAG.
            </p>
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={reorderPhases}
          >
            <SortableContext
              items={phases.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              {phases.map((phase) => (
                <PhaseCard
                  key={phase.id}
                  phase={phase}
                  phases={phases}
                  graph={graph}
                  agents={agents}
                  definitions={definitions}
                  onChanged={reload}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>

        <p className="text-xs text-muted-foreground">
          Start runs from the <span className="font-medium">Runs</span> tab.
        </p>
      </div>
    </ScrollArea>
  )
}

// One phase card: name/key, routing / gate / fan-out toggles, the agent pool,
// and the "depends on" edge selector.
function PhaseCard({
  phase,
  phases,
  graph,
  agents,
  definitions,
  onChanged,
}: {
  phase: ProcessPhase
  phases: ProcessPhase[]
  graph: ProcessGraph
  agents: AgentSummary[]
  definitions: ProcessDefinition[]
  onChanged: () => void
}) {
  // This phase's agent pool + its incoming edges (edges where to === this phase).
  const pool = useMemo(
    () =>
      graph.agents
        .filter((a) => a.phaseId === phase.id)
        .sort((a, b) => a.position - b.position),
    [graph.agents, phase.id]
  )
  const incoming = useMemo(
    () => graph.edges.filter((e) => e.toPhaseId === phase.id),
    [graph.edges, phase.id]
  )
  const upstreamCandidates = phases.filter((p) => p.id !== phase.id)
  // Agents not already in the pool, for the add dropdown.
  const poolNames = new Set(pool.map((a) => a.agentName))
  const addable = agents.filter((a) => !poolNames.has(agentValue(a)))
  const agentsByValue = useMemo(
    () => new Map(agents.map((agent) => [agentValue(agent), agent])),
    [agents]
  )
  const reviewerAgentItems = useMemo(
    () => [
      {
        value: OWN_AGENT,
        label: "Phase's own agent",
        description: "Use the phase's first pool agent",
      },
      ...agents.map((agent) => ({
        value: agentValue(agent),
        label: agentLabel(agent),
        description: agent.description,
        name: agent.name,
        source: [agent.sourceKind, agent.scope].filter(Boolean).join(" · "),
      })),
    ],
    [agents]
  )
  const selectedReviewerAgent =
    reviewerAgentItems.find(
      (item) =>
        item.value === (phase.validatorAgent ?? OWN_AGENT) ||
        ("name" in item && item.name === phase.validatorAgent)
    ) ?? reviewerAgentItems[0]
  // Collapsed by default — a built graph is mostly read; expand to edit.
  const [expanded, setExpanded] = useState(false)
  const depCount = incoming.length
  // Sub-process picker (plan 038.1): candidate definitions minus self (the repo
  // hard-rejects self / cycles; this just avoids offering the trivial self-pick).
  const subprocessCandidates = definitions.filter(
    (d) => d.id !== phase.processId
  )
  const subprocessName = phase.subprocessId
    ? (definitions.find((d) => d.id === phase.subprocessId)?.name ??
      "(missing)")
    : null

  // Drag-to-reorder wiring. Only the grip handle gets the listeners so the
  // collapsible trigger and inner inputs stay clickable.
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: phase.id })
  const sortableStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 1 : undefined,
    opacity: isDragging ? 0.6 : undefined,
  }

  async function patchPhase(patch: {
    name?: string
    key?: string
    routing?: PhaseRouting
    gatePolicy?: PhaseGatePolicy
    fanOut?: boolean
    maxReworkRounds?: number
    dotFolder?: boolean
    validator?: boolean
    validatorMaxIterations?: number
    validatorAgent?: string | null
    subprocessId?: string | null
  }) {
    try {
      await window.cowork.db.processes.phases.update(phase.id, patch)
      onChanged()
    } catch (err) {
      toast.error(`Could not update phase: ${err}`)
    }
  }

  async function deletePhase() {
    try {
      await window.cowork.db.processes.phases.delete(phase.id)
      onChanged()
    } catch (err) {
      toast.error(`Could not delete phase: ${err}`)
    }
  }

  async function addPoolAgent(agentName: string) {
    if (!agentName) return
    try {
      await window.cowork.db.processes.agents.create({
        phaseId: phase.id,
        agentName,
        position: pool.length,
      })
      onChanged()
    } catch (err) {
      toast.error(`Could not add agent: ${err}`)
    }
  }

  async function removePoolAgent(id: string) {
    try {
      await window.cowork.db.processes.agents.delete(id)
      onChanged()
    } catch (err) {
      toast.error(`Could not remove agent: ${err}`)
    }
  }

  // Toggle an incoming edge from `fromId`. Adding uses the current trigger
  // default (on_complete); removing deletes the edge row.
  async function toggleDependency(fromId: string, on: boolean) {
    try {
      if (on) {
        await window.cowork.db.processes.edges.create({
          processId: phase.processId,
          fromPhaseId: fromId,
          toPhaseId: phase.id,
        })
      } else {
        const edge = incoming.find((e) => e.fromPhaseId === fromId)
        if (edge) await window.cowork.db.processes.edges.delete(edge.id)
      }
      onChanged()
    } catch (err) {
      toast.error(`Could not update dependency: ${err}`)
    }
  }

  // Change an existing edge's trigger — no update verb, so delete + recreate.
  async function changeTrigger(fromId: string, trigger: EdgeTrigger) {
    const edge = incoming.find((e) => e.fromPhaseId === fromId)
    if (!edge) return
    try {
      await window.cowork.db.processes.edges.delete(edge.id)
      await window.cowork.db.processes.edges.create({
        processId: phase.processId,
        fromPhaseId: fromId,
        toPhaseId: phase.id,
        trigger,
      })
      onChanged()
    } catch (err) {
      toast.error(`Could not change trigger: ${err}`)
    }
  }

  return (
    <Collapsible
      ref={setNodeRef}
      style={sortableStyle}
      open={expanded}
      onOpenChange={setExpanded}
      className="rounded-lg border bg-card"
    >
      {/* Summary row (always visible): grip + chevron + name + at-a-glance badges
          + delete. Click toggles expand; the delete button stops propagation. */}
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="-ml-1 shrink-0 cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
          title="Drag to reorder"
          aria-label="Drag to reorder phase"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group/phase flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/phase:rotate-90" />
            <span className="truncate font-medium">{phase.name}</span>
            <div className="flex shrink-0 flex-wrap items-center gap-1">
              <Badge variant="outline" className="text-[10px]">
                {phase.routing}
              </Badge>
              {phase.gatePolicy === "approve" && (
                <Badge variant="outline" className="text-[10px]">
                  gate
                </Badge>
              )}
              {phase.fanOut && (
                <Badge variant="outline" className="text-[10px]">
                  fan-out
                </Badge>
              )}
              {subprocessName && (
                <Badge
                  variant="outline"
                  className="text-[10px]"
                  title={`Runs the "${subprocessName}" sub-process (plan 038.1)`}
                >
                  ⤷ {subprocessName}
                </Badge>
              )}
              {phase.dotFolder && (
                <Badge
                  variant="outline"
                  className="font-mono text-[10px]"
                  title="Artifacts written under this dot-folder"
                >
                  .{phase.key}/
                </Badge>
              )}
              {phase.validator && (
                <Badge
                  variant="outline"
                  className="text-[10px]"
                  title="A second agent reviews this phase's output (plan 031.1)"
                >
                  validator
                </Badge>
              )}
              <Badge variant="secondary" className="text-[10px]">
                {pool.length} {pool.length === 1 ? "agent" : "agents"}
              </Badge>
              {depCount > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {depCount} dep{depCount === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
          </button>
        </CollapsibleTrigger>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={deletePhase}
          title="Delete phase"
          className="shrink-0 text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <CollapsibleContent>
        <div className="flex flex-col gap-3 border-t p-3">
          {/* Row 1: name. The key auto-derives from the name (plan 030c) and is
              shown read-only — it's the `.<key>/` dot-folder path (plan 030a). */}
          <div className="flex items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Input
                defaultValue={phase.name}
                className="h-8 font-medium"
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (!v || v === phase.name) return
                  // Re-derive the key from the new name, unique against the OTHER
                  // phases' keys in this process.
                  const key = deriveKey(
                    v,
                    phases.filter((p) => p.id !== phase.id).map((p) => p.key)
                  )
                  patchPhase({ name: v, key })
                }}
              />
            </div>
            <span
              className="shrink-0 self-center font-mono text-xs text-muted-foreground"
              title="Phase key (auto-derived from the name; used in run events and the dot-folder path)"
            >
              {phase.key}
            </span>
          </div>

          {/* Row 2: routing / gate / fan-out. */}
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Routing</span>
              <Select
                value={phase.routing}
                onValueChange={(v) =>
                  patchPhase({ routing: v as PhaseRouting })
                }
              >
                <SelectTrigger size="sm" className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">single</SelectItem>
                  <SelectItem value="dispatch">dispatch</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Gate</span>
              <Select
                value={phase.gatePolicy}
                onValueChange={(v) =>
                  patchPhase({ gatePolicy: v as PhaseGatePolicy })
                }
              >
                <SelectTrigger size="sm" className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto</SelectItem>
                  <SelectItem value="approve">approve</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label
              className="flex items-center gap-2 text-xs"
              title="Split this phase into independent sub-tasks. Combine with Sub-process to run the sub-process once per sub-task (plan 038.3)."
            >
              <span className="text-muted-foreground">Fan-out</span>
              <Switch
                checked={phase.fanOut}
                onCheckedChange={(v) => patchPhase({ fanOut: v })}
              />
            </label>
            {/* SUB-PROCESS phase (plan 038.1): run another definition as a nested
            run instead of an agent worker. Combinable with fan-out (plan 038.3): a
            phase with both decomposes into sub-tasks and runs the sub-process once
            per child. Only offered when there's a candidate definition to run. */}
            {subprocessCandidates.length > 0 && (
              <label
                className="flex items-center gap-2 text-xs"
                title="Run another process definition as a nested run for this phase (once per fan-out child when fan-out is also on)"
              >
                <span className="text-muted-foreground">Sub-process</span>
                <Switch
                  checked={!!phase.subprocessId}
                  onCheckedChange={(v) =>
                    patchPhase({
                      subprocessId: v ? subprocessCandidates[0].id : null,
                    })
                  }
                />
              </label>
            )}
            <label
              className="flex items-center gap-2 text-xs"
              title={`Steer this phase's agent to write artifacts under a .${phase.key}/ folder (plan 030)`}
            >
              <span className="text-muted-foreground">Dot-folder</span>
              <Switch
                checked={phase.dotFolder}
                onCheckedChange={(v) => patchPhase({ dotFolder: v })}
              />
            </label>
            {/* Per-phase VALIDATOR (plan 031.1): a second agent reviews this phase's
            output and sends it back with feedback until it passes, bounded. Not
            offered for a fan-out phase (sub-DAG review is plan 031.2) or a
            sub-process phase (its inner phases carry their own validators, 038.1). */}
            {!phase.fanOut && !phase.subprocessId && (
              <label
                className="flex items-center gap-2 text-xs"
                title="After this phase completes, a second agent reviews its output and can send it back with feedback (bounded)"
              >
                <span className="text-muted-foreground">Validator</span>
                <Switch
                  checked={phase.validator}
                  onCheckedChange={(v) =>
                    // Seed a concrete default cap (3) when enabling, so the field never
                    // sits at the 0 sentinel — the validator is bounded by construction.
                    patchPhase({
                      validator: v,
                      ...(v && phase.validatorMaxIterations < 1
                        ? { validatorMaxIterations: 3 }
                        : {}),
                    })
                  }
                />
              </label>
            )}
            {/* The "Request changes" rework cap (plan 029), only meaningful for an
            approve gate. 0 = unlimited. */}
            {phase.gatePolicy === "approve" &&
              !phase.fanOut &&
              !phase.subprocessId && (
                <label
                  className="flex items-center gap-2 text-xs"
                  title="Max times a reviewer can send this phase back for changes (0 = unlimited)"
                >
                  <span className="text-muted-foreground">Max rework</span>
                  <Input
                    type="number"
                    min={0}
                    className="h-7 w-16 text-xs"
                    value={phase.maxReworkRounds}
                    onChange={(e) => {
                      const n = Math.max(
                        0,
                        Math.floor(Number(e.target.value) || 0)
                      )
                      patchPhase({ maxReworkRounds: n })
                    }}
                  />
                </label>
              )}
          </div>

          {/* Validator config (plan 031.1): the reviewer agent + iteration cap, shown
          only when the validator toggle is on. */}
          {phase.validator && !phase.fanOut && !phase.subprocessId && (
            <div className="flex flex-wrap items-center gap-4">
              <label
                className="flex items-center gap-2 text-xs"
                title="The agent that reviews this phase's output. Defaults to the phase's own first pool agent."
              >
                <span className="text-muted-foreground">Reviewer</span>
                <Combobox
                  items={reviewerAgentItems}
                  value={selectedReviewerAgent}
                  isItemEqualToValue={(a, b) => a?.value === b?.value}
                  onValueChange={(item: { value: string } | null) => {
                    if (!item) return
                    void patchPhase({
                      validatorAgent:
                        item.value === OWN_AGENT ? null : item.value,
                    })
                  }}
                >
                  <ComboboxTrigger className="flex h-7 max-w-64 min-w-44 items-center justify-between gap-1 rounded-[min(var(--radius-md),10px)] border border-input bg-transparent px-2.5 text-xs transition-colors hover:bg-accent/50 dark:bg-input/30">
                    <ComboboxValue>
                      {(item: (typeof reviewerAgentItems)[number] | null) => (
                        <span className="truncate">
                          {item?.label ?? "Phase's own agent"}
                        </span>
                      )}
                    </ComboboxValue>
                  </ComboboxTrigger>
                  <ComboboxContent className="w-80 min-w-80">
                    <ComboboxInput
                      placeholder="Search reviewer agents…"
                      showTrigger={false}
                    />
                    <ComboboxEmpty>No agents found.</ComboboxEmpty>
                    <ComboboxList>
                      {(item: (typeof reviewerAgentItems)[number]) => (
                        <ComboboxItem key={item.value} value={item}>
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="truncate">{item.label}</span>
                            {(item.description ||
                              ("source" in item && item.source)) && (
                              <span className="line-clamp-2 text-[10px] text-muted-foreground">
                                {[
                                  item.description,
                                  "source" in item ? item.source : undefined,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            )}
                          </span>
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </label>
              <label
                className="flex items-center gap-2 text-xs"
                title="Max validator review rounds before escalating to a human gate"
              >
                <span className="text-muted-foreground">Max iterations</span>
                <Input
                  type="number"
                  min={1}
                  className="h-7 w-16 text-xs"
                  // A legacy 0 (the engine's "use default" sentinel) reads as 3 here so
                  // the control never shows 0; the floor is 1 (never zero reviews).
                  value={
                    phase.validatorMaxIterations < 1
                      ? 3
                      : phase.validatorMaxIterations
                  }
                  onChange={(e) => {
                    const n = Math.max(
                      1,
                      Math.floor(Number(e.target.value) || 1)
                    )
                    patchPhase({ validatorMaxIterations: n })
                  }}
                />
              </label>
            </div>
          )}

          {/* Sub-process config (plan 038.1): the definition this phase runs as a
          nested run, shown only when the sub-process toggle is on. Self is filtered
          out; the repo hard-rejects a cyclic pick (surfaced via the patch toast). */}
          {phase.subprocessId && (
            <div className="flex flex-col gap-1.5">
              <label
                className="flex items-center gap-2 text-xs"
                title="The process definition this phase runs as a nested run"
              >
                <span className="text-muted-foreground">Runs process</span>
                <Select
                  value={phase.subprocessId}
                  onValueChange={(v) =>
                    patchPhase({
                      subprocessId: v === NO_SUBPROCESS ? null : v,
                    })
                  }
                >
                  <SelectTrigger size="sm" className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SUBPROCESS}>None</SelectItem>
                    {subprocessCandidates.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <span className="text-[10px] text-muted-foreground">
                {phase.fanOut
                  ? "This phase fans out into sub-tasks and runs the nested process once per sub-task (plan 038.3); the pool decomposes. Each child's aggregated output feeds downstream phases."
                  : "This phase delegates to the nested process; its aggregated output feeds downstream phases. The agent pool and routing are unused."}
              </span>
            </div>
          )}

          {/* Row 3: agent pool. Hidden for a PURE sub-process phase (no worker to
          pool). A combined fan-out + sub-process phase (plan 038.3) still needs the
          pool for its decomposition pass, so show it when fan-out is on. */}
          {(!phase.subprocessId || phase.fanOut) && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">
                Agent pool
                {phase.routing === "dispatch" && pool.length < 2 && (
                  <span className="ml-1 text-amber-600 dark:text-amber-500">
                    — dispatch routing needs 2+ agents
                  </span>
                )}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {pool.map((a) => {
                  const catalogAgent = agentsByValue.get(a.agentName)
                  return (
                    <AgentIdentityBadge
                      key={a.id}
                      value={a.agentName}
                      metadata={catalogAgent}
                      onRemove={() => removePoolAgent(a.id)}
                    />
                  )
                })}
                {pool.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    No agents — the phase falls back to the default agent.
                  </span>
                )}
              </div>
              {addable.length > 0 ? (
                // Type-to-filter agent picker (mirrors App.tsx's agent combobox).
                // It's an action picker — selecting adds to the pool and the value
                // stays unselected, so the trigger always reads "Add agent…".
                <Combobox
                  items={addable.map((a) => ({
                    value: agentValue(a),
                    label: agentLabel(a),
                    description: a.description,
                  }))}
                  value={null}
                  isItemEqualToValue={(a, b) => a?.value === b?.value}
                  onValueChange={(item: { value: string } | null) => {
                    if (item) void addPoolAgent(item.value)
                  }}
                >
                  <ComboboxTrigger className="flex h-7 w-full items-center justify-between gap-1 rounded-[min(var(--radius-md),10px)] border border-input bg-transparent px-2.5 text-xs transition-colors hover:bg-accent/50 dark:bg-input/30">
                    <ComboboxValue placeholder="Add agent…" />
                  </ComboboxTrigger>
                  <ComboboxContent className="w-(--anchor-width)">
                    <ComboboxInput
                      placeholder="Search agents…"
                      showTrigger={false}
                    />
                    <ComboboxEmpty>No agents found.</ComboboxEmpty>
                    <ComboboxList>
                      {(item: {
                        value: string
                        label: string
                        description?: string
                      }) => (
                        <ComboboxItem key={item.value} value={item}>
                          <span className="flex flex-col gap-0.5">
                            <span>{item.label}</span>
                            {item.description && (
                              <span className="line-clamp-2 text-[10px] text-muted-foreground">
                                {item.description}
                              </span>
                            )}
                          </span>
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              ) : (
                agents.length === 0 && (
                  <span className="text-xs text-muted-foreground">
                    No authored agents available yet.
                  </span>
                )
              )}
            </div>
          )}

          {/* Row 4: dependencies (incoming edges). */}
          {upstreamCandidates.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">Depends on</span>
              <div className="flex flex-col gap-1">
                {upstreamCandidates.map((u) => {
                  const edge = incoming.find((e) => e.fromPhaseId === u.id)
                  const checked = edge !== undefined
                  return (
                    <div key={u.id} className="flex items-center gap-2 text-xs">
                      <Checkbox
                        id={`${phase.id}-dep-${u.id}`}
                        checked={checked}
                        onCheckedChange={(v) =>
                          toggleDependency(u.id, v === true)
                        }
                      />
                      <label
                        htmlFor={`${phase.id}-dep-${u.id}`}
                        className="cursor-pointer truncate"
                      >
                        {u.name}
                      </label>
                      {checked && edge && (
                        <Select
                          value={edge.trigger}
                          onValueChange={(v) =>
                            changeTrigger(u.id, v as EdgeTrigger)
                          }
                        >
                          <SelectTrigger size="sm" className="ml-auto text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="on_complete">
                              on complete
                            </SelectItem>
                            <SelectItem value="on_each_subtask">
                              on each subtask
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// ─── The run monitor ─────────────────────────────────────────────────────────
// Picks a run for the definition, then colors its phases live. Phase-run rows
// (status, agent, parent, timestamps) come from the DB and are refetched on any
// `process_phase` event on the run's backing task; the requestId a gated phase
// needs to approve/deny is carried only on the event (not the DB row), so it's
// reconstructed from the task event stream (replay + live tail) into a
// phaseRunId → requestId map. Reuses `window.cowork.tasks.onEvent` filtered by
// the run's taskId (process runs ride the task tail — no separate channel).

// Statuses that mean the run is still doing something (offer pause/cancel).
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "running",
  "waiting_for_approval",
  "paused",
])

// A terminal run cannot still own live phase work. Older runs created before the
// nested-failure drain fix can nevertheless contain `running`/`ready` rows because
// their scheduler exited before observing parallel siblings. Keep those historical
// rows from rendering an infinite spinner; the transcript remains available and a
// retry still reads the untouched durable frontier from the main process.
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"])
const LIVE_PHASE_STATUSES = new Set<PhaseRunStatus>([
  "ready",
  "running",
  "waiting_for_approval",
])

function phaseRunsForDisplay(
  run: ProcessRun | null,
  phaseRuns: ProcessPhaseRun[]
): ProcessPhaseRun[] {
  if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) return phaseRuns
  return phaseRuns.map((phaseRun) =>
    LIVE_PHASE_STATUSES.has(phaseRun.status)
      ? { ...phaseRun, status: "cancelled" }
      : phaseRun
  )
}

function RunMonitor({
  definition,
  activeRunId,
  onSelectRun,
}: {
  definition: ProcessDefinition
  activeRunId: string | null
  onSelectRun: (runId: string) => void
}) {
  const [runs, setRuns] = useState<ProcessRun[] | null>(null)
  const [run, setRun] = useState<ProcessRun | null>(null)
  const [phaseRuns, setPhaseRuns] = useState<ProcessPhaseRun[]>([])
  const [graph, setGraph] = useState<ProcessGraph | null>(null)
  // phaseRunId → the pending phase/validator gate (derived from the event stream).
  const [gates, setGates] = useState<Record<string, GateInfo>>({})
  // requestId → durable request blob, including the approval review packet when
  // available. Rebuilt from approvals on load/replay and refreshed on live gates.
  const [gateRequests, setGateRequests] = useState<
    Record<string, ProcessGateRequest>
  >({})
  // phaseRunId → a pending cross-phase rework flag awaiting confirmation (plan
  // 031.2): the flagging phase's card shows the target + reason with Approve
  // send-back / Dismiss. Sourced from the durable approvals list (the flag gate's
  // request blob carries target + reason), reconciled like `gates`.
  const [flagGates, setFlagGates] = useState<Record<string, FlagGateInfo>>({})
  // A monotonically-increasing tick bumped on every live task event, threaded into
  // the sub-process nested view so it re-fetches its child run's phase-runs as they
  // progress (plan 038.1). A nested run rides the SAME task tail, but its rows live
  // in a separate lazily-fetched component — this is how the live tail reaches it.
  const [refreshTick, setRefreshTick] = useState(0)
  // The New Run modal (objective + required folder).
  const [newRunOpen, setNewRunOpen] = useState(false)
  // The phase-run whose worker transcript is open (null = closed). Resolved from
  // the phase-run's taskId → the worker Task the read-only sheet renders.
  const [viewingTask, setViewingTask] = useState<Task | null>(null)
  const [reviewTarget, setReviewTarget] = useState<ApprovalReviewTarget | null>(
    null
  )
  // Absolute path of the run's workspace, resolved from run.workspaceId (there's
  // no workspaces.get — list-and-find). Fed to the per-phase file chips (plan
  // 030b) to build file:// URLs, git diffs, and open-in-editor. "" when unknown.
  const [workspacePath, setWorkspacePath] = useState("")

  // Open a phase/child's worker transcript. Fetches the backing Task by its id;
  // no-op if the phase never spawned a worker (taskId null) or the task vanished.
  async function openTranscript(phaseRun: ProcessPhaseRun) {
    if (!phaseRun.taskId) return
    await openTaskById(phaseRun.taskId)
  }

  async function openTaskById(taskId: string) {
    const task = await window.cowork.db.tasks.get(taskId)
    if (task) setViewingTask(task)
  }

  const loadRuns = useCallback(
    () => window.cowork.db.processes.runs.list({ processId: definition.id }),
    [definition.id]
  )

  // Latest run + phaseRuns fetch, kept in a ref so the event listener can call
  // it without re-subscribing on every render.
  const refetch = useCallback(async () => {
    if (!activeRunId) return
    const [r, prs] = await Promise.all([
      window.cowork.db.processes.runs.get(activeRunId),
      window.cowork.db.processes.phaseRuns.list({ runId: activeRunId }),
    ])
    setRun(r)
    setPhaseRuns(phaseRunsForDisplay(r, prs))
  }, [activeRunId])
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch

  // Load the run list for this definition when the monitor mounts / definition
  // changes. Auto-select the newest run if none is active.
  useEffect(() => {
    let cancelled = false
    loadRuns().then((rs) => {
      if (cancelled) return
      setRuns(rs)
      if (!activeRunId && rs.length > 0) onSelectRun(rs[0].id)
    })
    window.cowork.db.processes.get(definition.id).then((g) => {
      if (!cancelled) setGraph(g)
    })
    return () => {
      cancelled = true
    }
    // onSelectRun/activeRunId intentionally excluded — only re-list on def change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition.id, loadRuns])

  // Load the selected run + rebuild the gate map from its replayed event stream.
  useEffect(() => {
    setGates({})
    setGateRequests({})
    setReviewTarget(null)
    if (!activeRunId) {
      setRun(null)
      setPhaseRuns([])
      return
    }
    let cancelled = false
    void refetch()
    // Rebuild the gate map from the backing task's replayed events, then RECONCILE
    // against the durable approvals table. Reconciliation is required because the
    // engine emits no process_phase event for the gated phase on approve/resume
    // (the phase is already `completed`; resume re-emits only its dependents), so
    // the still-present `waiting_for_approval` event would otherwise resurrect a
    // gate the user already resolved. An approval row that's approved/denied means
    // the gate is settled → drop it.
    window.cowork.db.processes.runs.get(activeRunId).then((r) => {
      if (cancelled || !r?.taskId) return
      const taskId = r.taskId
      Promise.all([
        window.cowork.db.taskEvents.list(taskId),
        window.cowork.db.approvals.list({ taskId }),
      ]).then(([events, approvals]) => {
        if (cancelled) return
        const recovered = recoverProcessMonitorGates({
          events: events.map((e) => e.payload as TaskEventPayload),
          approvals,
        })
        setGates(recovered.gates)
        setFlagGates(recovered.flagGates)
        setGateRequests(recovered.requests)
      })
    })
    return () => {
      cancelled = true
    }
  }, [activeRunId, refetch])

  // Live tail: filter to this run's backing task, fold process_phase events into
  // the gate map, and refetch the phase-run rows on any of them.
  useEffect(() => {
    if (!run?.taskId) return
    const taskId = run.taskId
    const unsubscribe = window.cowork.tasks.onEvent(
      (payload: TaskLiveEvent) => {
        if (payload.taskId !== taskId) return
        const ev = payload.event
        if (ev.type === "process_phase") {
          setGates((g) => foldGate(g, ev))
          // A flag gate rides the same waiting_for_approval event but its target +
          // reason live on the durable approval row — refresh flagGates from it
          // (plan 031.2). Cheap: only the pending flag rows are kept.
          window.cowork.db.approvals.list({ taskId }).then((approvals) => {
            const info: Record<string, FlagGateInfo> = {}
            const requests: Record<string, ProcessGateRequest> = {}
            for (const a of approvals) {
              const req = a.request as ProcessGateRequest | null
              if (req?.requestId) requests[req.requestId] = req
              if (a.status !== "pending") continue
              if (req?.kind === "process_flag_gate")
                info[req.phaseRunId] = {
                  requestId: req.requestId,
                  targetKey: req.flagTargetKey ?? "",
                  reason: req.flagReason ?? "",
                }
            }
            setFlagGates(info)
            setGateRequests(requests)
          })
          void refetchRef.current()
          setRefreshTick((t) => t + 1)
        } else if (
          ev.type === "status_change" ||
          ev.type === "task_completed" ||
          ev.type === "task_failed"
        ) {
          void refetchRef.current()
          setRefreshTick((t) => t + 1)
        }
      }
    )
    return unsubscribe
  }, [run?.taskId])

  // Resolve the run's workspace path from its workspaceId (no workspaces.get →
  // list-and-find), for the per-phase file chips (plan 030b).
  useEffect(() => {
    const wsId = run?.workspaceId
    if (!wsId) {
      setWorkspacePath("")
      return
    }
    let cancelled = false
    window.cowork.db.workspaces.list().then((wss) => {
      if (cancelled) return
      setWorkspacePath(wss.find((w) => w.id === wsId)?.path ?? "")
    })
    return () => {
      cancelled = true
    }
  }, [run?.workspaceId])

  const phaseName = useCallback(
    (phaseId: string) =>
      graph?.phases.find((p) => p.id === phaseId)?.name ?? phaseId,
    [graph]
  )

  // The per-phase rework cap (0 = unlimited) for gating the Request-changes
  // control (plan 029).
  const phaseMaxRework = useCallback(
    (phaseId: string) =>
      graph?.phases.find((p) => p.id === phaseId)?.maxReworkRounds ?? 0,
    [graph]
  )

  // A container phase (fan-out, or an on_each_subtask consumer of a fan-out
  // source) can't be sent back for changes in v1 — the backend rejects it, so
  // hide the control. Mirrors the service's container predicate.
  const phaseIsContainer = useCallback(
    (phaseId: string) => {
      if (!graph) return false
      const phase = graph.phases.find((p) => p.id === phaseId)
      if (!phase) return false
      if (phase.fanOut) return true
      return graph.edges.some(
        (e) =>
          e.toPhaseId === phaseId &&
          e.trigger === "on_each_subtask" &&
          graph.phases.find((p) => p.id === e.fromPhaseId)?.fanOut === true
      )
    },
    [graph]
  )

  // Whether a phase runs a sub-process (plan 038.1) — its nested run is shown as an
  // expandable block under the phase row.
  const phaseIsSubProcess = useCallback(
    (phaseId: string) =>
      !!graph?.phases.find((p) => p.id === phaseId)?.subprocessId,
    [graph]
  )

  const canRequestChangesForPhase = useCallback(
    (phaseRun: ProcessPhaseRun) => {
      const max = phaseMaxRework(phaseRun.phaseId)
      return (
        !phaseIsContainer(phaseRun.phaseId) &&
        !(max > 0 && phaseRun.reworkRound >= max)
      )
    },
    [phaseIsContainer, phaseMaxRework]
  )

  const openApprovalReview = useCallback(
    (
      phaseRun: ProcessPhaseRun,
      name: string,
      requestId?: string,
      files?: ChangedFile[]
    ) => {
      const packet = requestId
        ? gateRequests[requestId]?.approvalPacket
        : undefined
      const request = requestId ? gateRequests[requestId] : undefined
      setReviewTarget({
        phaseRun,
        name,
        gateKind:
          request?.kind === "process_validator_gate" ? "validator" : "phase",
        requestId,
        packet,
        files,
        canRequestChanges: canRequestChangesForPhase(phaseRun),
      })
    },
    [canRequestChangesForPhase, gateRequests]
  )

  // Split into top-level phase runs (parentId null) and their children, so the
  // monitor can nest fan-out / on_each_subtask instances under their container.
  const { topLevel, childrenOf } = useMemo(() => {
    const top: ProcessPhaseRun[] = []
    const kids = new Map<string, ProcessPhaseRun[]>()
    for (const pr of phaseRuns) {
      if (pr.parentId) {
        const list = kids.get(pr.parentId) ?? []
        list.push(pr)
        kids.set(pr.parentId, list)
      } else {
        top.push(pr)
      }
    }
    return { topLevel: top, childrenOf: kids }
  }, [phaseRuns])

  // Drop a settled gate from the map. The engine emits no process_phase event for
  // the gated phase on approve/deny (it stays `completed`), so the live tail won't
  // clear it — we clear optimistically here.
  const clearGate = (phaseRunId: string) =>
    setGates((g) => {
      const next = { ...g }
      delete next[phaseRunId]
      return next
    })

  async function approve(requestId: string, phaseRunId: string) {
    if (!run) return
    clearGate(phaseRunId)
    setReviewTarget((target) =>
      target?.requestId === requestId ? null : target
    )
    try {
      await window.cowork.process.approve({ processRunId: run.id, requestId })
    } catch (err) {
      toast.error(`Could not approve phase: ${err}`)
    }
  }
  async function deny(requestId: string, phaseRunId: string) {
    if (!run) return
    clearGate(phaseRunId)
    setReviewTarget((target) =>
      target?.requestId === requestId ? null : target
    )
    try {
      await window.cowork.process.deny({ processRunId: run.id, requestId })
    } catch (err) {
      toast.error(`Could not deny phase: ${err}`)
    }
  }
  // Request changes: send the gated phase back to re-run with a feedback note,
  // then re-gate (plan 029). Clear optimistically; a fresh gate re-appears via the
  // live process_phase event when the re-run re-completes.
  async function requestChanges(
    requestId: string,
    phaseRunId: string,
    feedback: string
  ) {
    if (!run) return
    clearGate(phaseRunId)
    setReviewTarget((target) =>
      target?.requestId === requestId ? null : target
    )
    try {
      await window.cowork.process.requestChanges({
        processRunId: run.id,
        requestId,
        feedback,
      })
    } catch (err) {
      toast.error(`Could not request changes: ${err}`)
    }
  }

  async function retryReview(requestId: string, phaseRunId: string) {
    if (!run) return
    clearGate(phaseRunId)
    setReviewTarget((target) =>
      target?.requestId === requestId ? null : target
    )
    try {
      await window.cowork.process.retryReview({
        processRunId: run.id,
        requestId,
      })
    } catch (err) {
      toast.error(`Could not retry review: ${err}`)
    }
  }

  // Clear a pending flag from the flagGates map (plan 031.2). Optimistic — like
  // clearGate, the engine may not re-emit for this phase-run on resume.
  const clearFlag = (phaseRunId: string) =>
    setFlagGates((f) => {
      const next = { ...f }
      delete next[phaseRunId]
      return next
    })

  // Confirm a cross-phase rework flag: apply the send-back (target + downstream
  // re-run) then resume (plan 031.2).
  async function confirmFlag(requestId: string, phaseRunId: string) {
    if (!run) return
    clearFlag(phaseRunId)
    try {
      await window.cowork.process.confirmFlag({
        processRunId: run.id,
        requestId,
      })
    } catch (err) {
      toast.error(`Could not confirm rework flag: ${err}`)
    }
  }
  // Dismiss a cross-phase rework flag: the flagged phase's output stands; the run
  // continues (plan 031.2).
  async function dismissFlag(requestId: string, phaseRunId: string) {
    if (!run) return
    clearFlag(phaseRunId)
    try {
      await window.cowork.process.dismissFlag({
        processRunId: run.id,
        requestId,
      })
    } catch (err) {
      toast.error(`Could not dismiss rework flag: ${err}`)
    }
  }

  async function exportRunIncident() {
    if (!run) return
    try {
      const result = await window.cowork.process.exportRunIncident(run.id)
      if (result.canceled) return
      toast.success("Exported process incident")
    } catch (err) {
      toast.error(`Could not export process incident: ${err}`)
    }
  }

  // Start a new run of this definition (from the New Run modal). Refreshes the
  // run list, selects the new run, and closes the modal.
  async function startNewRun(objective: string, workspacePath: string) {
    const started = await window.cowork.process.startRun({
      processId: definition.id,
      sourceConversationId: null,
      objective: objective.trim(),
      workspacePath: workspacePath.trim(),
    })
    setRuns(await loadRuns())
    onSelectRun(started.id)
    setNewRunOpen(false)
    toast.success("Process run started")
  }

  const noPhases = (graph?.phases.length ?? 0) === 0

  if (runs === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    )
  }

  const runActive = run ? ACTIVE_RUN_STATUSES.has(run.status) : false

  // No runs yet — an actionable empty state (the modal renders below either way).
  if (runs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-muted-foreground">No runs yet.</p>
        <Button
          type="button"
          onClick={() => setNewRunOpen(true)}
          disabled={noPhases}
        >
          <Plus className="size-4" />
          New Run
        </Button>
        {noPhases && (
          <p className="text-xs text-muted-foreground">
            Add at least one phase in the Builder first.
          </p>
        )}
        <NewRunModal
          open={newRunOpen}
          onOpenChange={setNewRunOpen}
          onRun={startNewRun}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Run selector + controls. */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setNewRunOpen(true)}
          disabled={noPhases}
          title={noPhases ? "Add a phase in the Builder first" : undefined}
        >
          <Plus className="size-3.5" />
          New Run
        </Button>
        <Select value={activeRunId ?? ""} onValueChange={onSelectRun}>
          <SelectTrigger size="sm" className="min-w-0 flex-1">
            <SelectValue placeholder="Select a run" />
          </SelectTrigger>
          <SelectContent>
            {runs.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {runLabel(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {run && <RunStatusBadge status={run.status} />}
        {run && runActive && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => window.cowork.process.pause(run.id)}
              disabled={run.status === "paused"}
            >
              <Pause className="size-3.5" />
              Pause
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => window.cowork.process.cancel(run.id)}
            >
              Cancel
            </Button>
          </>
        )}
        {/* A failed run can retry from its failure frontier: the failed phase(s)
            and blocked dependents re-run; completed phases don't. */}
        {run && run.status === "failed" && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={exportRunIncident}
            >
              <Download className="size-3.5" />
              Export Incident
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => window.cowork.process.restart(run.id)}
            >
              <RotateCcw className="size-3.5" />
              Retry
            </Button>
          </>
        )}
      </div>

      <NewRunModal
        open={newRunOpen}
        onOpenChange={setNewRunOpen}
        onRun={startNewRun}
      />

      {/* Phase list. */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-6 py-4">
          {run?.objective && (
            <p className="mb-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {run.objective}
            </p>
          )}
          {/* A paused run with no live gate = a denied gate (v1: deny records the
              decision but doesn't resume). Explain the dead-end and the way out. */}
          {run?.status === "paused" && Object.keys(gates).length === 0 && (
            <p className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-500">
              A gate was denied — the run is paused and its downstream phases
              stay blocked. Cancel the run to end it.
            </p>
          )}
          {topLevel.length === 0 && (
            <p className="py-8 text-center text-xs text-muted-foreground">
              Waiting for phases to start…
            </p>
          )}
          {topLevel.map((pr) => (
            <PhaseRunItem
              key={pr.id}
              phaseRun={pr}
              name={phaseName(pr.phaseId)}
              gateInfo={gates[pr.id]}
              gateRequest={
                gates[pr.id] ? gateRequests[gates[pr.id].requestId] : undefined
              }
              gates={gates}
              gateRequests={gateRequests}
              flagGate={flagGates[pr.id]}
              childFlagGates={flagGates}
              childRuns={childrenOf.get(pr.id) ?? []}
              phaseName={phaseName}
              maxReworkRounds={phaseMaxRework(pr.phaseId)}
              isContainer={phaseIsContainer(pr.phaseId)}
              // A PURE sub-process phase shows its own nested run under the row. A
              // COMBINED fan-out + sub-process phase (plan 038.3) is a container: the
              // nested runs hang off its CHILDREN, not the container, so flag that
              // instead via childrenAreSubProcess.
              isSubProcess={
                phaseIsSubProcess(pr.phaseId) && !phaseIsContainer(pr.phaseId)
              }
              childrenAreSubProcess={
                phaseIsSubProcess(pr.phaseId) && phaseIsContainer(pr.phaseId)
              }
              refreshTick={refreshTick}
              workspacePath={workspacePath}
              onApprove={approve}
              onDeny={deny}
              onRequestChanges={requestChanges}
              onRetryReview={retryReview}
              onConfirmFlag={confirmFlag}
              onDismissFlag={dismissFlag}
              onOpenTranscript={openTranscript}
              onOpenTask={openTaskById}
              onOpenReview={openApprovalReview}
            />
          ))}
        </div>
      </ScrollArea>

      {/* Read-only transcript of a clicked phase/child's worker (its full agent
          conversation — messages, tools, result). Portals above the takeover. */}
      <TaskTranscriptSheet
        task={viewingTask}
        open={viewingTask !== null}
        onOpenChange={(o) => {
          if (!o) setViewingTask(null)
        }}
      />
      <ApprovalReviewDrawer
        target={reviewTarget}
        workspacePath={workspacePath}
        onOpenChange={(open) => {
          if (!open) setReviewTarget(null)
        }}
        onApprove={approve}
        onDeny={deny}
        onRequestChanges={requestChanges}
        onOpenTranscript={openTranscript}
      />
    </div>
  )
}

// The files a phase-run's worker produced, shown as clickable chips (plan 030b).
// Derives the list from the worker conversation's tool calls — the same source as
// the chat UI's changed-file pills, no new git machinery: phaseRun.taskId →
// task.conversationId → messages → buildTimeline → changedFilesFromCalls. Fetched
// lazily per (taskId, status) so a still-running phase's chips refresh on
// completion; renders nothing until files land (ChangedFilesBar returns null on
// an empty list). Clicking a chip opens the file in the selected IDE; hovering
// shows its git diff.
function PhaseFileChips({
  taskId,
  status,
  workspacePath,
  onReviewFiles,
}: {
  taskId: string
  status: PhaseRunStatus
  workspacePath: string
  onReviewFiles: (files: ChangedFile[]) => void
}) {
  const [files, setFiles] = useState<ChangedFile[]>([])

  useEffect(() => {
    if (!workspacePath) return
    let cancelled = false
    void (async () => {
      const task = await window.cowork.db.tasks.get(taskId)
      if (cancelled || !task) return
      const rows = await window.cowork.db.messages.list(task.conversationId)
      if (cancelled) return
      const calls = buildTimeline(rows).flatMap((item) =>
        item.kind === "tools" ? item.calls : []
      )
      setFiles(changedFilesFromCalls(calls))
    })()
    return () => {
      cancelled = true
    }
    // Re-fetch on status change (a running phase's files grow as it works).
  }, [taskId, status, workspacePath])

  if (files.length === 0 || !workspacePath) return null
  return (
    <ChangedFilesBar
      files={files}
      workspace={workspacePath}
      // The monitor has no in-app browser / Changes sidebar, so html opens in the
      // editor too and "Review all" just opens each file. Keep it simple.
      onOpenHtml={(relPath) => {
        void window.cowork.openInEditor(workspacePath, relPath)
      }}
      onReviewAll={onReviewFiles}
    />
  )
}

// One top-level phase run row: status icon + name + agent, its inline approval
// card when gated, and its nested children (fan-out / on_each_subtask instances).
function PhaseRunItem({
  phaseRun,
  name,
  gateInfo,
  gateRequest,
  gates,
  gateRequests,
  flagGate,
  childFlagGates,
  childRuns,
  phaseName,
  maxReworkRounds,
  isContainer,
  isSubProcess,
  childrenAreSubProcess,
  refreshTick,
  workspacePath,
  onApprove,
  onDeny,
  onRequestChanges,
  onRetryReview,
  onConfirmFlag,
  onDismissFlag,
  onOpenTranscript,
  onOpenTask,
  onOpenReview,
}: {
  phaseRun: ProcessPhaseRun
  name: string
  gateInfo: GateInfo | undefined
  gateRequest: ProcessGateRequest | undefined
  // The full phaseRunId → gate requestId map, threaded down so a nested sub-process
  // run's own phase gates render actionable cards (plan 038.2).
  gates: Record<string, GateInfo>
  gateRequests: Record<string, ProcessGateRequest>
  // A pending cross-phase rework flag this phase raised, awaiting confirmation
  // (plan 031.2). Undefined when there's none.
  flagGate: FlagGateInfo | undefined
  // The full flagGates map, so a nested child (an on_each_subtask INSTANCE that
  // raised a per-child flag) can look up its own pending flag card (plan 031.2).
  childFlagGates: Record<string, FlagGateInfo>
  childRuns: ProcessPhaseRun[]
  phaseName: (phaseId: string) => string
  // The per-phase rework cap (0 = unlimited) and whether the phase is a container
  // (fan-out / on_each_subtask), which can't be sent back in v1 (plan 029).
  maxReworkRounds: number
  isContainer: boolean
  // Whether this phase runs a sub-process (plan 038.1): its nested run is shown as
  // an expandable block under the row.
  isSubProcess: boolean
  // Whether this phase's CHILDREN each run a sub-process (a combined fan-out +
  // sub-process phase, plan 038.3): each child row gets its own nested-run block.
  childrenAreSubProcess: boolean
  // Bumped on every live task event so the nested sub-process view re-fetches as
  // its child phases progress (plan 038.1).
  refreshTick: number
  // The run's workspace path, for the per-phase file chips (plan 030b).
  workspacePath: string
  onApprove: (requestId: string, phaseRunId: string) => void
  onDeny: (requestId: string, phaseRunId: string) => void
  onRequestChanges: (
    requestId: string,
    phaseRunId: string,
    feedback: string
  ) => void
  onRetryReview: (requestId: string, phaseRunId: string) => void
  onConfirmFlag: (requestId: string, phaseRunId: string) => void
  onDismissFlag: (requestId: string, phaseRunId: string) => void
  // Open a phase/child's worker transcript (only rows with a taskId).
  onOpenTranscript: (phaseRun: ProcessPhaseRun) => void
  onOpenTask: (taskId: string) => void
  onOpenReview: (
    phaseRun: ProcessPhaseRun,
    name: string,
    requestId?: string,
    files?: ChangedFile[]
  ) => void
}) {
  // A gated phase's own row stays `completed` in the DB — the gate is a run-level
  // hold on its dependents (the requestId rides the event + a durable approval
  // row, not the phase status). So drive the card off the gate map, not the
  // phase-run status, and OVERRIDE the displayed status to read as awaiting.
  const gated = gateInfo !== undefined
  const displayStatus = gated ? "waiting_for_approval" : phaseRun.status
  const clickable = phaseRun.taskId !== null

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div
        onClick={clickable ? () => onOpenTranscript(phaseRun) : undefined}
        className={cn(
          "-m-1 flex items-center gap-2 rounded-md p-1",
          clickable && "cursor-pointer hover:bg-muted/60"
        )}
        title={clickable ? "View this phase's transcript" : undefined}
      >
        <StatusIcon status={displayStatus} />
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        {phaseRun.agentName && (
          <AgentIdentityBadge value={phaseRun.agentName} />
        )}
        <PhaseStatusLabel status={displayStatus} />
      </div>

      {phaseRun.failure && (
        <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
          <span className="rounded border px-1.5 py-0.5">
            {phaseRun.failure.stage}
          </span>
          <span className="rounded border px-1.5 py-0.5">
            {phaseRun.failure.code}
          </span>
          {phaseRun.failure.attempt !== null && (
            <span className="rounded border px-1.5 py-0.5">
              attempt {phaseRun.failure.attempt}
              {phaseRun.failure.maxAttempts !== null
                ? `/${phaseRun.failure.maxAttempts}`
                : ""}
            </span>
          )}
        </div>
      )}

      {(phaseRun.failure?.message ?? phaseRun.error) && (
        <pre className="overflow-x-auto rounded-md bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
          {phaseRun.failure?.message ?? phaseRun.error}
        </pre>
      )}

      <PhaseAttemptHistory
        phaseRunId={phaseRun.id}
        refreshKey={refreshTick}
        onOpenTask={onOpenTask}
      />

      {/* Files this phase's worker produced (plan 030b). */}
      {phaseRun.taskId && (
        <PhaseFileChips
          taskId={phaseRun.taskId}
          status={phaseRun.status}
          workspacePath={workspacePath}
          onReviewFiles={(files) =>
            onOpenReview(phaseRun, name, gateInfo?.requestId, files)
          }
        />
      )}

      {/* Inline approval card for an approve-gated phase (reuses the activity
          panel affordance, wired to process.approve/deny). */}
      {gated && (
        <GateCard
          name={name}
          requestId={gateInfo.requestId}
          phaseRunId={phaseRun.id}
          gateKind={gateInfo.gateKind}
          reworkRound={phaseRun.reworkRound}
          maxReworkRounds={maxReworkRounds}
          isContainer={isContainer}
          onApprove={onApprove}
          onDeny={onDeny}
          onRequestChanges={onRequestChanges}
          onRetryReview={onRetryReview}
          packet={gateRequest?.approvalPacket}
          onViewDetails={() => onOpenReview(phaseRun, name, gateInfo.requestId)}
        />
      )}

      {/* Inline confirmation card for a cross-phase rework flag this phase raised
          (plan 031.2). Wired to process.confirmFlag/dismissFlag. */}
      {flagGate && (
        <FlagCard
          flagGate={flagGate}
          flaggerName={name}
          onConfirm={() => onConfirmFlag(flagGate.requestId, phaseRun.id)}
          onDismiss={() => onDismissFlag(flagGate.requestId, phaseRun.id)}
        />
      )}

      {/* Nested children (fan-out sub-tasks / on_each_subtask instances). */}
      {childRuns.length > 0 && (
        <div className="flex flex-col gap-1 border-l-2 pl-3">
          {childRuns.map((c, i) => {
            const clickable = c.taskId !== null
            const childName = agentRunTitle(
              c.title,
              `${phaseName(c.phaseId)} #${i + 1}`,
              c.agentName
            )
            return (
              <div key={c.id} className="flex flex-col gap-0.5">
                <div
                  onClick={clickable ? () => onOpenTranscript(c) : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-1 py-0.5 text-xs",
                    clickable && "cursor-pointer hover:bg-muted/60"
                  )}
                  title={
                    clickable ? "View this sub-task's transcript" : undefined
                  }
                >
                  <StatusIcon status={c.status} />
                  <span className="min-w-0 flex-1 truncate">{childName}</span>
                  {c.agentName && <AgentIdentityBadge value={c.agentName} />}
                  <PhaseStatusLabel status={c.status} />
                </div>
                {/* This sub-task's produced files (plan 030b). */}
                {c.taskId && (
                  <div className="pl-1">
                    <PhaseFileChips
                      taskId={c.taskId}
                      status={c.status}
                      workspacePath={workspacePath}
                      onReviewFiles={(files) =>
                        onOpenReview(c, childName, undefined, files)
                      }
                    />
                  </div>
                )}
                <div className="pl-1">
                  <PhaseAttemptHistory
                    phaseRunId={c.id}
                    refreshKey={refreshTick}
                    onOpenTask={onOpenTask}
                  />
                </div>
                {/* A per-child rework flag this INSTANCE raised (plan 031.2):
                    an on_each_subtask consumer instance that flagged its source
                    sub-task. Rendered here since the instance is a nested child,
                    not a top-level row. */}
                {childFlagGates[c.id] && (
                  <div className="pl-1">
                    <FlagCard
                      flagGate={childFlagGates[c.id]}
                      flaggerName={childName}
                      onConfirm={() =>
                        onConfirmFlag(childFlagGates[c.id].requestId, c.id)
                      }
                      onDismiss={() =>
                        onDismissFlag(childFlagGates[c.id].requestId, c.id)
                      }
                    />
                  </div>
                )}
                {/* The nested run this fan-out child dispatched as a sub-process
                    (a combined fan-out + sub-process phase, plan 038.3). */}
                {childrenAreSubProcess && (
                  <div className="pl-1">
                    <SubProcessNestedRun
                      parentPhaseRunId={c.id}
                      workspacePath={workspacePath}
                      onOpenTranscript={onOpenTranscript}
                      onOpenTask={onOpenTask}
                      refreshTick={refreshTick}
                      depth={0}
                      gates={gates}
                      gateRequests={gateRequests}
                      flagGates={childFlagGates}
                      onApprove={onApprove}
                      onDeny={onDeny}
                      onRequestChanges={onRequestChanges}
                      onRetryReview={onRetryReview}
                      onConfirmFlag={onConfirmFlag}
                      onDismissFlag={onDismissFlag}
                      onOpenReview={onOpenReview}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* The nested run of a sub-process phase (plan 038.1): expandable, lazily
          fetched, and recursively rendered against the CHILD definition's graph.
          Gates/flags raised INSIDE the nested run surface on the shared task's
          approvals (keyed by phase-run id in the gates/flagGates maps), so we thread
          those maps + the control callbacks down for actionable cards (plan 038.2). */}
      {isSubProcess && (
        <SubProcessNestedRun
          parentPhaseRunId={phaseRun.id}
          workspacePath={workspacePath}
          onOpenTranscript={onOpenTranscript}
          onOpenTask={onOpenTask}
          refreshTick={refreshTick}
          depth={0}
          gates={gates}
          gateRequests={gateRequests}
          flagGates={childFlagGates}
          onApprove={onApprove}
          onDeny={onDeny}
          onRequestChanges={onRequestChanges}
          onRetryReview={onRetryReview}
          onConfirmFlag={onConfirmFlag}
          onDismissFlag={onDismissFlag}
          onOpenReview={onOpenReview}
        />
      )}
    </div>
  )
}

function formatAttemptTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function attemptLabel(attempt: ProcessPhaseAttempt): string {
  if (attempt.attempt === null) return "attempt unknown"
  return `attempt ${attempt.attempt}${
    attempt.maxAttempts !== null ? `/${attempt.maxAttempts}` : ""
  }`
}

// Compact durable failure-audit disclosure. The current phase row may have
// succeeded after a retry, so this reads process_phase_attempts instead of the
// latest phaseRun.failure field.
export function PhaseAttemptHistory({
  phaseRunId,
  refreshKey,
  onOpenTask,
}: {
  phaseRunId: string
  refreshKey?: unknown
  onOpenTask: (taskId: string) => void
}) {
  const [attempts, setAttempts] = useState<ProcessPhaseAttempt[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.cowork.db.processes.phaseAttempts
      .list({ phaseRunId })
      .then((rows) => {
        if (!cancelled) setAttempts(rows)
      })
      .catch(() => {
        if (!cancelled) setAttempts([])
      })
    return () => {
      cancelled = true
    }
  }, [phaseRunId, refreshKey])

  if (attempts.length === 0) return null

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-fit items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
          />
          Attempt history
          <Badge variant="secondary" className="h-4 px-1 text-[10px]">
            {attempts.length}
          </Badge>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-1.5 rounded-md border bg-muted/30 p-2">
          {attempts.map((attempt) => {
            const taskId = attempt.workerTaskId ?? attempt.taskId
            return (
              <div
                key={attempt.id}
                className="flex flex-col gap-1 rounded border bg-background/70 px-2 py-1.5 text-xs"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="h-5">
                    {attemptLabel(attempt)}
                  </Badge>
                  <Badge variant="outline" className="h-5">
                    {attempt.stage}
                  </Badge>
                  <Badge variant="outline" className="h-5">
                    {attempt.failure.code}
                  </Badge>
                  <Badge
                    variant={
                      attempt.failure.retryable ? "secondary" : "outline"
                    }
                    className="h-5"
                  >
                    {attempt.failure.retryable ? "retryable" : "not retryable"}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    {formatAttemptTime(attempt.createdAt)}
                  </span>
                  {taskId && (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="ml-auto h-6"
                      onClick={() => onOpenTask(taskId)}
                      title={taskId}
                    >
                      <FileText className="size-3" />
                      Transcript
                    </Button>
                  )}
                </div>
                <p className="line-clamp-2 text-muted-foreground">
                  {attempt.failure.message || attempt.error}
                </p>
              </div>
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// The inline approve-gate card (plan 029): Approve / Deny / Request changes with a
// collapsible feedback box. Extracted from PhaseRunItem so a nested sub-process
// run's own gated phases can render the same actionable card (plan 038.2). Request
// changes is hidden for a container phase (backend rejects it) or at the per-phase
// rework cap (0 = unlimited).
function compactApprovalSummary(packet: ProcessApprovalPacket): string {
  const changes =
    packet.artifacts.length > 0
      ? `Changed ${packet.artifacts.length} file${packet.artifacts.length === 1 ? "" : "s"}.`
      : packet.summary.materialChanges[0] || "No changed files were recorded."
  const caveat = packet.summary.caveats[0]
  return [
    packet.summary.outcome,
    changes,
    packet.summary.validationSummary,
    caveat,
  ]
    .filter(Boolean)
    .join(" ")
}

function approvalEvidenceCounts(packet: ProcessApprovalPacket): string {
  const parts: string[] = []
  if (packet.artifacts.length > 0)
    parts.push(
      `${packet.artifacts.length} file${packet.artifacts.length === 1 ? "" : "s"}`
    )
  if (packet.validations.length > 0) {
    const failed = packet.validations.filter(
      (v) => v.status === "failed"
    ).length
    parts.push(
      failed > 0
        ? `${failed} validation failed`
        : `${packet.validations.length} validation passed`
    )
  }
  if (packet.evidenceWarnings.length > 0)
    parts.push(`${packet.evidenceWarnings.length} warning`)
  if (parts.length === 0) parts.push("transcript available")
  return parts.join(" · ")
}

function validatorGateCopy(name: string, packet?: ProcessApprovalPacket) {
  const outcome = packet?.summary.outcome ?? ""
  const unavailable = outcome.includes("could not be validated")
  const exhausted = outcome.includes("exhausted validator review")
  if (unavailable) {
    return {
      title: `“${name}” is held because the validator review is unavailable.`,
      fallback:
        "The phase worker completed, but the validator did not produce a usable approval. Retry the review, request changes, deny, or manually override the unavailable review.",
    }
  }
  if (exhausted) {
    return {
      title: `“${name}” exhausted validator review rounds.`,
      fallback:
        "The phase worker completed, but the validator did not approve it within the configured review budget. Request changes, deny, or manually override the exhausted review.",
    }
  }
  return {
    title: `“${name}” is held for validator review.`,
    fallback:
      "The phase worker completed, but the validator did not provide an approval. Retry the review, request changes, deny, or manually override the validator hold.",
  }
}

function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    css: "css",
    scss: "scss",
    html: "html",
    md: "markdown",
    mdx: "mdx",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    sh: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sql: "sql",
  }
  return map[ext] ?? ""
}

function renderFileTextMarkdown(path: string, content: string): string {
  if (/\.(md|mdx)$/i.test(path)) return content
  const lang = languageForPath(path)
  return `\`\`\`${lang}\n${content.replace(/```/g, "``\\`")}\n\`\`\``
}

export function GateCard({
  name,
  requestId,
  phaseRunId,
  gateKind,
  reworkRound,
  maxReworkRounds,
  isContainer,
  onApprove,
  onDeny,
  onRequestChanges,
  onRetryReview,
  packet,
  onViewDetails,
}: {
  name: string
  requestId: string
  phaseRunId: string
  gateKind: "phase" | "validator"
  reworkRound: number
  maxReworkRounds: number
  isContainer: boolean
  onApprove: (requestId: string, phaseRunId: string) => void
  onDeny: (requestId: string, phaseRunId: string) => void
  onRequestChanges: (
    requestId: string,
    phaseRunId: string,
    feedback: string
  ) => void
  onRetryReview: (requestId: string, phaseRunId: string) => void
  packet?: ProcessApprovalPacket
  onViewDetails: () => void
}) {
  const [reworkOpen, setReworkOpen] = useState(false)
  const [reworkText, setReworkText] = useState("")
  const atReworkCap = maxReworkRounds > 0 && reworkRound >= maxReworkRounds
  const canRequestChanges = !isContainer && !atReworkCap
  const canRetryReview = gateKind === "validator"
  const validatorCopy =
    gateKind === "validator" ? validatorGateCopy(name, packet) : null
  const title =
    gateKind === "validator"
      ? validatorCopy!.title
      : `“${name}” is done — approve to release its downstream phases.`
  const summary = packet
    ? compactApprovalSummary(packet)
    : gateKind === "validator"
      ? validatorCopy!.fallback
      : "Review the worker transcript before approving this phase."
  const approveLabel = gateKind === "validator" ? "Manual override" : "Approve"
  const evidenceCounts = packet
    ? approvalEvidenceCounts(packet)
    : `${reworkRound > 0 ? `round ${reworkRound} · ` : ""}transcript available`
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
      <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-500">
        <ShieldAlert className="size-3.5 shrink-0" />
        <span>{title}</span>
      </div>
      <p className="leading-relaxed text-foreground/85">{summary}</p>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{evidenceCounts}</span>
        <Button
          size="xs"
          variant="secondary"
          className="shrink-0"
          onClick={onViewDetails}
        >
          <FileText className="size-3" />
          View details
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canRetryReview && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onRetryReview(requestId, phaseRunId)}
          >
            <RotateCcw className="size-3" />
            Retry review
          </Button>
        )}
        <Button size="xs" onClick={() => onApprove(requestId, phaseRunId)}>
          {approveLabel} <Kbd className="ml-1.5">⏎</Kbd>
        </Button>
        <Button
          size="xs"
          variant="destructive"
          onClick={() => onDeny(requestId, phaseRunId)}
        >
          Deny <Kbd className="ml-1.5">Esc</Kbd>
        </Button>
        {canRequestChanges && !reworkOpen && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => setReworkOpen(true)}
          >
            Request changes
          </Button>
        )}
      </div>
      {gateKind === "validator" && (
        <p className="text-[11px] text-muted-foreground">
          Manual override records a human decision and releases downstream
          phases without a validator approval.
        </p>
      )}
      {atReworkCap && !isContainer && (
        <p className="text-[11px] text-muted-foreground">
          Rework limit reached ({maxReworkRounds}). Approve or deny to continue.
        </p>
      )}
      {canRequestChanges && reworkOpen && (
        <div className="flex flex-col gap-2">
          <Textarea
            autoFocus
            rows={3}
            value={reworkText}
            onChange={(e) => setReworkText(e.target.value)}
            placeholder="What should change before this phase is approved?"
            className="text-xs"
          />
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              disabled={reworkText.trim().length === 0}
              onClick={() => {
                onRequestChanges(requestId, phaseRunId, reworkText.trim())
                setReworkText("")
                setReworkOpen(false)
              }}
            >
              Send back
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setReworkText("")
                setReworkOpen(false)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ApprovalReviewDrawer({
  target,
  workspacePath,
  onOpenChange,
  onApprove,
  onDeny,
  onRequestChanges,
  onOpenTranscript,
}: {
  target: ApprovalReviewTarget | null
  workspacePath: string
  onOpenChange: (open: boolean) => void
  onApprove: (requestId: string, phaseRunId: string) => void
  onDeny: (requestId: string, phaseRunId: string) => void
  onRequestChanges: (
    requestId: string,
    phaseRunId: string,
    feedback: string
  ) => void
  onOpenTranscript: (phaseRun: ProcessPhaseRun) => void
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitDiffResult | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [fileText, setFileText] = useState<FileTextResult | null>(null)
  const [fileTextLoading, setFileTextLoading] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState("")

  const artifacts = useMemo<ApprovalArtifact[]>(() => {
    if (target?.packet?.artifacts.length) return target.packet.artifacts
    return (target?.files ?? []).map((file) => ({
      path: file.path,
      name: file.baseName,
      kind: file.kind,
      fileType: file.fileType === "html" ? "html" : "code",
      provenance: "workspace",
    }))
  }, [target?.files, target?.packet])

  const selected =
    artifacts.find((a) => a.path === selectedPath) ?? artifacts[0]

  useEffect(() => {
    setSelectedPath(artifacts[0]?.path ?? null)
    setDiff(null)
    setFileText(null)
    setFeedbackOpen(false)
    setFeedback("")
  }, [target?.phaseRun.id, target?.requestId, artifacts])

  useEffect(() => {
    if (!selected || selected.fileType === "html" || !workspacePath) {
      setDiff(null)
      setDiffLoading(false)
    } else {
      let cancelled = false
      setDiffLoading(true)
      window.cowork.git
        .diff(workspacePath, selected.path)
        .then((res) => {
          if (!cancelled) setDiff(res)
        })
        .catch(() => {
          if (!cancelled) setDiff(null)
        })
        .finally(() => {
          if (!cancelled) setDiffLoading(false)
        })
      return () => {
        cancelled = true
      }
    }
  }, [selected, workspacePath])

  useEffect(() => {
    if (!selected || selected.fileType === "html" || !workspacePath) {
      setFileText(null)
      setFileTextLoading(false)
      return
    }
    const readText = window.cowork.files.readText
    if (typeof readText !== "function") {
      setFileText({
        content: null,
        truncated: false,
        error: "File preview is unavailable until the app is restarted.",
      })
      setFileTextLoading(false)
      return
    }
    let cancelled = false
    setFileTextLoading(true)
    readText(workspacePath, selected.path)
      .then((res) => {
        if (!cancelled) setFileText(res)
      })
      .catch((err) => {
        if (!cancelled)
          setFileText({
            content: null,
            truncated: false,
            error: err instanceof Error ? err.message : String(err),
          })
      })
      .finally(() => {
        if (!cancelled) setFileTextLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected, workspacePath])

  const packet = target?.packet
  const requestId = target?.requestId
  const phaseRunId = target?.phaseRun.id
  const hasDiff = !!diff?.diff.trim()
  const isValidatorGate = target?.gateKind === "validator"

  return (
    <Sheet open={target !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex !w-[min(96vw,82rem)] !max-w-[min(96vw,82rem)] flex-col gap-0 p-0"
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="truncate">
            {target
              ? isValidatorGate
                ? `Validator override review: ${target.name}`
                : `Approval review: ${target.name}`
              : "Approval review"}
          </SheetTitle>
          <SheetDescription>
            {packet
              ? `Round ${packet.reworkRound} · ${new Date(packet.createdAt).toLocaleString()}`
              : "Review evidence before deciding."}
          </SheetDescription>
        </SheetHeader>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
          <ScrollArea className="border-r">
            <div className="flex flex-col gap-4 p-4 text-sm">
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase">
                  Overview
                </h3>
                <p className="text-sm leading-relaxed">
                  {packet
                    ? compactApprovalSummary(packet)
                    : isValidatorGate
                      ? "No approval packet was attached to this validator gate. Use the transcript and current workspace files as fallback evidence before retrying or manually overriding."
                      : "No approval packet was attached to this request. Use the transcript and current workspace files as fallback evidence."}
                </p>
                {isValidatorGate && (
                  <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
                    Approving this gate is recorded as a manual override of an
                    unavailable validator review.
                  </p>
                )}
                {packet?.downstream.length ? (
                  <p className="text-xs text-muted-foreground">
                    {isValidatorGate
                      ? "Manual override releases "
                      : "Approval releases "}
                    {packet.downstream.map((d) => d.name).join(", ")}.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No downstream phase metadata was recorded.
                  </p>
                )}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase">
                  Artifacts
                </h3>
                {artifacts.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No file artifacts were recorded.
                  </p>
                ) : (
                  artifacts.map((artifact) => (
                    <button
                      type="button"
                      key={artifact.path}
                      onClick={() => setSelectedPath(artifact.path)}
                      className={cn(
                        "flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs hover:bg-accent",
                        selected?.path === artifact.path && "bg-accent"
                      )}
                    >
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {artifact.path}
                      </span>
                      <Badge variant="secondary" className="text-[10px]">
                        {artifact.provenance === "workspace"
                          ? "workspace"
                          : "phase"}
                      </Badge>
                    </button>
                  ))
                )}
              </section>

              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase">
                  Validation
                </h3>
                {packet?.validations.length ? (
                  packet.validations.map((validation, i) => (
                    <div
                      key={`${validation.label}:${i}`}
                      className="rounded-md border px-2 py-1.5 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <StatusDot status={validation.status} />
                        <span className="min-w-0 flex-1 truncate">
                          {validation.label}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No structured validation was recorded.
                  </p>
                )}
              </section>

              {packet?.evidenceWarnings.length ? (
                <section className="flex flex-col gap-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-400">
                  {packet.evidenceWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </section>
              ) : null}
            </div>
          </ScrollArea>

          <div className="flex min-w-0 flex-col">
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-4">
                {selected ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {selected.path}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!workspacePath}
                        onClick={() => {
                          if (workspacePath)
                            void window.cowork.openInEditor(
                              workspacePath,
                              selected.path
                            )
                        }}
                      >
                        <FolderOpen className="size-3.5" />
                        Open in editor
                      </Button>
                    </div>
                    {selected.fileType === "html" && workspacePath ? (
                      <iframe
                        src={`file://${workspacePath}/${selected.path}`}
                        title={selected.name}
                        sandbox=""
                        className="h-[32rem] w-full rounded-md border bg-white"
                      />
                    ) : diffLoading ? (
                      <p className="text-sm text-muted-foreground">
                        Loading diff…
                      </p>
                    ) : hasDiff ? (
                      <DiffView
                        result={diff}
                        className="max-h-[32rem] rounded-md border"
                      />
                    ) : fileTextLoading ? (
                      <p className="text-sm text-muted-foreground">
                        Loading file…
                      </p>
                    ) : fileText?.content !== null &&
                      fileText?.content !== undefined ? (
                      <div className="max-h-[32rem] overflow-auto rounded-md border p-3">
                        <Markdown
                          content={renderFileTextMarkdown(
                            selected.path,
                            fileText.content
                          )}
                        />
                        {fileText.truncated && (
                          <p className="mt-2 text-xs text-muted-foreground">
                            File preview truncated.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                        {fileText?.error ??
                          "No diff or text preview available."}
                      </p>
                    )}
                  </div>
                ) : packet?.validations.length ? (
                  <div className="flex flex-col gap-3">
                    {packet.validations.map((validation, i) => (
                      <div
                        key={`${validation.label}:output:${i}`}
                        className="rounded-md border"
                      >
                        <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
                          <StatusDot status={validation.status} />
                          <span className="font-medium">
                            {validation.label}
                          </span>
                        </div>
                        <pre className="max-h-80 overflow-auto p-3 text-xs">
                          {validation.output || "No output recorded."}
                        </pre>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 text-sm text-muted-foreground">
                    <p>No artifact or validation evidence is available.</p>
                    {target?.phaseRun.taskId && (
                      <Button
                        variant="outline"
                        className="w-fit"
                        onClick={() => onOpenTranscript(target.phaseRun)}
                      >
                        Open transcript
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </ScrollArea>

            <div className="border-t p-3">
              {feedbackOpen && (
                <div className="mb-3 flex flex-col gap-2">
                  <Textarea
                    rows={3}
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="What should change before this phase is approved?"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={!requestId || !phaseRunId || !feedback.trim()}
                      onClick={() => {
                        if (!requestId || !phaseRunId) return
                        onRequestChanges(requestId, phaseRunId, feedback.trim())
                      }}
                    >
                      Send back
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setFeedback("")
                        setFeedbackOpen(false)
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!requestId || !target?.canRequestChanges}
                  onClick={() => setFeedbackOpen(true)}
                >
                  Request changes
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!requestId || !phaseRunId}
                  onClick={() => {
                    if (requestId && phaseRunId) onDeny(requestId, phaseRunId)
                  }}
                >
                  Deny
                </Button>
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={!requestId || !phaseRunId}
                  onClick={() => {
                    if (requestId && phaseRunId)
                      onApprove(requestId, phaseRunId)
                  }}
                >
                  {isValidatorGate ? "Manual override" : "Approve"}
                </Button>
                {target?.phaseRun.taskId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpenTranscript(target.phaseRun)}
                  >
                    Transcript
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function StatusDot({ status }: { status: ApprovalValidation["status"] }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full",
        status === "passed" && "bg-emerald-500",
        status === "failed" && "bg-destructive",
        status === "unknown" && "bg-muted-foreground"
      )}
    />
  )
}

// The nested run beneath a sub-process phase-run (plan 038.1). Collapsed by
// default; on expand it lazily fetches the child run (by parent_phase_run_id), its
// definition graph, and its phase-runs, then renders them as a compact tree —
// top-level phases with their fan-out/on_each_subtask children indented, names
// resolved against the CHILD graph. Recurses for a sub-process phase INSIDE the
// child (bounded by MAX_PROCESS_DEPTH). A gate/flag raised INSIDE the nested run
// surfaces on the shared task's approvals (keyed by phase-run id in the gates/
// flagGates maps threaded from the monitor), so its phases render actionable
// approve/deny/request-changes + flag-confirm cards (plan 038.2).
const MAX_NESTED_DEPTH = 5
function SubProcessNestedRun({
  parentPhaseRunId,
  workspacePath,
  onOpenTranscript,
  onOpenTask,
  refreshTick,
  depth,
  gates,
  gateRequests,
  flagGates,
  onApprove,
  onDeny,
  onRequestChanges,
  onRetryReview,
  onConfirmFlag,
  onDismissFlag,
  onOpenReview,
}: {
  parentPhaseRunId: string
  workspacePath: string
  onOpenTranscript: (phaseRun: ProcessPhaseRun) => void
  onOpenTask: (taskId: string) => void
  // Bumped by the monitor on every live task event; re-fetches the child run's
  // rows while expanded so a running nested run's phases update live (plan 038.1).
  refreshTick: number
  depth: number
  // The shared task's gate/flag maps (keyed by phase-run id) + control callbacks,
  // threaded down so a nested run's own gates/flags are actionable (plan 038.2).
  gates: Record<string, GateInfo>
  gateRequests: Record<string, ProcessGateRequest>
  flagGates: Record<string, FlagGateInfo>
  onApprove: (requestId: string, phaseRunId: string) => void
  onDeny: (requestId: string, phaseRunId: string) => void
  onRequestChanges: (
    requestId: string,
    phaseRunId: string,
    feedback: string
  ) => void
  onRetryReview: (requestId: string, phaseRunId: string) => void
  onConfirmFlag: (requestId: string, phaseRunId: string) => void
  onDismissFlag: (requestId: string, phaseRunId: string) => void
  onOpenReview: (
    phaseRun: ProcessPhaseRun,
    name: string,
    requestId?: string,
    files?: ChangedFile[]
  ) => void
}) {
  const [open, setOpen] = useState(false)
  const [graph, setGraph] = useState<ProcessGraph | null>(null)
  const [phaseRuns, setPhaseRuns] = useState<ProcessPhaseRun[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const runs = await window.cowork.db.processes.runs.list({
      parentPhaseRunId,
    })
    const childRun = runs[0]
    if (!childRun) {
      setLoaded(true)
      return
    }
    const [g, prs] = await Promise.all([
      childRun.processId
        ? window.cowork.db.processes.get(childRun.processId)
        : Promise.resolve(null),
      window.cowork.db.processes.phaseRuns.list({ runId: childRun.id }),
    ])
    setGraph(g)
    setPhaseRuns(phaseRunsForDisplay(childRun, prs))
    setLoaded(true)
  }, [parentPhaseRunId])

  // Re-fetch whenever it's open, AND whenever the monitor's live tail ticks (a
  // nested run rides the same task tail, so its rows change as parent events fire).
  useEffect(() => {
    if (open) void load()
  }, [open, load, refreshTick])

  const phaseName = useCallback(
    (phaseId: string) =>
      graph?.phases.find((p) => p.id === phaseId)?.name ?? phaseId,
    [graph]
  )
  const isSubProcess = useCallback(
    (phaseId: string) =>
      !!graph?.phases.find((p) => p.id === phaseId)?.subprocessId,
    [graph]
  )
  // Container / rework-cap predicates against the CHILD graph, so a nested gate's
  // Request-changes control gates correctly (mirrors the top-level monitor helpers).
  const isContainer = useCallback(
    (phaseId: string) => {
      if (!graph) return false
      const phase = graph.phases.find((p) => p.id === phaseId)
      if (!phase) return false
      if (phase.fanOut) return true
      return graph.edges.some(
        (e) =>
          e.toPhaseId === phaseId &&
          e.trigger === "on_each_subtask" &&
          graph.phases.find((p) => p.id === e.fromPhaseId)?.fanOut === true
      )
    },
    [graph]
  )
  const maxRework = useCallback(
    (phaseId: string) =>
      graph?.phases.find((p) => p.id === phaseId)?.maxReworkRounds ?? 0,
    [graph]
  )

  const { topLevel, childrenOf } = useMemo(() => {
    const top: ProcessPhaseRun[] = []
    const kids = new Map<string, ProcessPhaseRun[]>()
    for (const pr of phaseRuns) {
      if (pr.parentId) {
        const list = kids.get(pr.parentId) ?? []
        list.push(pr)
        kids.set(pr.parentId, list)
      } else {
        top.push(pr)
      }
    }
    return { topLevel: top, childrenOf: kids }
  }, [phaseRuns])

  return (
    <div className="border-l-2 border-dashed pl-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        Sub-process run
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1">
          {loaded && topLevel.length === 0 && (
            <p className="py-2 text-xs text-muted-foreground">
              No nested phases yet.
            </p>
          )}
          {topLevel.map((pr) => {
            // A gate on this nested phase surfaces via the shared task's approvals
            // (plan 038.2). An approve-gated phase stays `completed` in the DB, so
            // override the displayed status to read as awaiting (as PhaseRunItem does).
            const gateInfo = gates[pr.id]
            const displayStatus = gateInfo ? "waiting_for_approval" : pr.status
            const runName = agentRunTitle(
              pr.title,
              phaseName(pr.phaseId),
              pr.agentName
            )
            return (
              <div key={pr.id} className="flex flex-col gap-0.5">
                <div
                  onClick={pr.taskId ? () => onOpenTranscript(pr) : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-1 py-0.5 text-xs",
                    pr.taskId && "cursor-pointer hover:bg-muted/60"
                  )}
                  title={pr.taskId ? "View this phase's transcript" : undefined}
                >
                  <StatusIcon status={displayStatus} />
                  <span className="min-w-0 flex-1 truncate">{runName}</span>
                  {pr.agentName && <AgentIdentityBadge value={pr.agentName} />}
                  <PhaseStatusLabel status={displayStatus} />
                </div>
                {/* An approve gate raised inside this nested run (plan 038.2). */}
                {gateInfo && (
                  <GateCard
                    name={runName}
                    requestId={gateInfo.requestId}
                    phaseRunId={pr.id}
                    gateKind={gateInfo.gateKind}
                    reworkRound={pr.reworkRound}
                    maxReworkRounds={maxRework(pr.phaseId)}
                    isContainer={isContainer(pr.phaseId)}
                    onApprove={onApprove}
                    onDeny={onDeny}
                    onRequestChanges={onRequestChanges}
                    onRetryReview={onRetryReview}
                    packet={gateRequests[gateInfo.requestId]?.approvalPacket}
                    onViewDetails={() =>
                      onOpenReview(pr, runName, gateInfo.requestId)
                    }
                  />
                )}
                <PhaseAttemptHistory
                  phaseRunId={pr.id}
                  refreshKey={refreshTick}
                  onOpenTask={onOpenTask}
                />
                {/* A cross-phase rework flag this nested phase raised (plan 038.2). */}
                {flagGates[pr.id] && (
                  <FlagCard
                    flagGate={flagGates[pr.id]}
                    flaggerName={runName}
                    onConfirm={() =>
                      onConfirmFlag(flagGates[pr.id].requestId, pr.id)
                    }
                    onDismiss={() =>
                      onDismissFlag(flagGates[pr.id].requestId, pr.id)
                    }
                  />
                )}
                {(childrenOf.get(pr.id) ?? []).map((c, i) => (
                  <div key={c.id} className="flex flex-col gap-0.5">
                    <div
                      onClick={c.taskId ? () => onOpenTranscript(c) : undefined}
                      className={cn(
                        "ml-3 flex items-center gap-2 rounded-md border-l-2 px-1 py-0.5 pl-2 text-xs",
                        c.taskId && "cursor-pointer hover:bg-muted/60"
                      )}
                    >
                      <StatusIcon status={c.status} />
                      <span className="min-w-0 flex-1 truncate">
                        {agentRunTitle(
                          c.title,
                          `${phaseName(c.phaseId)} #${i + 1}`,
                          c.agentName
                        )}
                      </span>
                      {c.agentName && (
                        <AgentIdentityBadge value={c.agentName} />
                      )}
                      <PhaseStatusLabel status={c.status} />
                    </div>
                    {/* A per-child rework flag a nested on_each_subtask instance
                        raised (plan 038.2). */}
                    {flagGates[c.id] && (
                      <div className="ml-3">
                        <FlagCard
                          flagGate={flagGates[c.id]}
                          flaggerName={agentRunTitle(
                            c.title,
                            phaseName(c.phaseId),
                            c.agentName
                          )}
                          onConfirm={() =>
                            onConfirmFlag(flagGates[c.id].requestId, c.id)
                          }
                          onDismiss={() =>
                            onDismissFlag(flagGates[c.id].requestId, c.id)
                          }
                        />
                      </div>
                    )}
                    <div className="ml-3">
                      <PhaseAttemptHistory
                        phaseRunId={c.id}
                        refreshKey={refreshTick}
                        onOpenTask={onOpenTask}
                      />
                    </div>
                    {/* A combined fan-out + sub-process phase inside the nested run
                        (plan 038.3): each child dispatched its own sub-process. */}
                    {isSubProcess(pr.phaseId) &&
                      isContainer(pr.phaseId) &&
                      depth + 1 < MAX_NESTED_DEPTH && (
                        <div className="ml-3">
                          <SubProcessNestedRun
                            parentPhaseRunId={c.id}
                            workspacePath={workspacePath}
                            onOpenTranscript={onOpenTranscript}
                            onOpenTask={onOpenTask}
                            refreshTick={refreshTick}
                            depth={depth + 1}
                            gates={gates}
                            gateRequests={gateRequests}
                            flagGates={flagGates}
                            onApprove={onApprove}
                            onDeny={onDeny}
                            onRequestChanges={onRequestChanges}
                            onRetryReview={onRetryReview}
                            onConfirmFlag={onConfirmFlag}
                            onDismissFlag={onDismissFlag}
                            onOpenReview={onOpenReview}
                          />
                        </div>
                      )}
                  </div>
                ))}
                {/* A PURE sub-process phase INSIDE the nested run recurses (bounded).
                    A combined fan-out + sub-process phase renders per-child above. */}
                {isSubProcess(pr.phaseId) &&
                  !isContainer(pr.phaseId) &&
                  depth + 1 < MAX_NESTED_DEPTH && (
                    <SubProcessNestedRun
                      parentPhaseRunId={pr.id}
                      workspacePath={workspacePath}
                      onOpenTranscript={onOpenTranscript}
                      onOpenTask={onOpenTask}
                      refreshTick={refreshTick}
                      depth={depth + 1}
                      gates={gates}
                      gateRequests={gateRequests}
                      flagGates={flagGates}
                      onApprove={onApprove}
                      onDeny={onDeny}
                      onRequestChanges={onRequestChanges}
                      onRetryReview={onRetryReview}
                      onConfirmFlag={onConfirmFlag}
                      onDismissFlag={onDismissFlag}
                      onOpenReview={onOpenReview}
                    />
                  )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// A cross-phase rework flag confirmation card (plan 031.2). Rendered on the
// FLAGGING phase-run — a top-level row OR a nested on_each_subtask instance.
function FlagCard({
  flagGate,
  flaggerName,
  onConfirm,
  onDismiss,
}: {
  flagGate: FlagGateInfo
  flaggerName: string
  onConfirm: () => void
  onDismiss: () => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
      <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-500">
        <ShieldAlert className="size-3.5 shrink-0" />
        <span>
          “{flaggerName}” flagged{" "}
          {flagGate.targetKey ? (
            <>
              <code className="font-mono">{flagGate.targetKey}</code> for
            </>
          ) : (
            "an earlier phase for"
          )}{" "}
          rework.
        </span>
      </div>
      {flagGate.reason && (
        <p className="whitespace-pre-wrap text-muted-foreground">
          {flagGate.reason}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Approving re-runs that phase and everything built on it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" onClick={onConfirm}>
          Approve send-back
        </Button>
        <Button size="xs" variant="outline" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}

// ─── New Run modal ───────────────────────────────────────────────────────────
// A centered modal (sibling Dialog, not the takeover primitive) to start a run:
// an objective + a REQUIRED working directory (a run's phase workers fail closed
// without a cwd — plan 026). Mirrors project-dialog.tsx's folder-picker pattern.
function NewRunModal({
  open,
  onOpenChange,
  onRun,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRun: (objective: string, workspacePath: string) => Promise<void>
}) {
  const [objective, setObjective] = useState("")
  const [folder, setFolder] = useState("")
  const [starting, setStarting] = useState(false)

  // Reset the form whenever the modal opens, so a reopen starts clean.
  useEffect(() => {
    if (open) {
      setObjective("")
      setFolder("")
      setStarting(false)
    }
  }, [open])

  async function pickDir() {
    const picked = await window.cowork.pickWorkspace()
    if (picked.path) setFolder(picked.path)
  }

  async function run() {
    if (!folder.trim()) return
    setStarting(true)
    try {
      await onRun(objective, folder)
    } catch (err) {
      toast.error(`Could not start run: ${err}`)
      setStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New run</DialogTitle>
          <DialogDescription>
            Start a run of this process. Phases run in the chosen folder — a new
            project from scratch, or an existing codebase to modify.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Objective
            </label>
            <Textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="Describe what this run should accomplish…"
              className="min-h-20 resize-y"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Working directory <span className="text-destructive">*</span>
            </label>
            {folder ? (
              <div className="flex items-center gap-2">
                <span
                  className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs"
                  title={folder}
                >
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  {basename(folder)}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={pickDir}
                >
                  Change
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setFolder("")}
                  aria-label="Clear folder"
                >
                  <XIcon />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={pickDir}
                className="justify-start"
              >
                <FolderOpen className="size-4" />
                Choose folder…
              </Button>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={starting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={run}
            disabled={starting || !folder.trim()}
          >
            <Play className="size-4" />
            {starting ? "Starting…" : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Status helpers ──────────────────────────────────────────────────────────

// Fold a single process_phase event into the gate map: a waiting_for_approval
// event with a requestId sets the phase's gate; any other status for it clears.
// A FLAG gate (plan 031.2, gateKind "flag") is EXCLUDED — it's rendered by the
// separate flagGates map / card, not the generic approve card, so it must not
// land here (else a flagging phase would show both cards).
export function foldGate(
  gates: Record<string, GateInfo>,
  ev: Extract<TaskEventPayload, { type: "process_phase" }>
): Record<string, GateInfo> {
  if (
    ev.status === "waiting_for_approval" &&
    ev.requestId &&
    ev.gateKind !== "flag"
  ) {
    return {
      ...gates,
      [ev.phaseRunId]: {
        requestId: ev.requestId,
        gateKind: ev.gateKind === "validator" ? "validator" : "phase",
      },
    }
  }
  if (gates[ev.phaseRunId]) {
    const next = { ...gates }
    delete next[ev.phaseRunId]
    return next
  }
  return gates
}

// Rebuild the whole gate map from a replayed event stream (newest wins per
// phase). Used to recover pending gates after the monitor (re)mounts.
export function deriveGates(
  events: TaskEventPayload[]
): Record<string, GateInfo> {
  let gates: Record<string, GateInfo> = {}
  for (const ev of events) {
    if (ev.type === "process_phase") gates = foldGate(gates, ev)
  }
  return gates
}

export function recoverProcessMonitorGates(input: {
  events: TaskEventPayload[]
  approvals: Approval[]
}): {
  gates: Record<string, GateInfo>
  flagGates: Record<string, FlagGateInfo>
  requests: Record<string, ProcessGateRequest>
} {
  const gates = deriveGates(input.events)
  const flagGates: Record<string, FlagGateInfo> = {}
  const requests: Record<string, ProcessGateRequest> = {}
  for (const approval of input.approvals) {
    const req = approval.request as ProcessGateRequest | null
    if (req?.requestId) requests[req.requestId] = req
    if (approval.status === "pending") {
      if (req?.kind === "process_flag_gate") {
        flagGates[req.phaseRunId] = {
          requestId: req.requestId,
          targetKey: req.flagTargetKey ?? "",
          reason: req.flagReason ?? "",
        }
      }
      continue
    }
    if (req && gates[req.phaseRunId]?.requestId === req.requestId)
      delete gates[req.phaseRunId]
  }
  return { gates, flagGates, requests }
}

function runLabel(run: ProcessRun): string {
  const when = run.startedAt ?? run.createdAt
  // Prefer the generated title; fall back to an objective slice for pre-existing
  // (title-less) runs.
  const obj = run.objective?.trim()
  const label = run.title?.trim() || (obj ? obj.slice(0, 40) : "")
  return `${formatRelativeTime(when)}${label ? ` — ${label}` : ""}`
}

function StatusIcon({ status }: { status: PhaseRunStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-4 shrink-0 animate-spin text-blue-500" />
    case "completed":
      return <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
    case "failed":
      return <XCircle className="size-4 shrink-0 text-destructive" />
    case "cancelled":
      return <XCircle className="size-4 shrink-0 text-muted-foreground" />
    case "skipped":
      return <SkipForward className="size-4 shrink-0 text-muted-foreground" />
    case "waiting_for_approval":
      return <ShieldAlert className="size-4 shrink-0 text-amber-500" />
    default:
      // pending / ready
      return <Circle className="size-4 shrink-0 text-muted-foreground" />
  }
}

const PHASE_STATUS_LABEL: Record<PhaseRunStatus, string> = {
  pending: "Pending",
  ready: "Ready",
  running: "Running",
  waiting_for_approval: "Needs approval",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
}

function PhaseStatusLabel({ status }: { status: PhaseRunStatus }) {
  return (
    <span className="shrink-0 text-xs text-muted-foreground">
      {PHASE_STATUS_LABEL[status]}
    </span>
  )
}

function RunStatusBadge({ status }: { status: ProcessRun["status"] }) {
  const variant =
    status === "completed"
      ? "default"
      : status === "failed" || status === "cancelled"
        ? "destructive"
        : "secondary"
  return (
    <Badge variant={variant} className="shrink-0 capitalize">
      {status.replace(/_/g, " ")}
    </Badge>
  )
}
