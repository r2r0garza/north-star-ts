import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  ChevronRight,
  Circle,
  CheckCircle2,
  XCircle,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  SkipForward,
  Trash2,
  XIcon,
} from "lucide-react"
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
  ProcessPhaseRun,
  ProcessRun,
  Task,
  TaskEventPayload,
  TaskLiveEvent,
} from "@/types"

// The durable approval row's `request` blob for a process gate (mirrors
// GateRequest in the scheduler). Carries the gated phase's own phaseRunId, which
// keys the monitor's gate map — so we can drop a settled gate on reconcile. A
// process_flag_gate (plan 031.2) additionally carries the flag's target + reason
// so the monitor renders the confirmation card off the approvals row alone.
interface ProcessGateRequest {
  kind: "process_phase_gate" | "process_validator_gate" | "process_flag_gate"
  phaseKey: string
  phaseRunId: string
  requestId: string
  flagId?: string
  flagTargetKey?: string
  flagReason?: string
}

// A pending cross-phase rework flag awaiting human confirmation (plan 031.2),
// rendered on the FLAGGING phase-run's card.
interface FlagGateInfo {
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

  const loadDefinitions = useCallback(() => {
    window.cowork.db.processes.list().then(setDefinitions)
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
  onDelete,
}: {
  definition: ProcessDefinition
  onOpen: () => void
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
        <CardAction>
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
  const addable = agents.filter((a) => !poolNames.has(a.name))
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
      open={expanded}
      onOpenChange={setExpanded}
      className="rounded-lg border bg-card"
    >
      {/* Summary row (always visible): chevron + name + at-a-glance badges +
          delete. Click toggles expand; the delete button stops propagation. */}
      <div className="flex items-center gap-2 px-3 py-2">
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
              title={
                phase.subprocessId
                  ? "Disabled: a sub-process phase can't also fan out"
                  : undefined
              }
            >
              <span className="text-muted-foreground">Fan-out</span>
              <Switch
                checked={phase.fanOut}
                disabled={!!phase.subprocessId}
                onCheckedChange={(v) => patchPhase({ fanOut: v })}
              />
            </label>
            {/* SUB-PROCESS phase (plan 038.1): run another definition as a nested
            run instead of an agent worker. Mutually exclusive with fan-out — hidden
            while fan-out is on, and it disables fan-out when set. Only offered when
            there's a candidate definition (any other process) to run. */}
            {!phase.fanOut && subprocessCandidates.length > 0 && (
              <label
                className="flex items-center gap-2 text-xs"
                title="Run another process definition as a nested run for this phase"
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
                <Select
                  // Radix Select can't use an empty-string value, so the "own
                  // agent" default (null) maps to a sentinel option.
                  value={phase.validatorAgent ?? OWN_AGENT}
                  onValueChange={(v) =>
                    patchPhase({
                      validatorAgent: v === OWN_AGENT ? null : v,
                    })
                  }
                >
                  <SelectTrigger size="sm" className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={OWN_AGENT}>
                      Phase&apos;s own agent
                    </SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.name} value={a.name}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                This phase delegates to the nested process; its aggregated output
                feeds downstream phases. The agent pool and routing are unused.
              </span>
            </div>
          )}

          {/* Row 3: agent pool. Hidden for a sub-process phase (no worker to pool). */}
          {!phase.subprocessId && (
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
              {pool.map((a) => (
                <Badge key={a.id} variant="secondary" className="gap-1 pr-1">
                  {a.agentName}
                  <button
                    type="button"
                    onClick={() => removePoolAgent(a.id)}
                    className="rounded-sm p-0.5 hover:bg-background/60"
                    aria-label={`Remove ${a.agentName}`}
                  >
                    <XIcon className="size-3" />
                  </button>
                </Badge>
              ))}
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
                  value: a.name,
                  label: a.name,
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
  // phaseRunId → the pending gate's requestId (derived from the event stream).
  const [gates, setGates] = useState<Record<string, string>>({})
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
  // Absolute path of the run's workspace, resolved from run.workspaceId (there's
  // no workspaces.get — list-and-find). Fed to the per-phase file chips (plan
  // 030b) to build file:// URLs, git diffs, and open-in-editor. "" when unknown.
  const [workspacePath, setWorkspacePath] = useState("")

  // Open a phase/child's worker transcript. Fetches the backing Task by its id;
  // no-op if the phase never spawned a worker (taskId null) or the task vanished.
  async function openTranscript(phaseRun: ProcessPhaseRun) {
    if (!phaseRun.taskId) return
    const task = await window.cowork.db.tasks.get(phaseRun.taskId)
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
    setPhaseRuns(prs)
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
        const gates = deriveGates(
          events.map((e) => e.payload as TaskEventPayload)
        )
        const flagInfo: Record<string, FlagGateInfo> = {}
        for (const a of approvals) {
          const req = a.request as ProcessGateRequest | null
          if (a.status === "pending") {
            // A pending flag gate: record its target + reason so PhaseRunItem can
            // render the confirmation card (keyed by the flagging phase-run).
            if (req?.kind === "process_flag_gate")
              flagInfo[req.phaseRunId] = {
                requestId: req.requestId,
                targetKey: req.flagTargetKey ?? "",
                reason: req.flagReason ?? "",
              }
            continue
          }
          // Drop the gate only if THIS settled row is the one the map is showing
          // (match by requestId, not phaseRunId): after a "Request changes" round
          // a phase-run has both a denied old row and a fresh pending gate — the
          // denied row must not clear the live one (plan 029). Applies to all gate
          // kinds (phase / validator / flag).
          if (req && gates[req.phaseRunId] === req.requestId)
            delete gates[req.phaseRunId]
        }
        setGates(gates)
        setFlagGates(flagInfo)
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
            for (const a of approvals) {
              if (a.status !== "pending") continue
              const req = a.request as ProcessGateRequest | null
              if (req?.kind === "process_flag_gate")
                info[req.phaseRunId] = {
                  requestId: req.requestId,
                  targetKey: req.flagTargetKey ?? "",
                  reason: req.flagReason ?? "",
                }
            }
            setFlagGates(info)
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
    try {
      await window.cowork.process.approve({ processRunId: run.id, requestId })
    } catch (err) {
      toast.error(`Could not approve phase: ${err}`)
    }
  }
  async function deny(requestId: string, phaseRunId: string) {
    if (!run) return
    clearGate(phaseRunId)
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => window.cowork.process.restart(run.id)}
          >
            <RotateCcw className="size-3.5" />
            Retry
          </Button>
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
              gateRequestId={gates[pr.id]}
              flagGate={flagGates[pr.id]}
              childFlagGates={flagGates}
              childRuns={childrenOf.get(pr.id) ?? []}
              phaseName={phaseName}
              maxReworkRounds={phaseMaxRework(pr.phaseId)}
              isContainer={phaseIsContainer(pr.phaseId)}
              isSubProcess={phaseIsSubProcess(pr.phaseId)}
              refreshTick={refreshTick}
              workspacePath={workspacePath}
              onApprove={approve}
              onDeny={deny}
              onRequestChanges={requestChanges}
              onConfirmFlag={confirmFlag}
              onDismissFlag={dismissFlag}
              onOpenTranscript={openTranscript}
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
}: {
  taskId: string
  status: PhaseRunStatus
  workspacePath: string
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
      onReviewAll={(fs) => {
        for (const f of fs)
          void window.cowork.openInEditor(workspacePath, f.path)
      }}
    />
  )
}

// One top-level phase run row: status icon + name + agent, its inline approval
// card when gated, and its nested children (fan-out / on_each_subtask instances).
function PhaseRunItem({
  phaseRun,
  name,
  gateRequestId,
  flagGate,
  childFlagGates,
  childRuns,
  phaseName,
  maxReworkRounds,
  isContainer,
  isSubProcess,
  refreshTick,
  workspacePath,
  onApprove,
  onDeny,
  onRequestChanges,
  onConfirmFlag,
  onDismissFlag,
  onOpenTranscript,
}: {
  phaseRun: ProcessPhaseRun
  name: string
  gateRequestId: string | undefined
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
  onConfirmFlag: (requestId: string, phaseRunId: string) => void
  onDismissFlag: (requestId: string, phaseRunId: string) => void
  // Open a phase/child's worker transcript (only rows with a taskId).
  onOpenTranscript: (phaseRun: ProcessPhaseRun) => void
}) {
  // A gated phase's own row stays `completed` in the DB — the gate is a run-level
  // hold on its dependents (the requestId rides the event + a durable approval
  // row, not the phase status). So drive the card off the gate map, not the
  // phase-run status, and OVERRIDE the displayed status to read as awaiting.
  const gated = gateRequestId !== undefined
  const displayStatus = gated ? "waiting_for_approval" : phaseRun.status
  const clickable = phaseRun.taskId !== null

  // "Request changes" (plan 029): a collapsible feedback box. Hidden for a
  // container phase (backend rejects it) or once the per-phase rework cap is hit
  // (0 = unlimited) — then only Approve/Deny remain.
  const [reworkOpen, setReworkOpen] = useState(false)
  const [reworkText, setReworkText] = useState("")
  const atReworkCap =
    maxReworkRounds > 0 && phaseRun.reworkRound >= maxReworkRounds
  const canRequestChanges = !isContainer && !atReworkCap
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
          <Badge variant="outline" className="shrink-0 font-mono text-[10px]">
            {phaseRun.agentName}
          </Badge>
        )}
        <PhaseStatusLabel status={displayStatus} />
      </div>

