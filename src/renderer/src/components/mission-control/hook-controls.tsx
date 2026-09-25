import { useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, Loader2, Play, Square } from "lucide-react"
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
  PlaybookHookName,
  PlaybookRun,
  ProcessDefinition,
} from "@/types"

// Manually triggered mission / initiative hooks (plan 106.3). Each button runs
// one hook's small Process run; its last status and live monitor sit beside it.
// 106.6 fires these automatically.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

export interface HookAction {
  hook: PlaybookHookName
  label: string
  // Why the action cannot run right now, if it cannot.
  disabledReason?: string | null
  // The mission the hook runs on (mission hooks, and between-missions).
  missionId?: string | null
}

function HookRow({
  graph,
  action,
  lastRun,
  providers,
  onChanged,
}: {
  graph: InitiativeGraph
  action: HookAction
  lastRun: PlaybookRun | null
  providers: AccountWithModels[]
  onChanged: () => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState(false)
  const [definition, setDefinition] = useState<ProcessDefinition | null>(null)
  const running = lastRun?.status === "running"

  useEffect(() => {
    if (!open || !lastRun?.processRunId) return
    let cancelled = false
    void window.cowork.db.processes.runs
      .get(lastRun.processRunId)
      .then((run) =>
        run?.processId ? window.cowork.db.processes.get(run.processId) : null
      )
      .then((processGraph) => {
        if (!cancelled) setDefinition(processGraph?.definition ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [open, lastRun?.processRunId])

  const run = async () => {
    setPending(true)
    try {
      await window.cowork.missionControl.execution.runHook({
        initiativeId: graph.initiative.id,
        missionId: action.missionId ?? null,
        hook: action.hook,
      })
      toast.success(`${action.label} started`)
      setOpen(true)
      await onChanged()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }

  const cancel = async () => {
    if (!lastRun) return
    try {
      await window.cowork.missionControl.playbookRuns.cancel(lastRun.id)
      await onChanged()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-2 p-3">
        <button
          type="button"
          className="flex items-center gap-1 text-sm font-medium disabled:opacity-60"
          disabled={!lastRun}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {lastRun ? (
            open ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )
          ) : null}
          {action.label}
        </button>
        {lastRun && (
          <Badge variant="outline" className="capitalize">
            {lastRun.status}
          </Badge>
        )}
        {lastRun?.outcomeReason && lastRun.status !== "running" && (
          <span className="text-xs text-muted-foreground">
            {lastRun.outcomeReason}
          </span>
        )}
        <div className="ml-auto">
          {running ? (
            <Button size="sm" variant="outline" onClick={() => void cancel()}>
              <Square className="size-3.5" /> Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !!action.disabledReason}
              title={action.disabledReason ?? undefined}
              onClick={() => void run()}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              {action.label}
            </Button>
          )}
        </div>
      </div>
      {action.disabledReason && !running && (
        <p className="px-3 pb-3 text-xs text-muted-foreground">
          {action.disabledReason}
        </p>
      )}
      {open && lastRun?.processRunId && definition && (
        <div className="flex h-[24rem] flex-col overflow-hidden border-t">
          <RuntimeProvidersContext.Provider value={providers}>
            <RunMonitor
              key={lastRun.processRunId}
              definition={definition}
              activeRunId={lastRun.processRunId}
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

export function HookControls({
  graph,
  actions,
  title,
}: {
  graph: InitiativeGraph
  actions: HookAction[]
  title: string
}) {
  const [runs, setRuns] = useState<PlaybookRun[]>([])
  const [providers, setProviders] = useState<AccountWithModels[]>([])
  const load = useCallback(async () => {
    setRuns(
      await window.cowork.missionControl.playbookRuns.list({
        initiativeId: graph.initiative.id,
      })
    )
  }, [graph.initiative.id])

  useEffect(() => {
    void load()
    window.cowork.providers
      .listWithModels()
      .then(setProviders)
      .catch(() => setProviders([]))
    // Hook runs settle through their backing task; refresh on any terminal
    // task event rather than tracking each run's task id.
    return window.cowork.tasks.onEvent((payload) => {
      if (
        payload.event.type === "task_completed" ||
        payload.event.type === "task_failed" ||
        payload.event.type === "status_change"
      )
        void load()
    })
  }, [load])

  // Hooks run in the workspace itself; slices building in their own
  // worktrees (plan 106.5) don't hold it.
  const busy = runs.find((run) => run.status === "running" && !run.worktreePath)
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {actions.map((action) => {
        const lastRun =
          runs.find(
            (run) =>
              run.hook === action.hook &&
              (action.missionId ? run.missionId === action.missionId : true)
          ) ?? null
        const blockedByOther =
          busy && busy.id !== lastRun?.id
            ? "Another playbook run is using this workspace. Hooks and non-git slices run one at a time."
            : null
        return (
          <HookRow
            key={`${action.hook}:${action.missionId ?? ""}`}
            graph={graph}
            action={{
              ...action,
              disabledReason: action.disabledReason ?? blockedByOther,
            }}
            lastRun={lastRun}
            providers={providers}
            onChanged={load}
          />
        )
      })}
    </div>
  )
}
