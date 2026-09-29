import { useCallback, useEffect, useMemo, useState } from "react"
import { GeneratedFilesEditor } from "./generated-files-editor"
import { WorktreeSetupEditor } from "./worktree-setup-editor"
import {
  CircleDot,
  CircleHelp,
  FolderOpen,
  GitBranch,
  List,
  Plus,
  Trash2,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { deriveWaves } from "../../../../shared/mission-control/waves"
import {
  normalizeStory,
  type UserStoryNarrative,
} from "../../../../shared/mission-control/story"
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
import { Switch } from "@/components/ui/switch"
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
import { UserStoryRunPanel } from "./user-story-run-panel"
import { HookControls } from "./hook-controls"
import { PlaybookPicker } from "./playbook-picker"
import { AnchoredComms, CommsTab } from "./comms-tab"
import { HealthDot, HealthTab, useHealthAnchors } from "./health-tab"
import { MilestoneIntegrationPanel } from "./milestone-integration-panel"
import { NavigatorStrip, useNavigator } from "./navigator-strip"
import { DriveControls } from "./drive-controls"
import { PlanHistory, WaitingOnYou } from "./proposals-inbox"
import type {
  Feature,
  FeatureGraph,
  Milestone,
  Project,
  Rig,
  UserStorySpec,
  UserStory,
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
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^(?:SqliteError|Error):\s*/, "")
  // Raw database constraint text is meaningless to users; the repository
  // throws readable errors for the cases it anticipates.
  if (/UNIQUE constraint failed/.test(message))
    return "Something with that name already exists. Try a different name."
  if (/constraint failed/.test(message))
    return "That change conflicts with existing data and wasn't saved."
  return message
}
// Structural edits after start are audited and need a reason (plan 106.2).
function reasonFor(graph: FeatureGraph, reason: string) {
  return graph.feature.status === "draft" ? undefined : reason
}
// Shared by the detail views and the list rows. Resolves null when the user
// backs out of the confirmation.
async function deleteMilestoneConfirmed(
  graph: FeatureGraph,
  milestone: Milestone
): Promise<FeatureGraph | null> {
  const count = graph.userStories.filter(
    (s) => s.milestoneId === milestone.id
  ).length
  if (
    !window.confirm(
      `Delete milestone “${milestone.name}”${count ? ` and its ${count} ${count === 1 ? "user story" : "user stories"}` : ""}? This cannot be undone.`
    )
  )
    return null
  return window.cowork.missionControl.milestones.delete(
    milestone.id,
    reasonFor(graph, "Remove milestone")
  )
}
async function deleteUserStoryConfirmed(
  graph: FeatureGraph,
  userStory: UserStory
): Promise<FeatureGraph | null> {
  if (
    !window.confirm(
      `Delete user story “${userStory.title}”? This cannot be undone.`
    )
  )
    return null
  return window.cowork.missionControl.userStories.delete(
    userStory.id,
    reasonFor(graph, "Remove user story")
  )
}
function lines(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
}

