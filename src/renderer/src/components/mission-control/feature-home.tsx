import { useEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  CircleDashed,
  Loader2,
  OctagonAlert,
  Pause,
  Play,
  RotateCcw,
  Rocket,
  Search,
  Square,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { FeatureGraph, Position, Workspace } from "@/types"
import type { WaitingItems } from "./proposals-inbox"
import {
  ApplyAllDialog,
  readinessLine,
  WorkspaceChecklist,
  type WorkspaceAnalysisState,
} from "./workspace-checklist"

// The Feature home (plan 106.11): what we're building, what's happening now,
// and what, if anything, the user needs to do next. A draft's one primary
// action is Start; Start checks the project first and stops only for real
// blockers. Everything technical lives below, collapsed.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

const MODE_TEXT: Record<string, string> = {
  manual: "You run each step",
  copilot: "The lead seat drives, you watch",
  autopilot: "Autopilot",
}

function ReadinessIcon({
  readiness,
}: {
  readiness: ReturnType<typeof readinessLine>["readiness"]
}) {
  switch (readiness) {
    case "checking":
      return <Loader2 className="size-5 animate-spin text-muted-foreground" />
    case "ready":
      return <CheckCircle2 className="size-5 text-emerald-500" />
    case "recommendations":
      return <AlertTriangle className="size-5 text-amber-500" />
    case "needs-input":
      return <OctagonAlert className="size-5 text-destructive" />
    case "failed":
      return <XCircle className="size-5 text-destructive" />
    default:
      return <CircleDashed className="size-5 text-muted-foreground" />
  }
}

function WaitingSummary({
  waiting,
  onShowWaiting,
}: {
  waiting: WaitingItems
  onShowWaiting: () => void
}) {
  const top = waiting.top
  if (!top) return null
  const text =
    top.kind === "decision"
      ? top.decision.summary
      : top.kind === "proposal"
        ? `${top.proposal.proposer} proposes ${top.proposal.kind === "followup" ? "a follow-up" : "a plan change"}${top.proposal.reason ? `: ${top.proposal.reason}` : ""}`
        : `Escalation from ${top.message.fromAddress}: ${top.message.body}`
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <Bell className="mt-0.5 size-4 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Your input is needed</div>
        <p className="line-clamp-2 text-muted-foreground">{text}</p>
        {waiting.count > 1 && (
          <p className="text-xs text-muted-foreground">
            and {waiting.count - 1} more waiting on you
          </p>
        )}
      </div>
      <Button size="sm" onClick={onShowWaiting}>
        {waiting.count > 1 ? `Resolve (${waiting.count})` : "Resolve"}
      </Button>
    </div>
  )
}

