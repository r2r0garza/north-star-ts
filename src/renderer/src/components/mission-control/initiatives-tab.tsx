import { useCallback, useEffect, useMemo, useState } from "react"
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
import { SliceRunPanel } from "./slice-run-panel"
import { HookControls } from "./hook-controls"
import { PlaybookPicker } from "./playbook-picker"
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
// Structural edits after start are audited and need a reason (plan 106.2).
function reasonFor(graph: InitiativeGraph, reason: string) {
  return graph.initiative.status === "draft" ? undefined : reason
}
// Shared by the detail views and the list rows. Resolves null when the user
// backs out of the confirmation.
async function deleteMissionConfirmed(
  graph: InitiativeGraph,
  mission: Mission
): Promise<InitiativeGraph | null> {
  const count = graph.slices.filter((s) => s.missionId === mission.id).length
  if (
    !window.confirm(
      `Delete mission “${mission.name}”${count ? ` and its ${count} slice${count === 1 ? "" : "s"}` : ""}? This cannot be undone.`
    )
  )
    return null
  return window.cowork.missionControl.missions.delete(
    mission.id,
    reasonFor(graph, "Remove mission")
  )
}
async function deleteSliceConfirmed(
  graph: InitiativeGraph,
  slice: WorkSlice
): Promise<InitiativeGraph | null> {
  if (!window.confirm(`Delete slice “${slice.title}”? This cannot be undone.`))
    return null
  return window.cowork.missionControl.slices.delete(
    slice.id,
    reasonFor(graph, "Remove slice")
  )
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
  workspacePath,
  onSaved,
  onGraph,
  onDeleted,
  onRefresh,
}: {
  graph: InitiativeGraph
  slice: WorkSlice
  workspacePath: string
  onSaved: (graph: InitiativeGraph) => void
  onGraph: (graph: InitiativeGraph) => void
  onDeleted: (graph: InitiativeGraph) => void
  onRefresh: () => Promise<void>
}) {
  // Once a slice has run, its spec is the proof's contract and only the
  // execution workflow may revise it (plan 106.2); other fields stay editable.
  const specFrozen = slice.startedAt !== null
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
          ...(specFrozen ? {} : { spec }),
          podKey: podKey === "default" ? null : podKey,
        },
        reasonFor(graph, "Refine slice spec")
      )
    )
  }
  const remove = async () => {
    const next = await deleteSliceConfirmed(graph, slice)
    if (next) onDeleted(next)
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
      <div className="grid gap-3 sm:grid-cols-2">
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
        <PlaybookPicker
          altitude="slice"
          value={slice.playbookId}
          onChange={async (playbookId) =>
            onGraph(
              await window.cowork.missionControl.slices.update(
                slice.id,
                { playbookId },
                reasonFor(graph, "Change slice playbook")
              )
            )
          }
        />
      </div>
      {specFrozen && (
        <p className="text-xs text-muted-foreground">
          This slice has run, so its spec is frozen as the proof's contract.
          Title, key, pod, and playbook can still change.
        </p>
      )}
      <SliceRunPanel
        graph={graph}
        slice={slice}
        workspacePath={workspacePath}
        onRefresh={onRefresh}
      />
      <div className="flex gap-2">
        <Button
          onClick={() =>
            void save().catch((error) => toast.error(errorMessage(error)))
          }
        >
          Save slice
        </Button>
        <Button
          variant="ghost"
          className="ml-auto text-muted-foreground hover:text-destructive"
          onClick={() =>
            void remove().catch((error) => toast.error(errorMessage(error)))
          }
        >
          <Trash2 className="size-4" /> Delete slice
        </Button>
      </div>
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
  onDeleted,
}: {
  graph: InitiativeGraph
  mission: Mission
  onGraph: (graph: InitiativeGraph) => void
  onOpenSlice: (id: string) => void
  onDeleted: (graph: InitiativeGraph) => void
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
        reasonFor(graph, "Refine mission outcome")
      )
    )
  const removeMission = async () => {
    const next = await deleteMissionConfirmed(graph, mission)
    if (next) onDeleted(next)
  }
  const removeSlice = async (slice: WorkSlice) => {
    const next = await deleteSliceConfirmed(graph, slice)
    if (next) onGraph(next)
  }
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
  const notActive =
    graph.initiative.status === "active"
      ? null
      : "Start the initiative before running its playbooks."
  return (
    <div className="space-y-5">
      <HookControls
        graph={graph}
        title="Mission playbook"
        actions={[
          {
            hook: "before_slices",
            label: "Run planning",
            missionId: mission.id,
            disabledReason:
              notActive ??
              (slices.length ? null : "Add slices to review first."),
          },
          {
            hook: "after_all_slices",
            label: "Run review",
            missionId: mission.id,
            disabledReason:
              notActive ??
              (slices.length && slices.every((s) => s.status === "done")
                ? null
                : "Every slice must be done before the mission review."),
          },
        ]}
      />
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
      <div className="flex items-end gap-3">
        <div className="w-72">
          <PlaybookPicker
            altitude="mission"
            value={mission.playbookId}
            onChange={async (playbookId) =>
              onGraph(
                await window.cowork.missionControl.missions.update(
                  mission.id,
                  { playbookId },
                  reasonFor(graph, "Change mission playbook")
                )
              )
            }
          />
        </div>
        <Button
          variant="ghost"
          className="ml-auto text-muted-foreground hover:text-destructive"
          onClick={() =>
            void removeMission().catch((error) =>
              toast.error(errorMessage(error))
            )
          }
        >
          <Trash2 className="size-4" /> Delete mission
        </Button>
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
                    <div
                      key={slice.id}
                      className={`relative rounded-lg border hover:bg-muted/50 ${result.criticalPath.includes(slice.id) ? "border-primary/60" : ""}`}
                    >
                      <button
                        className="block w-full p-3 text-left"
                        onClick={() => onOpenSlice(slice.id)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{slice.title}</span>
                          <Badge className="ml-auto" variant="outline">
                            {slice.status}
                          </Badge>
                        </div>
                        <code className="block truncate pr-8 text-xs text-muted-foreground">
                          {slice.key}
                        </code>
                        {edges.filter((edge) => edge.toSliceId === slice.id)
                          .length > 0 && (
                          <div className="mt-2 pr-8 text-xs text-muted-foreground">
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
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="absolute right-2 bottom-2 text-muted-foreground hover:text-destructive"
                        aria-label={`Delete slice ${slice.title}`}
                        onClick={() =>
                          void removeSlice(slice).catch((error) =>
                            toast.error(errorMessage(error))
                          )
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
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
          <div
            key={slice.id}
            className="flex items-center rounded-md border text-sm"
          >
            <button
              className="flex min-w-0 flex-1 items-center px-3 py-2 text-left"
              onClick={() => onOpenSlice(slice.id)}
            >
              <span className="truncate">{slice.title}</span>
              <span className="ml-auto shrink-0 pl-3 text-muted-foreground">
                Wave {(result.levels.get(slice.id) ?? 0) + 1}
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="mr-1 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={`Delete slice ${slice.title}`}
              onClick={() =>
                void removeSlice(slice).catch((error) =>
                  toast.error(errorMessage(error))
                )
              }
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
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
  // The latest mission whose slices are all done: the one a release covers.
  const finishedMission =
    [...graph.missions].reverse().find((mission) => {
      const slices = graph.slices.filter((s) => s.missionId === mission.id)
      return (
        mission.status === "completed" ||
        (slices.length > 0 && slices.every((s) => s.status === "done"))
      )
    }) ?? null
  const save = async () =>
    onGraph(
      await window.cowork.missionControl.initiatives.update(
        initiative.id,
        { name, intent, definitionOfDone: done },
        reasonFor(graph, "Update initiative definition")
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
      <div className="w-72">
        <PlaybookPicker
          altitude="initiative"
          value={initiative.playbookId}
          onChange={async (playbookId) =>
            onGraph(
              await window.cowork.missionControl.initiatives.update(
                initiative.id,
                { playbookId },
                reasonFor(graph, "Change initiative playbook")
              )
            )
          }
        />
      </div>
      {initiative.status !== "draft" && (
        <HookControls
          graph={graph}
          title="Initiative playbook"
          actions={[
            {
              hook: "plan",
              label: "Run planning",
              disabledReason:
                initiative.status === "active"
                  ? null
                  : "Resume the initiative to run its playbooks.",
            },
            {
              hook: "between_missions",
              label: "Run release",
              missionId: finishedMission?.id ?? null,
              disabledReason:
                initiative.status !== "active"
                  ? "Resume the initiative to run its playbooks."
                  : finishedMission
                    ? null
                    : "A release runs after a mission's slices are all done.",
            },
          ]}
        />
      )}
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
              <div
                key={mission.id}
                className="flex items-center rounded-lg border hover:bg-muted/50"
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-3 p-4 text-left"
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
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="mr-3 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete mission ${mission.name}`}
                  onClick={() =>
                    void deleteMissionConfirmed(graph, mission)
                      .then((next) => next && onGraph(next))
                      .catch((error) => toast.error(errorMessage(error)))
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
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
  const initiativeId = graph?.initiative.id ?? null
  const refreshGraph = useCallback(async () => {
    if (!initiativeId) return
    const next =
      await window.cowork.missionControl.initiatives.get(initiativeId)
    if (next) onGraphChange(next)
  }, [initiativeId, onGraphChange])
  const mission = graph?.missions.find((item) => item.id === missionId) ?? null
  const slice = graph?.slices.find((item) => item.id === sliceId) ?? null
  if (graph && slice)
    return (
      <SliceEditor
        key={slice.id}
        graph={graph}
        slice={slice}
        workspacePath={
          workspaces.find((w) => w.id === graph.initiative.workspaceId)?.path ??
          ""
        }
        onSaved={(next) => {
          applyGraph(next)
          onSliceChange(null)
        }}
        onGraph={applyGraph}
        onDeleted={(next) => {
          applyGraph(next)
          onSliceChange(null)
        }}
        onRefresh={refreshGraph}
      />
    )
  if (graph && mission)
    return (
      <MissionView
        graph={graph}
        mission={mission}
        onGraph={applyGraph}
        onOpenSlice={onSliceChange}
        onDeleted={(next) => {
          applyGraph(next)
          onMissionChange(null)
        }}
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
                      if (
                        !window.confirm(
                          `Delete initiative “${item.name}” with all its missions and slices? This cannot be undone.`
                        )
                      )
                        return
                      void window.cowork.missionControl.initiatives
                        .delete(item.id)
                        .then(reload)
                        .catch((error) => toast.error(errorMessage(error)))
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