function UserStoryEditor({
  graph,
  userStory,
  workspacePath,
  onSaved,
  onGraph,
  onDeleted,
  onRefresh,
}: {
  graph: FeatureGraph
  userStory: UserStory
  workspacePath: string
  onSaved: (graph: FeatureGraph) => void
  onGraph: (graph: FeatureGraph) => void
  onDeleted: (graph: FeatureGraph) => void
  onRefresh: () => Promise<void>
}) {
  // Once a user story has run, its spec is the proof's contract and only the
  // execution workflow may revise it (plan 106.2); other fields stay editable.
  const specFrozen = userStory.startedAt !== null
  const [title, setTitle] = useState(userStory.title)
  const [key, setKey] = useState(userStory.key)
  const [story, setStory] = useState<UserStoryNarrative>(
    userStory.spec.story ?? { asA: "", iWant: "", soThat: "" }
  )
  const [goal, setGoal] = useState(userStory.spec.goal)
  const [acceptance, setAcceptance] = useState(
    userStory.spec.acceptance.length > 0 ? userStory.spec.acceptance : [""]
  )
  const [outOfScope, setOutOfScope] = useState(
    userStory.spec.outOfScope.join("\n")
  )
  const [touchHints, setTouchHints] = useState(
    userStory.spec.touchHints.length > 0 ? userStory.spec.touchHints : [""]
  )
  const [notes, setNotes] = useState(userStory.spec.notes)
  const [runsLast, setRunsLast] = useState(userStory.spec.runsLast)
  const [podKey, setPodKey] = useState(userStory.podKey ?? "default")
  const pods = graph.feature.rigSnapshot?.pods ?? []
  const save = async () => {
    const spec: UserStorySpec = {
      story: normalizeStory(story),
      goal,
      acceptance: acceptance.map((item) => item.trim()).filter(Boolean),
      outOfScope: lines(outOfScope),
      touchHints: touchHints.map((item) => item.trim()).filter(Boolean),
      notes,
      runsLast,
    }
    onSaved(
      await window.cowork.missionControl.userStories.update(
        userStory.id,
        {
          title: title.trim(),
          key: slug(key),
          ...(specFrozen ? {} : { spec }),
          podKey: podKey === "default" ? null : podKey,
        },
        reasonFor(graph, "Refine user story spec")
      )
    )
  }
  const remove = async () => {
    const next = await deleteUserStoryConfirmed(graph, userStory)
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
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Label>Story (optional)</Label>
          <TooltipButton
            tooltip="Who benefits and why. Leave it empty for technical work such as a migration or refactor."
            type="button"
            className="text-muted-foreground hover:text-foreground"
            aria-label="About the story"
          >
            <CircleHelp className="size-3.5" />
          </TooltipButton>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          {(
            [
              ["asA", "As a", "billing admin"],
              ["iWant", "I want", "to export invoices as PDF"],
              ["soThat", "so that", "I can send them to clients"],
            ] as const
          ).map(([field, label, example]) => (
            <div key={field} className="space-y-1">
              <span className="text-xs text-muted-foreground">{label}</span>
              <Input
                value={story[field]}
                onChange={(e) =>
                  setStory({ ...story, [field]: e.target.value })
                }
                placeholder={example}
                aria-label={`Story: ${label}`}
              />
            </div>
          ))}
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
                  placeholder="Given …, when …, then … (or any checkable result)"
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
              <SelectItem value="default">Feature default</SelectItem>
              {pods.map((pod) => (
                <SelectItem key={pod.key} value={pod.key}>
                  {pod.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label
          className="flex items-start gap-2 text-sm sm:col-span-2"
          title="For an integration proof or docs: it waits for every other user story in the milestone, including ones added later. Nothing can depend on it."
        >
          <Switch
            size="sm"
            className="mt-0.5"
            checked={runsLast}
            disabled={specFrozen}
            onCheckedChange={setRunsLast}
          />
          <span>
            Runs last
            <span className="block text-xs text-muted-foreground">
              Waits for every other user story in this milestone, including ones
              added later.
            </span>
          </span>
        </label>
        <PlaybookPicker
          altitude="user_story"
          value={userStory.playbookId}
          onChange={async (playbookId) =>
            onGraph(
              await window.cowork.missionControl.userStories.update(
                userStory.id,
                { playbookId },
                reasonFor(graph, "Change user story playbook")
              )
            )
          }
        />
      </div>
      {specFrozen && (
        <p className="text-xs text-muted-foreground">
          This user story has run, so its spec is frozen as the proof's
          contract. Title, key, pod, and playbook can still change.
        </p>
      )}
      <UserStoryRunPanel
        graph={graph}
        userStory={userStory}
        workspacePath={workspacePath}
        onRefresh={onRefresh}
      />
      <AnchoredComms
        graph={graph}
        anchor={{ kind: "user_story", id: userStory.id }}
      />
      <div className="flex gap-2">
        <Button
          onClick={() =>
            void save().catch((error) => toast.error(errorMessage(error)))
          }
        >
          Save user story
        </Button>
        <Button
          variant="ghost"
          className="ml-auto text-muted-foreground hover:text-destructive"
          onClick={() =>
            void remove().catch((error) => toast.error(errorMessage(error)))
          }
        >
          <Trash2 className="size-4" /> Delete user story
        </Button>
      </div>
      {graph.revisions.filter((revision) => revision.targetId === userStory.id)
        .length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Revision history</h3>
          {graph.revisions
            .filter((revision) => revision.targetId === userStory.id)
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

function MilestoneView({
  graph,
  milestone,
  onGraph,
  onOpenUserStory,
  onDeleted,
  onRefresh,
}: {
  graph: FeatureGraph
  milestone: Milestone
  onGraph: (graph: FeatureGraph) => void
  onOpenUserStory: (id: string) => void
  onDeleted: (graph: FeatureGraph) => void
  onRefresh: () => Promise<void>
}) {
  const userStories = graph.userStories.filter(
    (userStory) => userStory.milestoneId === milestone.id
  )
  const edges = graph.edges.filter((edge) => edge.milestoneId === milestone.id)
  const result = deriveWaves(userStories, edges)
  const health = useHealthAnchors(graph.feature.id)
  const [milestoneName, setMilestoneName] = useState(milestone.name)
  const [outcome, setOutcome] = useState(milestone.outcome)
  const [definitionOfDone, setDefinitionOfDone] = useState(
    milestone.definitionOfDone
  )
  const [newTitle, setNewTitle] = useState("")
  const [dependencyTarget, setDependencyTarget] = useState("")
  const [dependencySource, setDependencySource] = useState("")
  const saveMilestone = async () =>
    onGraph(
      await window.cowork.missionControl.milestones.update(
        milestone.id,
        { name: milestoneName, outcome, definitionOfDone },
        reasonFor(graph, "Refine milestone outcome")
      )
    )
  const removeMilestone = async () => {
    const next = await deleteMilestoneConfirmed(graph, milestone)
    if (next) onDeleted(next)
  }
  const removeUserStory = async (userStory: UserStory) => {
    const next = await deleteUserStoryConfirmed(graph, userStory)
    if (next) onGraph(next)
  }
  const addUserStory = async () => {
    const next = await window.cowork.missionControl.userStories.create({
      milestoneId: milestone.id,
      key: slug(newTitle),
      title: newTitle,
    })
    setNewTitle("")
    onGraph(next)
  }
  const addDependency = async () => {
    if (!dependencySource || !dependencyTarget) return
    const next = await window.cowork.missionControl.userStoryEdges.set(
      milestone.id,
      [
        ...edges.map((edge) => ({
          fromUserStoryId: edge.fromUserStoryId,
          toUserStoryId: edge.toUserStoryId,
        })),
        { fromUserStoryId: dependencySource, toUserStoryId: dependencyTarget },
      ],
      graph.feature.status === "draft" ? undefined : "Update dependency plan"
    )
    setDependencySource("")
    setDependencyTarget("")
    onGraph(next)
  }
  const notActive =
    graph.feature.status === "active"
      ? null
      : "Start the feature before running its playbooks."
  const navigator = useNavigator(graph.feature.id)
  return (
    <div className="space-y-5">
      {graph.feature.status !== "draft" && (
        <NavigatorStrip state={navigator} milestoneId={milestone.id} />
      )}
      <HookControls
        graph={graph}
        title="Milestone playbook"
        actions={[
          {
            hook: "before_user_stories",
            label: "Run planning",
            milestoneId: milestone.id,
            disabledReason:
              notActive ??
              (userStories.length ? null : "Add user stories to review first."),
          },
          {
            hook: "after_all_user_stories",
            label: "Run review",
            milestoneId: milestone.id,
            disabledReason:
              notActive ??
              (userStories.some((s) => s.status === "done") &&
              userStories.every(
                (s) => s.status === "done" || s.status === "cancelled"
              )
                ? null
                : "Every user story must be done before the milestone review."),
          },
        ]}
      />
      {milestone.dodReview && (
        <div className="rounded-md border p-3 text-sm">
          <span className="text-muted-foreground">
            Definition of done judged met by{" "}
            <code>{milestone.dodReview.by}</code>:
          </span>{" "}
          {milestone.dodReview.summary}
        </div>
      )}
      <MilestoneIntegrationPanel
        graph={graph}
        milestone={milestone}
        onGraph={onGraph}
        onRefresh={onRefresh}
      />
      <AnchoredComms
        graph={graph}
        anchor={{ kind: "milestone", id: milestone.id }}
      />
      <div className="grid gap-3 rounded-lg border p-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Milestone name</Label>
            <Input
              value={milestoneName}
              onChange={(e) => setMilestoneName(e.target.value)}
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
            disabled={!milestoneName.trim()}
            onClick={() =>
              void saveMilestone().catch((error) =>
                toast.error(errorMessage(error))
              )
            }
          >
            Save milestone
          </Button>
        </div>
      </div>
      <div className="flex items-end gap-3">
        <div className="w-72">
          <PlaybookPicker
            altitude="milestone"
            value={milestone.playbookId}
            onChange={async (playbookId) =>
              onGraph(
                await window.cowork.missionControl.milestones.update(
                  milestone.id,
                  { playbookId },
                  reasonFor(graph, "Change milestone playbook")
                )
              )
            }
          />
        </div>
        <Button
          variant="ghost"
          className="ml-auto text-muted-foreground hover:text-destructive"
          onClick={() =>
            void removeMilestone().catch((error) =>
              toast.error(errorMessage(error))
            )
          }
        >
          <Trash2 className="size-4" /> Delete milestone
        </Button>
      </div>
      <div className="flex gap-2">
        <Input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="New user story title"
        />
        <Button
          disabled={
            !slug(newTitle) ||
            ["completed", "cancelled"].includes(graph.feature.status)
          }
          title={
            graph.feature.status === "completed"
              ? "Reopen the feature to add work."
              : undefined
          }
          onClick={() =>
            void addUserStory().catch((error) =>
              toast.error(errorMessage(error))
            )
          }
        >
          <Plus className="size-4" /> Add user story
        </Button>
      </div>
      {userStories.length === 0 ? (
        <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          Add user stories to build this milestone's work map.
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
                  {wave.map((userStory) => (
                    <div
                      key={userStory.id}
                      className={`relative rounded-lg border hover:bg-muted/50 ${result.criticalPath.includes(userStory.id) ? "border-primary/60" : ""}`}
                    >
                      <button
                        className="block w-full p-3 text-left"
                        onClick={() => onOpenUserStory(userStory.id)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{userStory.title}</span>
                          {userStory.origin === "agent" && (
                            <Badge
                              variant="secondary"
                              title="Added by a seat through the plan tools"
                            >
                              agent
                            </Badge>
                          )}
                          <HealthDot
                            className="ml-auto"
                            severity={health[userStory.id]}
                          />
                          <Badge
                            className={health[userStory.id] ? "" : "ml-auto"}
                            variant="outline"
                          >
                            {userStory.status}
                          </Badge>
                        </div>
                        <code className="block truncate pr-8 text-xs text-muted-foreground">
                          {userStory.key}
                        </code>
                        {edges.filter(
                          (edge) => edge.toUserStoryId === userStory.id
                        ).length > 0 && (
                          <div className="mt-2 pr-8 text-xs text-muted-foreground">
                            Depends on{" "}
                            {edges
                              .filter(
                                (edge) => edge.toUserStoryId === userStory.id
                              )
                              .map(
                                (edge) =>
                                  userStories.find(
                                    (item) => item.id === edge.fromUserStoryId
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
                        aria-label={`Delete user story ${userStory.title}`}
                        onClick={() =>
                          void removeUserStory(userStory).catch((error) =>
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
      {userStories.length > 1 && (
        <div className="flex gap-2 rounded-lg border p-3">
          <Select
            value={dependencyTarget}
            onValueChange={(value) => {
              setDependencyTarget(value)
              setDependencySource("")
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="User story" />
            </SelectTrigger>
            <SelectContent>
              {userStories.map((userStory) => (
                <SelectItem key={userStory.id} value={userStory.id}>
                  {userStory.title}
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
              {userStories
                .filter(
                  (userStory) =>
                    userStory.id !== dependencyTarget &&
                    !edges.some(
                      (edge) =>
                        edge.toUserStoryId === dependencyTarget &&
                        edge.fromUserStoryId === userStory.id
                    )
                )
                .map((userStory) => (
                  <SelectItem key={userStory.id} value={userStory.id}>
                    {userStory.title}
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
        {userStories.map((userStory) => (
          <div
            key={userStory.id}
            className="flex items-center rounded-md border text-sm"
          >
            <button
              className="flex min-w-0 flex-1 items-center px-3 py-2 text-left"
              onClick={() => onOpenUserStory(userStory.id)}
            >
              <span className="truncate">{userStory.title}</span>
              {userStory.origin === "agent" && (
                <Badge variant="secondary" className="ml-2 shrink-0">
                  agent
                </Badge>
              )}
              <HealthDot className="ml-2" severity={health[userStory.id]} />
              <span className="ml-auto shrink-0 pl-3 text-muted-foreground">
                Wave {(result.levels.get(userStory.id) ?? 0) + 1}
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="mr-1 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label={`Delete user story ${userStory.title}`}
              onClick={() =>
                void removeUserStory(userStory).catch((error) =>
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

function FeatureView({
  graph,
  rigs,
  workspaces,
  projects,
  onGraph,
  onPickWorkspace,
  onWorkspaceSaved,
  onMilestone,
  onOpenAnchor,
}: {
  graph: FeatureGraph
  rigs: Rig[]
  workspaces: Workspace[]
  projects: Project[]
  onGraph: (graph: FeatureGraph) => void
  onPickWorkspace: () => Promise<Workspace | null>
  onWorkspaceSaved: (workspace: Workspace) => void
  onMilestone: (id: string) => void
  onOpenAnchor: (anchor: {
    kind: "user_story" | "milestone"
    id: string
  }) => void
}) {
  const feature = graph.feature
  const navigator = useNavigator(feature.id)
  const health = useHealthAnchors(feature.id)
  const [view, setView] = useState<"overview" | "comms" | "health">("overview")
  // Bumped to open the budget editor from the inbox.
  const [budgetRequest, setBudgetRequest] = useState(0)
  const [name, setName] = useState(feature.name)
  const [intent, setIntent] = useState(feature.intent)
  const [done, setDone] = useState(feature.definitionOfDone)
  const [milestoneName, setMilestoneName] = useState("")
  // The latest milestone whose user stories are all done: the one a release covers.
  const finishedMilestone =
    [...graph.milestones].reverse().find((milestone) => {
      const userStories = graph.userStories.filter(
        (s) => s.milestoneId === milestone.id
      )
      return (
        milestone.status === "completed" ||
        (userStories.length > 0 &&
          userStories.every((s) => s.status === "done"))
      )
    }) ?? null
  const save = async () =>
    onGraph(
      await window.cowork.missionControl.features.update(
        feature.id,
        { name, intent, definitionOfDone: done },
        reasonFor(graph, "Update feature definition")
      )
    )
  // Rig and workspace are bound for good at start (the repository enforces
  // this too). The project is just a label, so it's editable in any status.
  const editableBinding = feature.status === "draft"
  const finished = ["completed", "cancelled", "failed"].includes(feature.status)
  const bind = (
    patch: Partial<Pick<Feature, "rigId" | "projectId" | "workspaceId">>
  ) =>
    window.cowork.missionControl.features
      .update(feature.id, patch)
      .then(onGraph)
      .catch((error) => toast.error(errorMessage(error)))
  const featureWorkspace =
    workspaces.find((workspace) => workspace.id === feature.workspaceId) ?? null
  const workspaceName = featureWorkspace?.name ?? "None"
  const addMilestone = async () => {
    const next = await window.cowork.missionControl.milestones.create({
      featureId: feature.id,
      key: slug(milestoneName),
      name: milestoneName,
      outcome: "",
    })
    setMilestoneName("")
    onGraph(next)
  }
  const viewTabs = (
    <div className="flex gap-4 border-b">
      {(["overview", "comms", "health"] as const).map((item) => (
        <button
          key={item}
          className={`-mb-px py-2 text-sm font-medium ${view === item ? "border-b-2 border-primary" : "text-muted-foreground"}`}
          onClick={() => setView(item)}
        >
          {item === "overview"
            ? "Overview"
            : item === "comms"
              ? "Comms"
              : "Health"}
        </button>
      ))}
    </div>
  )
  if (view === "comms")
    return (
      <div className="space-y-5">
        {viewTabs}
        <CommsTab graph={graph} onOpenAnchor={onOpenAnchor} />
      </div>
    )
  if (view === "health")
    return (
      <div className="space-y-5">
        {viewTabs}
        <HealthTab
          graph={graph}
          onGraph={onGraph}
          onOpenAnchor={onOpenAnchor}
          onOpenComms={() => setView("comms")}
        />
      </div>
    )
  return (
    <div className="space-y-5">
      {viewTabs}
      <DriveControls
        key={`${feature.id}:${feature.status}`}
        graph={graph}
        position={navigator.position}
        onGraph={onGraph}
        budgetRequest={budgetRequest}
        onShowWaiting={() =>
          document
            .getElementById("mission-control-waiting")
            ?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
      />
      {feature.status !== "draft" && <NavigatorStrip state={navigator} />}
      {feature.status !== "draft" && (
        <WaitingOnYou
          graph={graph}
          position={navigator.position}
          onGraph={onGraph}
          navigation={{
            openMilestone: onMilestone,
            openUserStory: (id) => onOpenAnchor({ kind: "user_story", id }),
            openComms: () => setView("comms"),
            editBudgets: () => setBudgetRequest((n) => n + 1),
          }}
        />
      )}
      {graph.rigDrifted && !finished && (
        <div className="flex items-center rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <span>The selected rig changed since this feature started.</span>
          <Button
            className="ml-auto"
            size="sm"
            variant="outline"
            onClick={() =>
              void window.cowork.missionControl.features
                .reseat(feature.id, "Apply latest rig definition")
                .then(onGraph)
                .catch((error) => toast.error(errorMessage(error)))
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
        <div className="min-w-0">
          <div className="mb-1 text-xs text-muted-foreground">Rig</div>
          {editableBinding ? (
            <Select
              value={feature.rigId ?? ""}
              onValueChange={(rigId) => void bind({ rigId })}
            >
              <SelectTrigger className="h-8 w-full text-foreground [&>svg]:text-foreground">
                <SelectValue placeholder="Choose a rig" />
              </SelectTrigger>
              <SelectContent>
                {rigs.map((rig) => (
                  <SelectItem key={rig.id} value={rig.id}>
                    {rig.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-sm">
                {rigs.find((rig) => rig.id === feature.rigId)?.name ??
                  (feature.rigSnapshot
                    ? `${feature.rigSnapshot.rig.name} (deleted — ran on saved copy)`
                    : "None")}
              </div>
              {feature.rigId && (
                <PendingLessonsBadge rigId={feature.rigId} graph={graph} />
              )}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-xs text-muted-foreground">Project</div>
          <Select
            value={feature.projectId ?? "none"}
            onValueChange={(value) => {
              const project = projects.find((item) => item.id === value)
              // While draft, a linked project brings its workspace, as on
              // create; once started the workspace is locked, so only relabel.
              void bind(
                project
                  ? editableBinding
                    ? {
                        projectId: project.id,
                        workspaceId: project.workspaceId,
                      }
                    : { projectId: project.id }
                  : { projectId: null }
              )
            }}
          >
            <SelectTrigger className="h-8 w-full text-foreground [&>svg]:text-foreground">
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
        <div className="min-w-0">
          <div className="mb-1 text-xs text-muted-foreground">Workspace</div>
          {editableBinding && !feature.projectId ? (
            <div className="flex gap-2">
              <Select
                value={feature.workspaceId ?? ""}
                onValueChange={(workspaceId) => void bind({ workspaceId })}
              >
                <SelectTrigger className="h-8 min-w-0 flex-1 text-foreground [&>svg]:text-foreground">
                  <SelectValue placeholder="Choose a workspace" />
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
                size="icon-sm"
                variant="outline"
                title="Choose folder"
                onClick={() =>
                  void onPickWorkspace()
                    .then((workspace) =>
                      workspace ? bind({ workspaceId: workspace.id }) : null
                    )
                    .catch((error) => toast.error(errorMessage(error)))
                }
              >
                <FolderOpen className="size-4" />
              </Button>
            </div>
          ) : (
            <div className="truncate text-sm">{workspaceName}</div>
          )}
        </div>
        {editableBinding ? (
          <p className="text-xs text-muted-foreground sm:col-span-3">
            The rig and workspace lock when the feature starts.
          </p>
        ) : null}
        {featureWorkspace && (
          <div className="sm:col-span-3">
            <GeneratedFilesEditor
              workspace={featureWorkspace}
              onSaved={onWorkspaceSaved}
            />
            <div className="mt-4">
              <WorktreeSetupEditor
                workspace={featureWorkspace}
                onSaved={onWorkspaceSaved}
              />
            </div>
          </div>
        )}
      </div>
      <div className="w-72">
        <PlaybookPicker
          altitude="feature"
          value={feature.playbookId}
          onChange={async (playbookId) =>
            onGraph(
              await window.cowork.missionControl.features.update(
                feature.id,
                { playbookId },
                reasonFor(graph, "Change feature playbook")
              )
            )
          }
        />
      </div>
      {feature.status !== "draft" && (
        <HookControls
          graph={graph}
          title="Feature playbook"
          actions={[
            {
              hook: "plan",
              label: "Run planning",
              disabledReason:
                feature.status === "active"
                  ? null
                  : "Resume the feature to run its playbooks.",
            },
            {
              hook: "between_milestones",
              label: "Run release",
              milestoneId: finishedMilestone?.id ?? null,
              disabledReason:
                feature.status !== "active"
                  ? "Resume the feature to run its playbooks."
                  : finishedMilestone
                    ? null
                    : "A release runs after a milestone's user stories are all done.",
            },
          ]}
        />
      )}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="font-medium">Milestones</h3>
            <p className="text-sm text-muted-foreground">
              Milestones run in this order.
            </p>
          </div>
          {finished ? (
            <span className="text-xs text-muted-foreground">
              {feature.status === "completed"
                ? "Reopen the feature to add milestones."
                : "This feature is closed."}
            </span>
          ) : (
            <div className="flex gap-2">
              <Input
                value={milestoneName}
                onChange={(e) => setMilestoneName(e.target.value)}
                placeholder="Milestone name"
              />
              <Button
                disabled={!slug(milestoneName)}
                onClick={() =>
                  void addMilestone().catch((error) =>
                    toast.error(errorMessage(error))
                  )
                }
              >
                <Plus className="size-4" />
              </Button>
            </div>
          )}
        </div>
        <div className="space-y-2">
          {graph.milestones.map((milestone, index) => {
            const userStories = graph.userStories.filter(
              (userStory) => userStory.milestoneId === milestone.id
            )
            return (
              <div
                key={milestone.id}
                className="flex items-center rounded-lg border hover:bg-muted/50"
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-3 p-4 text-left"
                  onClick={() => onMilestone(milestone.id)}
                >
                  <CircleDot
                    className={`size-4 ${milestone.status === "completed" ? "text-emerald-500" : milestone.status === "active" ? "text-primary" : "text-muted-foreground"}`}
                  />
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      {index + 1}. {milestone.name}
                      <HealthDot severity={health[milestone.id]} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {milestone.outcome || "Add an outcome"}
                    </div>
                  </div>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {
                      userStories.filter(
                        (userStory) => userStory.status === "done"
                      ).length
                    }
                    /{userStories.length} userStories
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="mr-3 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Delete milestone ${milestone.name}`}
                  onClick={() =>
                    void deleteMilestoneConfirmed(graph, milestone)
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
      <PlanHistory graph={graph} />
    </div>
  )
}

export function FeaturesTab({
  rigs,
  graph,
  milestoneId,
  userStoryId,
  onGraphChange,
  onMilestoneChange,
  onUserStoryChange,
}: {
  rigs: Rig[]
  graph: FeatureGraph | null
  milestoneId: string | null
  userStoryId: string | null
  onGraphChange: (graph: FeatureGraph | null) => void
  onMilestoneChange: (id: string | null) => void
  onUserStoryChange: (id: string | null) => void
}) {
  const [items, setItems] = useState<Feature[]>([])
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
      window.cowork.missionControl.features.list(),
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
  // The list shows each feature's status, which the Navigator and merge queue
  // change in the background: refetch the features (not workspaces/projects)
  // on their events so a finished feature doesn't read "active" until a remount.
  useEffect(() => {
    // One fetch at a time; an event during a fetch queues one more, so the
    // last change (e.g. the feature completing) is never dropped.
    let inFlight = false
    let again = false
    const refreshList = () => {
      if (inFlight) {
        again = true
        return
      }
      inFlight = true
      void window.cowork.missionControl.features
        .list()
        .then(setItems)
        .catch(() => {})
        .finally(() => {
          inFlight = false
          if (again) {
            again = false
            refreshList()
          }
        })
    }
    const offIntegration =
      window.cowork.missionControl.integration.onChanged(refreshList)
    const offNavigator =
      window.cowork.missionControl.navigator.onChanged(refreshList)
    return () => {
      offIntegration()
      offNavigator()
    }
  }, [])
  const applyGraph = (next: FeatureGraph) => {
    onGraphChange(next)
    void reload()
  }
  const linkedProject =
    projectId === "none"
      ? null
      : (projects.find((project) => project.id === projectId) ?? null)
  const canCreate = Boolean(
    slug(name) && intent.trim() && rigId && (linkedProject?.workspaceId || workspaceId)
  )
  const create = async () => {
    const next = await window.cowork.missionControl.features.create({
      key: slug(name),
      name,
      intent,
      definitionOfDone: done,
      rigId: rigId || null,
      projectId: linkedProject?.id ?? null,
      workspaceId: linkedProject?.workspaceId ?? (workspaceId || null),
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
  const saveWorkspace = async () => {
    const picked = await window.cowork.pickWorkspace()
    if (!picked.path) return null
    const workspace = await window.cowork.db.workspaces.upsert(picked.path)
    setWorkspaces((current) => [
      workspace,
      ...current.filter((item) => item.id !== workspace.id),
    ])
    return workspace
  }
  const pickWorkspace = async () => {
    const workspace = await saveWorkspace()
    if (workspace) setWorkspaceId(workspace.id)
  }
  const featureId = graph?.feature.id ?? null
  const refreshGraph = useCallback(async () => {
    if (!featureId) return
    const next = await window.cowork.missionControl.features.get(featureId)
    if (next) onGraphChange(next)
  }, [featureId, onGraphChange])
  // Merges land in the background (plan 106.5) and the Navigator drives
  // work on its own (106.6): keep user story and milestone statuses current while
  // the feature is open.
  useEffect(() => {
    if (!featureId) return
    const refresh = (changed: string) => {
      if (changed === featureId) void refreshGraph()
    }
    const offIntegration =
      window.cowork.missionControl.integration.onChanged(refresh)
    const offNavigator =
      window.cowork.missionControl.navigator.onChanged(refresh)
    return () => {
      offIntegration()
      offNavigator()
    }
  }, [featureId, refreshGraph])
  const milestone =
    graph?.milestones.find((item) => item.id === milestoneId) ?? null
  const userStory =
    graph?.userStories.find((item) => item.id === userStoryId) ?? null
  if (graph && userStory)
    return (
      <UserStoryEditor
        key={userStory.id}
        graph={graph}
        userStory={userStory}
        workspacePath={
          workspaces.find((w) => w.id === graph.feature.workspaceId)?.path ?? ""
        }
        onSaved={(next) => {
          applyGraph(next)
          onUserStoryChange(null)
        }}
        onGraph={applyGraph}
        onDeleted={(next) => {
          applyGraph(next)
          onUserStoryChange(null)
        }}
        onRefresh={refreshGraph}
      />
    )
  if (graph && milestone)
    return (
      <MilestoneView
        graph={graph}
        milestone={milestone}
        onGraph={applyGraph}
        onOpenUserStory={onUserStoryChange}
        onDeleted={(next) => {
          applyGraph(next)
          onMilestoneChange(null)
        }}
        onRefresh={refreshGraph}
      />
    )
  if (graph)
    return (
      <FeatureView
        graph={graph}
        rigs={rigs}
        workspaces={workspaces}
        projects={projects}
        onGraph={applyGraph}
        onPickWorkspace={saveWorkspace}
        onWorkspaceSaved={(saved) =>
          setWorkspaces((current) =>
            current.map((item) => (item.id === saved.id ? saved : item))
          )
        }
        onMilestone={onMilestoneChange}
        onOpenAnchor={(anchor) => {
          if (anchor.kind === "milestone") {
            onMilestoneChange(anchor.id)
            return
          }
          const target = graph.userStories.find((item) => item.id === anchor.id)
          if (!target) return
          onMilestoneChange(target.milestoneId)
          onUserStoryChange(target.id)
        }}
      />
    )
  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Features</h2>
          <p className="text-sm text-muted-foreground">
            Write the work map your rig will drive.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" /> New feature
        </Button>
      </div>
      {items.length === 0 ? (
        <div className="grid place-items-center rounded-xl border border-dashed py-16 text-center">
          <GitBranch className="mb-3 size-9 text-muted-foreground" />
          <h3 className="font-medium">Map your first feature</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Define intent, milestones, user stories, and their dependency waves.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <Card
              key={item.id}
              className="cursor-pointer hover:bg-muted/30"
              onClick={() =>
                void window.cowork.missionControl.features
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
                          `Delete feature “${item.name}” with all its milestones and user stories? This cannot be undone.`
                        )
                      )
                        return
                      void window.cowork.missionControl.features
                        .delete(item.id)
                        .then((result) => {
                          // Unmerged integration work is never deleted silently.
                          if (result?.keptBranches.length)
                            toast.info(
                              `Kept ${result.keptBranches.join(", ")}: it has merged work that never reached its base branch. Delete it yourself when you no longer need it.`
                            )
                          return reload()
                        })
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
            <DialogTitle>New feature</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label>
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Billing v1"
              />
            </div>
            <div className="space-y-1">
              <Label>
                Intent <span className="text-destructive">*</span>
              </Label>
              <Textarea
                className="field-sizing-fixed overflow-y-auto"
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                rows={10}
              />
            </div>
            <div className="space-y-1">
              <Label>Definition of done</Label>
              <Textarea
                className="field-sizing-fixed overflow-y-auto"
                value={done}
                onChange={(e) => setDone(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-1">
              <Label>
                Rig <span className="text-destructive">*</span>
              </Label>
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
                <Label>
                  Workspace <span className="text-destructive">*</span>
                </Label>
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
              disabled={!canCreate}
              onClick={() =>
                void create().catch((error) => toast.error(errorMessage(error)))
              }
            >
              Create feature
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Lessons the rig's seats learned that wait for review (plan 106.7). They're
// reviewed on each seat's Memory tab in the rig editor.
function PendingLessonsBadge({
  rigId,
  graph,
}: {
  rigId: string
  // Refetched whenever the feature's work changes (a turn may have ended).
  graph: FeatureGraph
}) {
  const [pending, setPending] = useState(0)
  useEffect(() => {
    let live = true
    void window.cowork.missionControl.seatMemory
      .pendingCount(rigId)
      .then((count) => live && setPending(count))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [rigId, graph])
  if (!pending) return null
  return (
    <Badge
      variant="outline"
      className="shrink-0"
      title="Review them on each seat's Memory tab: Rigs → this rig → edit the seat."
    >
      Pending lessons ({pending})
    </Badge>
  )
}
