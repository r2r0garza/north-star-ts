import { useEffect, useMemo, useState } from "react"
import {
  CircleDot,
  CircleHelp,
  FolderOpen,
  GitBranch,
  List,
  Plus,
  Rocket,
  Trash2,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { deriveWaves } from "../../../../shared/mission-control/waves"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { TooltipButton } from "@/components/ui/tooltip"
import type {
  Initiative,
  InitiativeGraph,
  Mission,
  Project,
  Rig,
  SliceSpec,
  WorkSlice,
  Workspace,
} from "@/types"

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32)
}
function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^Error:\s*/, "")
}
function lines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
}

function SliceEditor({
  graph,
  slice,
  onSaved,
}: {
  graph: InitiativeGraph
  slice: WorkSlice
  onSaved: (graph: InitiativeGraph) => void
}) {
  const [title, setTitle] = useState(slice.title)
  const [key, setKey] = useState(slice.key)
  const [goal, setGoal] = useState(slice.spec.goal)
  const [acceptance, setAcceptance] = useState(
    slice.spec.acceptance.length > 0 ? slice.spec.acceptance : [""]
  )
  const [outOfScope, setOutOfScope] = useState(slice.spec.outOfScope.join("\n"))
  const [touchHints, setTouchHints] = useState(
    slice.spec.touchHints.length > 0 ? slice.spec.touchHints : [""]
  )
  const [notes, setNotes] = useState(slice.spec.notes)
  const [podKey, setPodKey] = useState(slice.podKey ?? "default")
  const pods = graph.initiative.rigSnapshot?.pods ?? []
  const save = async () => {
    const spec: SliceSpec = {
      goal,
      acceptance: acceptance.map((item) => item.trim()).filter(Boolean),
      outOfScope: lines(outOfScope),
      touchHints: touchHints.map((item) => item.trim()).filter(Boolean),
      notes,
    }
    onSaved(
      await window.cowork.missionControl.slices.update(
        slice.id,
        {
          title: title.trim(),
          key: slug(key),
          spec,
          podKey: podKey === "default" ? null : podKey,
        },
        graph.initiative.status === "draft" ? undefined : "Refine slice spec"
      )
    )
  }
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Title</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Key</Label>
          <Input value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1">
        <Label>Goal</Label>
        <Textarea
          rows={4}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <Label>Acceptance criteria</Label>
          <div className="flex flex-col gap-2">
            {acceptance.map((criterion, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-xs font-medium text-muted-foreground">
                  AC-{index + 1}
                </span>
                <Input
                  value={criterion}
                  onChange={(event) => {
                    const next = [...acceptance]
                    next[index] = event.target.value
                    setAcceptance(next)
                  }}
                  placeholder="A checkable result"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove acceptance criterion ${index + 1}`}
                  onClick={() => {
                    const next = acceptance.filter((_, item) => item !== index)
                    setAcceptance(next.length > 0 ? next : [""])
                  }}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setAcceptance([...acceptance, ""])}
            >
              <Plus className="size-4" /> Add criterion
            </Button>
          </div>
        </div>
        <div className="space-y-1">
          <Label>Out of scope</Label>
          <Textarea
            rows={7}
            value={outOfScope}
            onChange={(e) => setOutOfScope(e.target.value)}
            placeholder="One explicit non-goal per line"
          />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Label>Touch hints (optional)</Label>
            <TooltipButton
              tooltip="Optional paths or glob patterns expected to change, such as src/billing/**. These help schedule merges and detect drift."
              type="button"
              className="text-muted-foreground hover:text-foreground"
              aria-label="About touch hints"
            >
              <CircleHelp className="size-3.5" />
            </TooltipButton>
          </div>
          <div className="flex flex-col gap-2">
            {touchHints.map((hint, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  value={hint}
                  onChange={(event) => {
                    const next = [...touchHints]
                    next[index] = event.target.value
                    setTouchHints(next)
                  }}
                  className="font-mono text-xs"
                  placeholder="src/billing/**"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove touch hint ${index + 1}`}
                  onClick={() => {
                    const next = touchHints.filter((_, item) => item !== index)
                    setTouchHints(next.length > 0 ? next : [""])
                  }}
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setTouchHints([...touchHints, ""])}
            >
              <Plus className="size-4" /> Add touch hint
            </Button>
          </div>
        </div>
        <div className="space-y-1">
          <Label>Notes</Label>
          <Textarea
            rows={5}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label>Assigned pod</Label>
        <Select value={podKey} onValueChange={setPodKey}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Initiative default</SelectItem>
            {pods.map((pod) => (
              <SelectItem key={pod.key} value={pod.key}>
                {pod.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="rounded-md border bg-muted/30 p-4">
        <h3 className="text-sm font-medium">Proof</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Proof is collected when slice execution lands in the next Mission
          Control milestone.
        </p>
      </div>
      <Button
        onClick={() =>
          void save().catch((error) => toast.error(errorMessage(error)))
        }
      >
        Save slice
      </Button>
      {graph.revisions.filter((revision) => revision.targetId === slice.id)
        .length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Revision history</h3>
          {graph.revisions
            .filter((revision) => revision.targetId === slice.id)
            .map((revision) => (
              <div
                key={revision.id}
                className="border-l pl-3 text-xs text-muted-foreground"
              >
                {revision.actor} · {revision.change.op}
                {revision.reason ? ` — ${revision.reason}` : ""}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function MissionView({
  graph,
  mission,
  onGraph,
  onOpenSlice,
}: {
  graph: InitiativeGraph
  mission: Mission
  onGraph: (graph: InitiativeGraph) => void
  onOpenSlice: (id: string) => void
}) {
  const slices = graph.slices.filter((slice) => slice.missionId === mission.id)
  const edges = graph.edges.filter((edge) => edge.missionId === mission.id)
  const result = deriveWaves(slices, edges)
  const [missionName, setMissionName] = useState(mission.name)
  const [outcome, setOutcome] = useState(mission.outcome)
  const [definitionOfDone, setDefinitionOfDone] = useState(
    mission.definitionOfDone
  )
  const [newTitle, setNewTitle] = useState("")
  const [dependencyTarget, setDependencyTarget] = useState("")
  const [dependencySource, setDependencySource] = useState("")
  const saveMission = async () =>
    onGraph(
      await window.cowork.missionControl.missions.update(
        mission.id,
        { name: missionName, outcome, definitionOfDone },
        graph.initiative.status === "draft"
          ? undefined
          : "Refine mission outcome"
      )
    )
  const addSlice = async () => {
    const next = await window.cowork.missionControl.slices.create({
      missionId: mission.id,
      key: slug(newTitle),
      title: newTitle,
    })
    setNewTitle("")
    onGraph(next)
  }
  const addDependency = async () => {
    if (!dependencySource || !dependencyTarget) return
    const next = await window.cowork.missionControl.sliceEdges.set(
      mission.id,
      [
        ...edges.map((edge) => ({
          fromSliceId: edge.fromSliceId,
          toSliceId: edge.toSliceId,
        })),
        { fromSliceId: dependencySource, toSliceId: dependencyTarget },
      ],
      graph.initiative.status === "draft" ? undefined : "Update dependency plan"
    )
    setDependencySource("")
    setDependencyTarget("")
    onGraph(next)
  }
  return (
    <div className="space-y-5">
      <div className="grid gap-3 rounded-lg border p-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Mission name</Label>
            <Input
              value={missionName}
              onChange={(e) => setMissionName(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Outcome</Label>
            <Textarea
              rows={4}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Definition of done</Label>
            <Textarea
              rows={4}
              value={definitionOfDone}
              onChange={(e) => setDefinitionOfDone(e.target.value)}
            />
          </div>
          <Button
            disabled={!missionName.trim()}
            onClick={() =>
              void saveMission().catch((error) =>
                toast.error(errorMessage(error))
              )
            }
          >
            Save mission
          </Button>
        </div>
      </div>
      <div className="flex gap-2">
        <Input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="New slice title"
        />
        <Button
          disabled={!slug(newTitle)}
          onClick={() =>
            void addSlice().catch((error) => toast.error(errorMessage(error)))
          }
        >
          <Plus className="size-4" /> Add slice
        </Button>
      </div>
      {slices.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          Add slices to build this mission's work map.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border p-4">
          <div className="flex gap-6">
            {result.waves.map((wave, index) => (
              <div key={index} className="min-w-64 flex-1 space-y-3">
                <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Wave {index + 1}
                </div>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
                  {wave.map((slice) => (
                    <button
                      key={slice.id}
                      className={`block w-full rounded-lg border p-3 text-left hover:bg-muted/50 ${result.criticalPath.includes(slice.id) ? "border-primary/60" : ""}`}
                      onClick={() => onOpenSlice(slice.id)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{slice.title}</span>
                        <Badge className="ml-auto" variant="outline">
                          {slice.status}
                        </Badge>
                      </div>
                      <code className="text-xs text-muted-foreground">
                        {slice.key}
                      </code>
                      {edges.filter((edge) => edge.toSliceId === slice.id)
                        .length > 0 && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          Depends on{" "}
                          {edges
                            .filter((edge) => edge.toSliceId === slice.id)
                            .map(
                              (edge) =>
                                slices.find(
                                  (item) => item.id === edge.fromSliceId
                                )?.key
                            )
                            .join(", ")}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {slices.length > 1 && (
        <div className="flex gap-2 rounded-lg border p-3">
          <Select
            value={dependencyTarget}
            onValueChange={(value) => {
              setDependencyTarget(value)
              setDependencySource("")
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Slice" />
            </SelectTrigger>
            <SelectContent>
              {slices.map((slice) => (
                <SelectItem key={slice.id} value={slice.id}>
                  {slice.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="self-center text-sm text-muted-foreground">
            depends on
          </span>
          <Select value={dependencySource} onValueChange={setDependencySource}>
            <SelectTrigger>
              <SelectValue placeholder="Predecessor" />
            </SelectTrigger>
            <SelectContent>
              {slices
                .filter(
                  (slice) =>
                    slice.id !== dependencyTarget &&
                    !edges.some(
                      (edge) =>
                        edge.toSliceId === dependencyTarget &&
                        edge.fromSliceId === slice.id
                    )
                )
                .map((slice) => (
                  <SelectItem key={slice.id} value={slice.id}>
                    {slice.title}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={() =>
              void addDependency().catch((error) =>
                toast.error(errorMessage(error))
              )
            }
          >
            Add
          </Button>
        </div>
      )}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <List className="size-4" /> Accessible list
        </div>
        {slices.map((slice) => (
          <button
            key={slice.id}
            className="flex w-full items-center rounded-md border px-3 py-2 text-left text-sm"
            onClick={() => onOpenSlice(slice.id)}
          >
            <span>{slice.title}</span>
            <span className="ml-auto text-muted-foreground">
              Wave {(result.levels.get(slice.id) ?? 0) + 1}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function InitiativeView({
  graph,
  rigs,
  workspaces,
  projects,
  onGraph,
  onMission,
}: {
  graph: InitiativeGraph
  rigs: Rig[]
  workspaces: Workspace[]
  projects: Project[]
  onGraph: (graph: InitiativeGraph) => void
  onMission: (id: string) => void
}) {
  const initiative = graph.initiative
  const [name, setName] = useState(initiative.name)
  const [intent, setIntent] = useState(initiative.intent)
  const [done, setDone] = useState(initiative.definitionOfDone)
  const [missionName, setMissionName] = useState("")
  const save = async () =>
    onGraph(
      await window.cowork.missionControl.initiatives.update(
        initiative.id,
        { name, intent, definitionOfDone: done },
        initiative.status === "draft"
          ? undefined
          : "Update initiative definition"
      )
    )
  const addMission = async () => {
    const next = await window.cowork.missionControl.missions.create({
      initiativeId: initiative.id,
      key: slug(missionName),
      name: missionName,
      outcome: "",
    })
    setMissionName("")
    onGraph(next)
  }
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <code className="text-xs text-muted-foreground">{initiative.key}</code>
        <Badge className="ml-auto">{initiative.status}</Badge>
        {initiative.status === "draft" && (
          <Button
            disabled={!initiative.rigId}
            onClick={() =>
              void window.cowork.missionControl.initiatives
                .start(initiative.id)
                .then(onGraph)
                .catch((error) => toast.error(errorMessage(error)))
            }
          >
            <Rocket className="size-4" /> Start
          </Button>
        )}
      </div>
      {graph.rigDrifted && (
        <div className="flex items-center rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <span>The selected rig changed since this initiative started.</span>
          <Button
            className="ml-auto"
            size="sm"
            variant="outline"
            onClick={() =>
              void window.cowork.missionControl.initiatives
                .reseat(initiative.id, "Apply latest rig definition")
                .then(onGraph)
            }
          >
            Re-seat
          </Button>
        </div>
      )}
      <div className="grid gap-4 rounded-lg border p-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Intent</Label>
            <Textarea
              rows={6}
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Definition of done</Label>
            <Textarea
              rows={6}
              value={done}
              onChange={(e) => setDone(e.target.value)}
            />
          </div>
          <Button
            onClick={() =>
              void save().catch((error) => toast.error(errorMessage(error)))
            }
          >
            Save definition
          </Button>
        </div>
      </div>
      <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-3">
        <div>
          <div className="text-xs text-muted-foreground">Rig</div>
          <div className="text-sm">
            {rigs.find((rig) => rig.id === initiative.rigId)?.name ?? "None"}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Workspace</div>
          <div className="truncate text-sm">
            {workspaces.find(
              (workspace) => workspace.id === initiative.workspaceId
            )?.name ?? "None"}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Project</div>
          <div className="text-sm">
            {projects.find((project) => project.id === initiative.projectId)
              ?.name ?? "None"}
          </div>
        </div>
      </div>
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="font-medium">Missions</h3>
            <p className="text-sm text-muted-foreground">
              Missions run in this order.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={missionName}
              onChange={(e) => setMissionName(e.target.value)}
              placeholder="Mission name"
            />
            <Button
              disabled={!slug(missionName)}
              onClick={() =>
                void addMission().catch((error) =>
                  toast.error(errorMessage(error))
                )
              }
            >
              <Plus className="size-4" />
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          {graph.missions.map((mission, index) => {
            const slices = graph.slices.filter(
              (slice) => slice.missionId === mission.id
            )
            return (
              <button
                key={mission.id}
                className="flex w-full items-center gap-3 rounded-lg border p-4 text-left hover:bg-muted/50"
                onClick={() => onMission(mission.id)}
              >
                <CircleDot
                  className={`size-4 ${mission.status === "completed" ? "text-emerald-500" : mission.status === "active" ? "text-primary" : "text-muted-foreground"}`}
                />
                <div>
                  <div className="font-medium">
                    {index + 1}. {mission.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {mission.outcome || "Add an outcome"}
                  </div>
                </div>
                <span className="ml-auto text-xs text-muted-foreground">
                  {slices.filter((slice) => slice.status === "done").length}/
                  {slices.length} slices
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function InitiativesTab({
  rigs,
  graph,
  missionId,
  sliceId,
  onGraphChange,
  onMissionChange,
  onSliceChange,
}: {
  rigs: Rig[]
  graph: InitiativeGraph | null
  missionId: string | null
  sliceId: string | null
  onGraphChange: (graph: InitiativeGraph | null) => void
  onMissionChange: (id: string | null) => void
  onSliceChange: (id: string | null) => void
}) {
  const [items, setItems] = useState<Initiative[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState("")
  const [intent, setIntent] = useState("")
  const [done, setDone] = useState("")
  const [rigId, setRigId] = useState("")
  const [workspaceId, setWorkspaceId] = useState("")
  const [projectId, setProjectId] = useState("none")
  const reload = async () => {
    const [nextItems, nextWorkspaces, nextProjects] = await Promise.all([
      window.cowork.missionControl.initiatives.list(),
      window.cowork.db.workspaces.list(),
      window.cowork.db.projects.list(),
    ])
    setItems(nextItems)
    setWorkspaces(nextWorkspaces)
    setProjects(nextProjects)
  }
  useEffect(() => {
    void reload()
  }, [])
  const applyGraph = (next: InitiativeGraph) => {
    onGraphChange(next)
    void reload()
  }
  const create = async () => {
    const linked =
      projectId === "none"
        ? null
        : (projects.find((project) => project.id === projectId) ?? null)
    const next = await window.cowork.missionControl.initiatives.create({
      key: slug(name),
      name,
      intent,
      definitionOfDone: done,
      rigId: rigId || null,
      projectId: linked?.id ?? null,
      workspaceId: linked?.workspaceId ?? (workspaceId || null),
    })
    setCreateOpen(false)
    setName("")
    setIntent("")
    setDone("")
    setRigId("")
    setWorkspaceId("")
    setProjectId("none")
    applyGraph(next)
  }
  const pickWorkspace = async () => {
    const picked = await window.cowork.pickWorkspace()
    if (!picked.path) return
    const workspace = await window.cowork.db.workspaces.upsert(picked.path)
    setWorkspaces((current) => [
      workspace,
      ...current.filter((item) => item.id !== workspace.id),
    ])
    setWorkspaceId(workspace.id)
  }
  const mission = graph?.missions.find((item) => item.id === missionId) ?? null
  const slice = graph?.slices.find((item) => item.id === sliceId) ?? null
  if (graph && slice)
    return (
      <SliceEditor
        graph={graph}
        slice={slice}
        onSaved={(next) => {
          applyGraph(next)
          onSliceChange(null)
        }}
      />
    )
  if (graph && mission)
    return (
      <MissionView
        graph={graph}
        mission={mission}
        onGraph={applyGraph}
        onOpenSlice={onSliceChange}
      />
    )
  if (graph)
    return (
      <InitiativeView
        graph={graph}
        rigs={rigs}
        workspaces={workspaces}
        projects={projects}
        onGraph={applyGraph}
        onMission={onMissionChange}
      />
    )
  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Initiatives</h2>
          <p className="text-sm text-muted-foreground">
            Write the work map your rig will drive.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" /> New initiative
        </Button>
      </div>
      {items.length === 0 ? (
        <div className="grid place-items-center rounded-xl border border-dashed py-16 text-center">
          <GitBranch className="mb-3 size-9 text-muted-foreground" />
          <h3 className="font-medium">Map your first initiative</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Define intent, missions, slices, and their dependency waves.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <Card
              key={item.id}
              className="cursor-pointer hover:bg-muted/30"
              onClick={() =>
                void window.cowork.missionControl.initiatives
                  .get(item.id)
                  .then((value) => value && onGraphChange(value))
              }
            >
              <CardHeader>
                <CardTitle>{item.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {item.intent || "No intent written yet."}
                </p>
                <div className="mt-4 flex items-center">
                  <Badge variant="outline">{item.status}</Badge>
                  <Button
                    className="ml-auto"
                    variant="ghost"
                    size="icon-sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      void window.cowork.missionControl.initiatives
                        .delete(item.id)
                        .then(reload)
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          className="sm:max-w-xl"
          onBackdropClick={() => setCreateOpen(false)}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>New initiative</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Billing v1"
              />
            </div>
            <div className="space-y-1">
              <Label>Intent</Label>
              <Textarea
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-1">
              <Label>Definition of done</Label>
              <Textarea
                value={done}
                onChange={(e) => setDone(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-1">
              <Label>Rig</Label>
              <Select value={rigId} onValueChange={setRigId}>
                <SelectTrigger className="text-foreground [&>svg]:text-foreground">
                  <SelectValue
                    className="text-foreground"
                    placeholder="Choose a rig"
                  />
                </SelectTrigger>
                <SelectContent>
                  {rigs.map((rig) => (
                    <SelectItem key={rig.id} value={rig.id}>
                      {rig.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Linked project (optional)</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No project</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {projectId === "none" && (
              <div className="space-y-1">
                <Label>Workspace</Label>
                <div className="flex gap-2">
                  <Select value={workspaceId} onValueChange={setWorkspaceId}>
                    <SelectTrigger className="min-w-0 flex-1 text-foreground [&>svg]:text-foreground">
                      <SelectValue
                        className="text-foreground"
                        placeholder="Choose a workspace"
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {workspaces.map((workspace) => (
                        <SelectItem key={workspace.id} value={workspace.id}>
                          {workspace.name || workspace.path}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void pickWorkspace().catch((error) =>
                        toast.error(errorMessage(error))
                      )
                    }
                  >
                    <FolderOpen className="size-4" /> Choose folder
                  </Button>
                </div>
                {workspaces.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No saved workspaces yet. Choose a folder to add one.
                  </p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!slug(name)}
              onClick={() =>
                void create().catch((error) => toast.error(errorMessage(error)))
              }
            >
              Create initiative
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
