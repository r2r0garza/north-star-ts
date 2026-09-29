import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, History } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  RunMonitor,
  RuntimeProvidersContext,
} from "@/components/process-screen"
import { formatRelativeTime } from "@/lib/utils"
import type {
  AccountWithModels,
  ProcessDefinition,
  ProcessRun,
  ProcessRunHistoryEntry,
} from "@/types"

// Playbooks → History (plan 106.9): every top-level Process run — legacy runs,
// Quick runs, and Mission Control hook runs — opened in the Process monitor.
// A run Mission Control started names its feature and user story, and keeps
// the embedded monitor so Mission Control stays in charge of it.

const STATUS_VARIANT: Record<
  ProcessRun["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  queued: "outline",
  running: "default",
  waiting_for_approval: "default",
  paused: "secondary",
  interrupted: "secondary",
  completed: "secondary",
  failed: "destructive",
  cancelled: "outline",
}

function runTitle(entry: ProcessRunHistoryEntry): string {
  return (
    entry.run.title?.trim() || entry.run.objective?.trim() || "Untitled run"
  )
}

export function PlaybookHistory({
  definitions,
  providers,
  selectedRunId,
  onSelectRun,
}: {
  definitions: ProcessDefinition[]
  providers: AccountWithModels[]
  selectedRunId: string | null
  onSelectRun: (runId: string | null) => void
}) {
  const [entries, setEntries] = useState<ProcessRunHistoryEntry[] | null>(null)

  const load = useCallback(async () => {
    setEntries(await window.cowork.missionControl.playbooks.history())
  }, [])

  useEffect(() => {
    void load()
  }, [load, selectedRunId])

  const selected = entries?.find((entry) => entry.run.id === selectedRunId)
  const definition = selected?.run.processId
    ? definitions.find((d) => d.id === selected.run.processId)
    : undefined

  if (selectedRunId) {
    return (
      <div className="flex h-full min-h-[36rem] flex-col gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back to history"
            onClick={() => onSelectRun(null)}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">
              {selected ? runTitle(selected) : "Run"}
            </p>
            {selected && (
              <p className="truncate text-xs text-muted-foreground">
                {[
                  selected.processName,
                  selected.featureName && `Feature: ${selected.featureName}`,
                  selected.userStoryTitle &&
                    `User story: ${selected.userStoryTitle}`,
                ]
                  .filter(Boolean)
                  .join(" - ")}
              </p>
            )}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
          {!entries ? null : definition && selected ? (
            <RuntimeProvidersContext.Provider value={providers}>
              <RunMonitor
                key={definition.id}
                definition={definition}
                activeRunId={selectedRunId}
                providerModels={providers}
                onSelectRun={onSelectRun}
                embedded={!!selected.run.missionControl}
              />
            </RuntimeProvidersContext.Provider>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              This run's process definition no longer exists, so it can't be
              opened.
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Every process run, newest first: runs from Processes, Quick runs, and
        the playbook runs Mission Control starts.
      </p>
      {entries && entries.length === 0 && (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          <History className="mx-auto mb-2 size-6" />
          No runs yet. Start one with Quick run.
        </div>
      )}
      <div className="divide-y rounded-lg border">
        {(entries ?? []).map((entry) => (
          <button
            key={entry.run.id}
            type="button"
            onClick={() => onSelectRun(entry.run.id)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted/40"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{runTitle(entry)}</p>
              <p className="truncate text-xs text-muted-foreground">
                {[
                  entry.processName ?? "Deleted process",
                  entry.featureName
                    ? `Feature: ${entry.featureName}`
                    : entry.run.seatBindings
                      ? "Quick run"
                      : null,
                  entry.userStoryTitle && `User story: ${entry.userStoryTitle}`,
                ]
                  .filter(Boolean)
                  .join(" - ")}
              </p>
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatRelativeTime(entry.run.createdAt)}
            </span>
            <Badge variant={STATUS_VARIANT[entry.run.status]}>
              {entry.run.status.replace(/_/g, " ")}
            </Badge>
          </button>
        ))}
      </div>
    </div>
  )
}
