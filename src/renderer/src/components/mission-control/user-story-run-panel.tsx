import { useCallback, useEffect, useState } from "react"
import { Loader2, Play, RotateCcw, Square } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  RunMonitor,
  RuntimeProvidersContext,
} from "@/components/process-screen"
import type {
  AccountWithModels,
  FeatureGraph,
  PlaybookRun,
  ProcessDefinition,
  ProcessRun,
  UserStory,
} from "@/types"
import { isUserStoryProof, ProofPanel } from "./proof-panel"
import { UserStoryWorktreePanel } from "./user-story-worktree-panel"

// User story execution (plan 106.3): Run / Retry / Cancel, the live embedded Process
// run monitor, and the recorded proof. In a git workspace each attempt builds
// in its own worktree and user stories run in parallel (106.5); otherwise one
// playbook runs at a time per workspace. The controls explain why they are
// unavailable.

const DEFAULT_MAX_ATTEMPTS = 3

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

function maxAttempts(graph: FeatureGraph): number {
  const value = graph.feature.budgets?.maxUserStoryAttempts
  return typeof value === "number" ? value : DEFAULT_MAX_ATTEMPTS
}

export function UserStoryRunPanel({
  graph,
  userStory,
  workspacePath,
  onRefresh,
}: {
  graph: FeatureGraph
  userStory: UserStory
  workspacePath: string
  onRefresh: () => Promise<void>
}) {
  const [runs, setRuns] = useState<PlaybookRun[]>([])
  const [busyRun, setBusyRun] = useState<PlaybookRun | null>(null)
  const [processRun, setProcessRun] = useState<ProcessRun | null>(null)
  const [definition, setDefinition] = useState<ProcessDefinition | null>(null)
  const [providers, setProviders] = useState<AccountWithModels[]>([])
  const [pending, setPending] = useState(false)
  const [isolated, setIsolated] = useState(false)
  // A refused start because another building user story's touch hints overlap.
  const [overlap, setOverlap] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [userStoryRuns, active, integration] = await Promise.all([
      window.cowork.missionControl.playbookRuns.list({
        userStoryId: userStory.id,
      }),
      window.cowork.missionControl.playbookRuns.list({ status: "running" }),
      window.cowork.missionControl.integration
        .status(userStory.milestoneId)
        .catch(() => null),
    ])
    setRuns(userStoryRuns)
    const git = integration?.workspace.mode === "git"
    setIsolated(git)
    // Only runs in the workspace itself occupy it; user stories in a git workspace
    // build in their own worktrees.
    setBusyRun(
      git
        ? null
        : (active.find(
            (run) => run.userStoryId !== userStory.id && !run.worktreePath
          ) ?? null)
    )
    const runId =
      userStory.processRunId ?? userStoryRuns[0]?.processRunId ?? null
    const run = runId ? await window.cowork.db.processes.runs.get(runId) : null
    setProcessRun(run ?? null)
    if (run?.processId) {
      const processGraph = await window.cowork.db.processes.get(run.processId)
      setDefinition(processGraph?.definition ?? null)
    } else setDefinition(null)
  }, [userStory.id, userStory.milestoneId, userStory.processRunId])

  useEffect(() => {
    void load()
    window.cowork.providers
      .listWithModels()
      .then(setProviders)
      .catch(() => setProviders([]))
  }, [load])

  // The run's backing task drives live updates: its terminal status is when
  // the user story outcome lands, so refresh the graph and the run list then.
  useEffect(() => {
    const taskId = processRun?.taskId
    if (!taskId) return
    return window.cowork.tasks.onEvent((payload) => {
      if (payload.taskId !== taskId) return
      if (
        payload.event.type === "status_change" ||
        payload.event.type === "task_completed" ||
        payload.event.type === "task_failed"
      )
        void Promise.all([onRefresh(), load()])
    })
  }, [processRun?.taskId, onRefresh, load])

  const latest = runs[0] ?? null
  const running = latest?.status === "running"
  const cap = maxAttempts(graph)
  const blockers = graph.edges
    .filter((edge) => edge.toUserStoryId === userStory.id)
    .map((edge) => graph.userStories.find((s) => s.id === edge.fromUserStoryId))
    .filter((dep): dep is UserStory => !!dep && dep.status !== "done")
  const canStart = ["draft", "ready", "failed"].includes(userStory.status)
  const disabledReason =
    graph.feature.status !== "active"
      ? "Start the feature before running user stories."
      : !graph.feature.workspaceId
        ? "Choose a workspace for this feature first."
        : busyRun
          ? `Another playbook run is using this workspace (${busyRun.userStoryId ? `user story ${graph.userStories.find((s) => s.id === busyRun.userStoryId)?.key ?? ""}` : `the ${busyRun.hook.replace(/_/g, " ")} hook`}). User stories run in parallel only in a git workspace.`
          : blockers.length
            ? `Waiting on ${isolated ? "unmerged" : "unfinished"} user stories: ${blockers.map((b) => b.key).join(", ")}.`
            : userStory.attempts >= cap
              ? `All ${cap} attempts are used.`
              : !userStory.spec.acceptance.length
                ? "Add acceptance criteria so the user story can be proven."
                : null

  const act = async (action: () => Promise<unknown>, success: string) => {
    setPending(true)
    try {
      await action()
      setOverlap(null)
      toast.success(success)
      await Promise.all([onRefresh(), load()])
    } catch (error) {
      const message = errorMessage(error)
      if (message.startsWith("touch_overlap:"))
        setOverlap(message.replace(/^touch_overlap:\s*/, ""))
      else toast.error(message)
    } finally {
      setPending(false)
    }
  }
  const run = (allowTouchOverlap = false) =>
    act(
      () =>
        window.cowork.missionControl.execution.runUserStory(userStory.id, {
          allowTouchOverlap,
        }),
      userStory.status === "failed" ? "Retry started" : "User story run started"
    )

  const proof = isUserStoryProof(userStory.proof)
    ? userStory.proof
    : (latest?.proof ?? null)

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Execution</h3>
        <Badge variant="outline">{userStory.status}</Badge>
        <span className="text-xs text-muted-foreground">
          Attempt {userStory.attempts} of {cap}
        </span>
        <div className="ml-auto flex gap-2">
          {running ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                void act(
                  () =>
                    window.cowork.missionControl.execution.cancelUserStory(
                      userStory.id
                    ),
                  "User story run cancelled"
                )
              }
            >
              <Square className="size-3.5" /> Cancel
            </Button>
          ) : (
            canStart && (
              <Button
                size="sm"
                disabled={pending || disabledReason !== null}
                title={disabledReason ?? undefined}
                onClick={() => void run()}
              >
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : userStory.status === "failed" ? (
                  <RotateCcw className="size-3.5" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {userStory.status === "failed" ? "Retry" : "Run"}
              </Button>
            )
          )}
        </div>
      </div>
      {!running && canStart && disabledReason && (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      )}
      {running && <NudgeBox userStoryId={userStory.id} />}
      {overlap && !running && canStart && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
          <span className="flex-1">{overlap}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => void run(true)}
          >
            Run anyway
          </Button>
        </div>
      )}
      {userStory.status === "integrating" && (
        <p className="text-xs text-muted-foreground">
          Proof accepted. The user story is in the milestone's merge queue and
          is done once it merges into the integration branch.
        </p>
      )}
      <UserStoryWorktreePanel userStory={userStory} />
      {latest && latest.status !== "running" && latest.outcomeReason && (
        <p
          className={`text-xs ${latest.status === "completed" ? "text-muted-foreground" : "text-destructive"}`}
        >
          Last attempt {latest.status}: {latest.outcomeReason}
        </p>
      )}
      {proof ? (
        <ProofPanel
          proof={proof}
          spec={userStory.spec}
          workspacePath={workspacePath}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {running
            ? "The playbook's proof step records the proof when it verifies the user story."
            : "No proof yet. Running the user story's playbook ends with a verified proof."}
        </p>
      )}
      {processRun && definition && (
        <div className="flex h-[28rem] flex-col overflow-hidden rounded-md border">
          <RuntimeProvidersContext.Provider value={providers}>
            <RunMonitor
              key={processRun.id}
              definition={definition}
              activeRunId={processRun.id}
              providerModels={providers}
              onSelectRun={() => {}}
              embedded
            />
          </RuntimeProvidersContext.Provider>
        </div>
      )}
    </div>
  )
}

// Steer a running phase without cancelling it: the note reaches the worker
// before its next model round.
function NudgeBox({ userStoryId }: { userStoryId: string }) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const send = async () => {
    setSending(true)
    try {
      const phases =
        await window.cowork.missionControl.execution.nudgeUserStory(
          userStoryId,
          text
        )
      toast.success(
        `Sent to ${phases.join(", ")}; it reads it before its next step.`
      )
      setText("")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="flex gap-2">
      <Input
        className="h-8 text-xs"
        placeholder="Nudge the running phase, e.g. Stop investigating and write the plan now."
        aria-label="Nudge the running phase"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim() && !sending) void send()
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!text.trim() || sending}
        onClick={() => void send()}
      >
        Nudge
      </Button>
    </div>
  )
}
