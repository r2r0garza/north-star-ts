import { useCallback, useEffect, useState } from "react"
import { Loader2, Play, RotateCcw, Square } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  RunMonitor,
  RuntimeProvidersContext,
} from "@/components/process-screen"
import type {
  AccountWithModels,
  InitiativeGraph,
  PlaybookRun,
  ProcessDefinition,
  ProcessRun,
  WorkSlice,
} from "@/types"
import { isSliceProof, ProofPanel } from "./proof-panel"

// Slice execution (plan 106.3): Run / Retry / Cancel, the live embedded Process
// run monitor, and the recorded proof. v1 runs one playbook at a time per
// workspace, and the controls explain why they are unavailable.

const DEFAULT_MAX_ATTEMPTS = 3

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

function maxAttempts(graph: InitiativeGraph): number {
  const value = graph.initiative.budgets?.maxSliceAttempts
  return typeof value === "number" ? value : DEFAULT_MAX_ATTEMPTS
}

export function SliceRunPanel({
  graph,
  slice,
  workspacePath,
  onRefresh,
}: {
  graph: InitiativeGraph
  slice: WorkSlice
  workspacePath: string
  onRefresh: () => Promise<void>
}) {
  const [runs, setRuns] = useState<PlaybookRun[]>([])
  const [busyRun, setBusyRun] = useState<PlaybookRun | null>(null)
  const [processRun, setProcessRun] = useState<ProcessRun | null>(null)
  const [definition, setDefinition] = useState<ProcessDefinition | null>(null)
  const [providers, setProviders] = useState<AccountWithModels[]>([])
  const [pending, setPending] = useState(false)

  const load = useCallback(async () => {
    const [sliceRuns, active] = await Promise.all([
      window.cowork.missionControl.playbookRuns.list({ sliceId: slice.id }),
      window.cowork.missionControl.playbookRuns.list({ status: "running" }),
    ])
    setRuns(sliceRuns)
    setBusyRun(active.find((run) => run.sliceId !== slice.id) ?? null)
    const runId = slice.processRunId ?? sliceRuns[0]?.processRunId ?? null
    const run = runId ? await window.cowork.db.processes.runs.get(runId) : null
    setProcessRun(run ?? null)
    if (run?.processId) {
      const processGraph = await window.cowork.db.processes.get(run.processId)
      setDefinition(processGraph?.definition ?? null)
    } else setDefinition(null)
  }, [slice.id, slice.processRunId])

  useEffect(() => {
    void load()
    window.cowork.providers
      .listWithModels()
      .then(setProviders)
      .catch(() => setProviders([]))
  }, [load])

  // The run's backing task drives live updates: its terminal status is when
  // the slice outcome lands, so refresh the graph and the run list then.
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
    .filter((edge) => edge.toSliceId === slice.id)
    .map((edge) => graph.slices.find((s) => s.id === edge.fromSliceId))
    .filter((dep): dep is WorkSlice => !!dep && dep.status !== "done")
  const canStart = ["draft", "ready", "failed"].includes(slice.status)
  const disabledReason =
    graph.initiative.status !== "active"
      ? "Start the initiative before running slices."
      : !graph.initiative.workspaceId
        ? "Choose a workspace for this initiative first."
        : busyRun
          ? `Another playbook run is using this workspace (${busyRun.sliceId ? `slice ${graph.slices.find((s) => s.id === busyRun.sliceId)?.key ?? ""}` : `the ${busyRun.hook.replace(/_/g, " ")} hook`}). One run at a time until worktrees arrive.`
          : blockers.length
            ? `Waiting on unfinished slices: ${blockers.map((b) => b.key).join(", ")}.`
            : slice.attempts >= cap
              ? `All ${cap} attempts are used.`
              : !slice.spec.acceptance.length
                ? "Add acceptance criteria so the slice can be proven."
                : null

  const act = async (action: () => Promise<unknown>, success: string) => {
    setPending(true)
    try {
      await action()
      toast.success(success)
      await Promise.all([onRefresh(), load()])
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }

  const proof = isSliceProof(slice.proof) ? slice.proof : latest?.proof ?? null

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Execution</h3>
        <Badge variant="outline">{slice.status}</Badge>
        <span className="text-xs text-muted-foreground">
          Attempt {slice.attempts} of {cap}
        </span>
        <div className="ml-auto flex gap-2">
          {running ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                void act(
                  () => window.cowork.missionControl.execution.cancelSlice(slice.id),
                  "Slice run cancelled"
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
                onClick={() =>
                  void act(
                    () => window.cowork.missionControl.execution.runSlice(slice.id),
                    slice.status === "failed" ? "Retry started" : "Slice run started"
                  )
                }
              >
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : slice.status === "failed" ? (
                  <RotateCcw className="size-3.5" />
                ) : (
                  <Play className="size-3.5" />
                )}
                {slice.status === "failed" ? "Retry" : "Run"}
              </Button>
            )
          )}
        </div>
      </div>
      {!running && canStart && disabledReason && (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      )}
      {latest && latest.status !== "running" && latest.outcomeReason && (
        <p
          className={`text-xs ${latest.status === "completed" ? "text-muted-foreground" : "text-destructive"}`}
        >
          Last attempt {latest.status}: {latest.outcomeReason}
        </p>
      )}
      {proof ? (
        <ProofPanel proof={proof} spec={slice.spec} workspacePath={workspacePath} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {running
            ? "The playbook's proof step records the proof when it verifies the slice."
            : "No proof yet. Running the slice's playbook ends with a verified proof."}
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