export function FeatureHome({
  graph,
  position,
  workspace,
  analysis,
  waiting,
  onGraph,
  onShowWaiting,
  onEditDetails,
  onReviewSetup,
}: {
  graph: FeatureGraph
  position: Position | null
  workspace: Workspace | null
  analysis: WorkspaceAnalysisState
  waiting: WaitingItems
  onGraph: (graph: FeatureGraph) => void
  onShowWaiting: () => void
  onEditDetails: () => void
  onReviewSetup: () => void
}) {
  const feature = graph.feature
  const [pending, setPending] = useState(false)
  // Start stopped on blockers: resume from preflight once they're resolved.
  const [blocked, setBlocked] = useState(false)
  const checklistRef = useRef<HTMLDivElement | null>(null)
  const drive = window.cowork.missionControl.drive
  const draft = feature.status === "draft"
  const line = readinessLine(analysis.analysis)
  useEffect(() => setBlocked(false), [feature.id, feature.workspaceId])

  const act = async (work: () => Promise<FeatureGraph>) => {
    setPending(true)
    try {
      onGraph(await work())
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }
  // Start paused for a setup review: the finding keys to show.
  const [review, setReview] = useState<string[] | null>(null)
  // "Apply and start" is running commands: start when this run finishes.
  const [startAfterRun, setStartAfterRun] = useState<string | null>(null)
  const start = (
    options: { skipPreflight?: boolean; reviewed?: boolean } = {}
  ) =>
    act(async () => {
      const result = await drive.start(feature.id, {
        mode: feature.driveMode,
        autoApplyPlan: feature.drive.autoApplyPlan,
        skipPreflight: options.skipPreflight === true,
        reviewed: options.reviewed === true,
      })
      if (result.preflight?.applied.length)
        toast.success(
          `Set up automatically: ${result.preflight.applied.join("; ")}`
        )
      if (result.preflight?.blocked) {
        setBlocked(true)
        toast.warning(
          "Your input is needed before this feature can start. See the checklist below."
        )
        window.setTimeout(
          () =>
            checklistRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            }),
          50
        )
      } else if (result.preflight?.review.length) {
        setBlocked(false)
        setReview(result.preflight.review)
      } else {
        setBlocked(false)
        if (result.planningError)
          toast.warning(
            `Started, but planning couldn't run: ${result.planningError}`
          )
      }
      return result.graph
    })
  const startAnyway = () => {
    if (
      window.confirm(
        "Start without fixing the open blockers? Agents may not be able to run the project or its checks."
      )
    )
      void start({ skipPreflight: true })
  }
  // Apply and start: once the setup run ends, start — or say why not.
  const run = analysis.run
  useEffect(() => {
    if (!startAfterRun || run?.id !== startAfterRun || run.status === "running")
      return
    setStartAfterRun(null)
    if (run.status === "succeeded") void start({ reviewed: true })
    else
      toast.error(
        "Setup stopped before finishing, so the feature didn't start. Fix it in the checklist below, then Start again."
      )
    // start is recreated each render; the run is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, startAfterRun])

  const storyCount = graph.userStories.length
  const done = graph.userStories.filter((s) => s.status === "done").length
  const activeMilestone = graph.milestones.find(
    (m) => m.id === position?.feature.activeMilestoneId
  )
  const checking = line.readiness === "checking"
  const showChecklist =
    draft && !!workspace && (!!analysis.analysis || blocked || !!analysis.run)

  return (
    <section
      aria-labelledby={`feature-home-${feature.id}`}
      className="space-y-4 rounded-lg border p-5"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h2
            id={`feature-home-${feature.id}`}
            className="text-lg font-semibold"
          >
            {feature.name}
          </h2>
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {feature.intent || (
              <button
                type="button"
                className="underline"
                onClick={onEditDetails}
              >
                Describe what this feature should do
              </button>
            )}
          </p>
        </div>
        <Badge variant={draft ? "outline" : "default"} className="capitalize">
          {feature.status}
        </Badge>
      </div>

      {draft && (
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <ReadinessIcon readiness={line.readiness} />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {blocked && line.readiness !== "needs-input" && !checking
                  ? "Ready to continue"
                  : line.readiness === "not-checked"
                    ? "Ready to start"
                    : line.text}
              </div>
              <p className="text-sm text-muted-foreground">
                {line.readiness === "not-checked"
                  ? workspace
                    ? "Mission Control will check the project, prepare isolated work, and begin planning."
                    : "Choose a workspace so Mission Control can check the project."
                  : line.detail}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {blocked && line.readiness !== "needs-input" && !checking ? (
              <Button
                disabled={pending || !!startAfterRun}
                onClick={() => void start()}
              >
                <Rocket className="size-4" /> Continue starting
              </Button>
            ) : (
              <Button
                disabled={
                  pending || checking || !feature.rigId || !!startAfterRun
                }
                title={
                  feature.rigId
                    ? undefined
                    : "Choose a rig first (Edit details)"
                }
                onClick={() => void start()}
              >
                {pending || startAfterRun ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Rocket className="size-4" />
                )}
                {startAfterRun ? "Setting up, then starting…" : "Start"}
              </Button>
            )}
            {workspace && (
              <Button
                variant="outline"
                disabled={pending || checking}
                onClick={() => void analysis.analyze()}
              >
                <Search className="size-4" /> Analyze workspace
              </Button>
            )}
            {blocked && line.readiness === "needs-input" && (
              <Button variant="ghost" disabled={pending} onClick={startAnyway}>
                Start anyway
              </Button>
            )}
            {!feature.rigId && (
              <Button variant="link" className="px-1" onClick={onEditDetails}>
                Choose a rig
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{MODE_TEXT[feature.driveMode]}</span>
            {feature.driveMode === "autopilot" &&
              feature.drive.autoApplyPlan && (
                <span>· planning applied automatically</span>
              )}
            <span>
              ·{" "}
              {feature.drive.overlapPolicy === "parallel"
                ? "overlapping stories run together"
                : "overlapping stories take turns"}
            </span>
            <button
              type="button"
              className="ml-auto text-foreground underline-offset-2 hover:underline"
              onClick={onReviewSetup}
            >
              Review setup
            </button>
          </div>
          {review && (
            <ApplyAllDialog
              featureId={feature.id}
              open
              onOpenChange={(open) => !open && setReview(null)}
              start={{
                only: review,
                onApplied: (applied) => {
                  setReview(null)
                  if (applied) {
                    setStartAfterRun(applied.id)
                    toast.message(
                      "Setting up in the setup terminal; the feature starts when it finishes."
                    )
                  } else void start({ reviewed: true })
                },
                onStartWithout: () => {
                  setReview(null)
                  void start({ reviewed: true })
                },
              }}
            />
          )}
          {showChecklist && (
            <div ref={checklistRef} className="border-t pt-4">
              <WorkspaceChecklist
                featureId={feature.id}
                state={analysis}
                compact
              />
            </div>
          )}
        </div>
      )}

      {feature.status === "active" && (
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <Loader2 className="mt-0.5 size-5 animate-spin text-primary" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {position?.maneuver.text ?? "Working…"}
              </div>
              <p className="text-sm text-muted-foreground">
                {activeMilestone ? `Milestone: ${activeMilestone.name} · ` : ""}
                {storyCount
                  ? `${done} of ${storyCount} user stories done`
                  : "Planning the work"}
              </p>
              {!!position?.preparing?.length && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {`Preparing ${position.preparing.length === 1 ? "the worktree for" : "worktrees for"} ${position.preparing
                    .map((p) => {
                      const key =
                        graph.userStories.find((s) => s.id === p.userStory)
                          ?.key ?? "a story"
                      return p.step ? `${key} (${p.step})` : key
                    })
                    .join(", ")}`}
                </p>
              )}
            </div>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void act(() => drive.pause(feature.id))}
            >
              <Pause className="size-4" /> Pause
            </Button>
          </div>
          {storyCount > 0 && (
            <div
              className="h-1.5 overflow-hidden rounded-full bg-muted"
              aria-hidden
            >
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.round((done / storyCount) * 100)}%` }}
              />
            </div>
          )}
          <WaitingSummary waiting={waiting} onShowWaiting={onShowWaiting} />
        </div>
      )}

      {feature.status === "paused" && (
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <Pause className="mt-0.5 size-5 text-amber-500" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Paused</div>
              <p className="text-sm text-muted-foreground">
                {feature.drive.pauseReason ?? "Paused."} While paused you can
                change the drive mode, budgets, and setup; nothing new starts
                until you resume.
              </p>
            </div>
            <Button
              disabled={pending}
              onClick={() => void act(() => drive.resume(feature.id))}
            >
              <Play className="size-4" /> Resume
            </Button>
          </div>
          <WaitingSummary waiting={waiting} onShowWaiting={onShowWaiting} />
        </div>
      )}

      {feature.status === "completed" && (
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-5 text-emerald-500" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Completed</div>
            <p className="text-sm text-muted-foreground">
              {graph.milestones.length} milestone
              {graph.milestones.length === 1 ? "" : "s"} · {done} user stor
              {done === 1 ? "y" : "ies"} done.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={pending}
            title="Add more milestones to this feature"
            onClick={() => void act(() => drive.reopen(feature.id))}
          >
            <RotateCcw className="size-4" /> Reopen
          </Button>
        </div>
      )}

      {(feature.status === "failed" || feature.status === "cancelled") && (
        <div className="flex items-start gap-3">
          <XCircle className="mt-0.5 size-5 text-destructive" />
          <div className="min-w-0 flex-1">
            <div className="font-medium capitalize">{feature.status}</div>
            <p className="text-sm text-muted-foreground">
              {feature.drive.pauseReason ??
                (feature.status === "cancelled"
                  ? "This feature was cancelled. Its branches and worktrees stay until you delete it."
                  : "This feature stopped. See Health and Comms for what happened.")}
            </p>
          </div>
        </div>
      )}

      {!draft &&
        feature.status !== "completed" &&
        feature.status !== "cancelled" &&
        feature.status !== "failed" && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              disabled={pending}
              onClick={() => {
                if (
                  window.confirm(
                    `Cancel “${feature.name}”? Running user stories and hooks stop, and it can't be resumed. Branches and worktrees stay until you delete it.`
                  )
                )
                  void act(() => drive.cancel(feature.id))
              }}
            >
              <Square className="size-4" /> Cancel feature
            </Button>
          </div>
        )}
    </section>
  )
}