      {phaseRun.error && (
        <pre className="overflow-x-auto rounded-md bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
          {phaseRun.error}
        </pre>
      )}

      {/* Files this phase's worker produced (plan 030b). */}
      {phaseRun.taskId && (
        <PhaseFileChips
          taskId={phaseRun.taskId}
          status={phaseRun.status}
          workspacePath={workspacePath}
        />
      )}

      {/* Inline approval card for an approve-gated phase (reuses the activity
          panel affordance, wired to process.approve/deny). */}
      {gated && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <div className="flex items-center gap-2 font-medium text-amber-600 dark:text-amber-500">
            <ShieldAlert className="size-3.5 shrink-0" />
            <span>
              “{name}” is done — approve to release its downstream phases.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              onClick={() => onApprove(gateRequestId, phaseRun.id)}
            >
              Approve <Kbd className="ml-1.5">⏎</Kbd>
            </Button>
            <Button
              size="xs"
              variant="destructive"
              onClick={() => onDeny(gateRequestId, phaseRun.id)}
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
          {atReworkCap && !isContainer && (
            <p className="text-[11px] text-muted-foreground">
              Rework limit reached ({maxReworkRounds}). Approve or deny to
              continue.
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
                    onRequestChanges(
                      gateRequestId,
                      phaseRun.id,
                      reworkText.trim()
                    )
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
                  <span className="min-w-0 flex-1 truncate">
                    {c.title ?? `${phaseName(c.phaseId)} #${i + 1}`}
                  </span>
                  {c.agentName && (
                    <Badge
                      variant="outline"
                      className="shrink-0 font-mono text-[10px]"
                    >
                      {c.agentName}
                    </Badge>
                  )}
                  <PhaseStatusLabel status={c.status} />
                </div>
                {/* This sub-task's produced files (plan 030b). */}
                {c.taskId && (
                  <div className="pl-1">
                    <PhaseFileChips
                      taskId={c.taskId}
                      status={c.status}
                      workspacePath={workspacePath}
                    />
                  </div>
                )}
                {/* A per-child rework flag this INSTANCE raised (plan 031.2):
                    an on_each_subtask consumer instance that flagged its source
                    sub-task. Rendered here since the instance is a nested child,
                    not a top-level row. */}
                {childFlagGates[c.id] && (
                  <div className="pl-1">
                    <FlagCard
                      flagGate={childFlagGates[c.id]}
                      flaggerName={c.title ?? phaseName(c.phaseId)}
                      onConfirm={() =>
                        onConfirmFlag(childFlagGates[c.id].requestId, c.id)
                      }
                      onDismiss={() =>
                        onDismissFlag(childFlagGates[c.id].requestId, c.id)
                      }
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* The nested run of a sub-process phase (plan 038.1): expandable, lazily
          fetched, and recursively rendered against the CHILD definition's graph. */}
      {isSubProcess && (
        <SubProcessNestedRun
          parentPhaseRunId={phaseRun.id}
          workspacePath={workspacePath}
          onOpenTranscript={onOpenTranscript}
          refreshTick={refreshTick}
          depth={0}
        />
      )}
    </div>
  )
}

// The nested run beneath a sub-process phase-run (plan 038.1). Collapsed by
// default; on expand it lazily fetches the child run (by parent_phase_run_id), its
// definition graph, and its phase-runs, then renders them as a compact tree —
// top-level phases with their fan-out/on_each_subtask children indented, names
// resolved against the CHILD graph. Recurses for a sub-process phase INSIDE the
// child (bounded by MAX_PROCESS_DEPTH). Read-only: gates/flags inside a nested run
// surface on the shared task tail at the top level (v1 scope, plan 038.2).
const MAX_NESTED_DEPTH = 5
function SubProcessNestedRun({
  parentPhaseRunId,
  workspacePath,
  onOpenTranscript,
  refreshTick,
  depth,
}: {
  parentPhaseRunId: string
  workspacePath: string
  onOpenTranscript: (phaseRun: ProcessPhaseRun) => void
  // Bumped by the monitor on every live task event; re-fetches the child run's
  // rows while expanded so a running nested run's phases update live (plan 038.1).
  refreshTick: number
  depth: number
}) {
  const [open, setOpen] = useState(false)
  const [graph, setGraph] = useState<ProcessGraph | null>(null)
  const [phaseRuns, setPhaseRuns] = useState<ProcessPhaseRun[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const runs = await window.cowork.db.processes.runs.list({ parentPhaseRunId })
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
    setPhaseRuns(prs)
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
          {topLevel.map((pr) => (
            <div key={pr.id} className="flex flex-col gap-0.5">
              <div
                onClick={
                  pr.taskId ? () => onOpenTranscript(pr) : undefined
                }
                className={cn(
                  "flex items-center gap-2 rounded-md px-1 py-0.5 text-xs",
                  pr.taskId && "cursor-pointer hover:bg-muted/60"
                )}
                title={pr.taskId ? "View this phase's transcript" : undefined}
              >
                <StatusIcon status={pr.status} />
                <span className="min-w-0 flex-1 truncate">
                  {pr.title ?? phaseName(pr.phaseId)}
                </span>
                {pr.agentName && (
                  <Badge
                    variant="outline"
                    className="shrink-0 font-mono text-[10px]"
                  >
                    {pr.agentName}
                  </Badge>
                )}
                <PhaseStatusLabel status={pr.status} />
              </div>
              {(childrenOf.get(pr.id) ?? []).map((c, i) => (
                <div
                  key={c.id}
                  onClick={c.taskId ? () => onOpenTranscript(c) : undefined}
                  className={cn(
                    "ml-3 flex items-center gap-2 rounded-md border-l-2 px-1 py-0.5 pl-2 text-xs",
                    c.taskId && "cursor-pointer hover:bg-muted/60"
                  )}
                >
                  <StatusIcon status={c.status} />
                  <span className="min-w-0 flex-1 truncate">
                    {c.title ?? `${phaseName(c.phaseId)} #${i + 1}`}
                  </span>
                  <PhaseStatusLabel status={c.status} />
                </div>
              ))}
              {/* A sub-process phase INSIDE the nested run recurses (bounded). */}
              {isSubProcess(pr.phaseId) && depth + 1 < MAX_NESTED_DEPTH && (
                <SubProcessNestedRun
                  parentPhaseRunId={pr.id}
                  workspacePath={workspacePath}
                  onOpenTranscript={onOpenTranscript}
                  refreshTick={refreshTick}
                  depth={depth + 1}
                />
              )}
            </div>
          ))}
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
function foldGate(
  gates: Record<string, string>,
  ev: Extract<TaskEventPayload, { type: "process_phase" }>
): Record<string, string> {
  if (
    ev.status === "waiting_for_approval" &&
    ev.requestId &&
    ev.gateKind !== "flag"
  ) {
    return { ...gates, [ev.phaseRunId]: ev.requestId }
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
function deriveGates(events: TaskEventPayload[]): Record<string, string> {
  let gates: Record<string, string> = {}
  for (const ev of events) {
    if (ev.type === "process_phase") gates = foldGate(gates, ev)
  }
  return gates
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
