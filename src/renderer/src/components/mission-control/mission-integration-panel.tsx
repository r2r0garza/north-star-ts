import { useCallback, useEffect, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  GitMerge,
  Loader2,
  RotateCcw,
  Wrench,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  InitiativeGraph,
  MergePolicyMode,
  MergeQueueEntry,
  Mission,
  MissionIntegrationStatus,
} from "@/types"

// Mission integration (plan 106.5): the integration branch, the merge policy,
// the merge queue, and the landing step. Landing a mission is an explicit
// approval of exactly the base and head shown in the review dialog.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

const short = (oid: string | null | undefined) => (oid ? oid.slice(0, 8) : "—")

const POLICY_LABELS: Record<MergePolicyMode, string> = {
  manual: "Manual — I merge it myself",
  local_merge: "Local merge after my approval",
  open_pr: "Pull request after my approval",
}

const STATUS_LABELS: Record<MergeQueueEntry["status"], string> = {
  queued: "queued",
  merging: "merging",
  merged: "merged",
  conflict: "conflict",
  resolving: "resolving",
  cancelled: "abandoned",
}

function statusVariant(entry: MergeQueueEntry) {
  if (entry.status === "merged") return "secondary" as const
  if (entry.status === "conflict") return "destructive" as const
  return "outline" as const
}

function QueueRow({
  graph,
  entry,
  onChanged,
}: {
  graph: InitiativeGraph
  entry: MergeQueueEntry
  onChanged: () => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const slice = graph.slices.find((s) => s.id === entry.sliceId)
  const act = async (action: () => Promise<unknown>, success: string) => {
    setPending(true)
    try {
      await action()
      toast.success(success)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
      await onChanged()
    }
  }
  const api = window.cowork.missionControl.integration
  return (
    <div className="space-y-1.5 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {entry.status === "merging" || entry.status === "resolving" ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : entry.status === "merged" ? (
          <CheckCircle2 className="size-3.5 text-emerald-600" />
        ) : entry.status === "conflict" ? (
          <AlertTriangle className="size-3.5 text-destructive" />
        ) : (
          <GitMerge className="size-3.5 text-muted-foreground" />
        )}
        <span className="font-medium">{slice?.title ?? "Deleted slice"}</span>
        <code className="text-xs text-muted-foreground">{slice?.key}</code>
        <Badge variant={statusVariant(entry)} className="ml-auto">
          {STATUS_LABELS[entry.status]}
          {entry.escalated ? " · needs you" : ""}
        </Badge>
      </div>
      {entry.note && (
        <p
          className={`text-xs ${entry.escalated ? "text-destructive" : "text-muted-foreground"}`}
        >
          {entry.note}
        </p>
      )}
      {entry.conflictFiles.length > 0 && entry.status !== "merged" && (
        <p className="text-xs text-muted-foreground">
          Conflicted:{" "}
          {entry.conflictFiles.map((file) => (
            <code key={file} className="mr-1.5">
              {file}
            </code>
          ))}
        </p>
      )}
      {entry.outsideHints.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Touched outside its touch hints: {entry.outsideHints.slice(0, 8).join(", ")}
          {entry.outsideHints.length > 8 ? ` and ${entry.outsideHints.length - 8} more` : ""}
        </p>
      )}
      {entry.mergeCommit && (
        <p className="text-xs text-muted-foreground">
          Merge commit <code>{short(entry.mergeCommit)}</code>
          {entry.resolutionAttempts > 0 ? " · resolved by the integrator" : ""}
        </p>
      )}
      {entry.status === "conflict" && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            title="Merge again, e.g. after you fixed the slice branch yourself"
            onClick={() => void act(() => api.retry(entry.id), "Merge queued again")}
          >
            <RotateCcw className="size-3.5" /> Retry merge
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            title="Run the mission playbook's after-each-slice hook to resolve and re-verify"
            onClick={() => void act(() => api.resolve(entry.id), "Integrator started")}
          >
            <Wrench className="size-3.5" /> Run integrator
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            disabled={pending}
            onClick={() => {
              if (
                !window.confirm(
                  `Abandon merging ${slice?.key ?? "this slice"}? The slice fails and can be retried from the current integration branch; its branch is kept.`
                )
              )
                return
              void act(() => api.abandon(entry.id), "Slice merge abandoned")
            }}
          >
            <XIcon className="size-3.5" /> Abandon
          </Button>
        </div>
      )}
    </div>
  )
}

function LandDialog({
  open,
  status,
  mission,
  onClose,
  onLanded,
}: {
  open: boolean
  status: MissionIntegrationStatus
  mission: Mission
  onClose: () => void
  onLanded: () => Promise<void>
}) {
  const [pending, setPending] = useState(false)
  const summary = status.summary
  const pr = status.policy === "open_pr"
  const approve = async () => {
    if (!summary?.baseOid || !summary.headOid) return
    setPending(true)
    try {
      const landing = await window.cowork.missionControl.integration.land(mission.id, {
        baseOid: summary.baseOid,
        headOid: summary.headOid,
      })
      toast.success(landing.prUrl ? "Pull request opened" : `Merged into ${landing.base}`)
      onClose()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
      await onLanded()
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl" onBackdropClick={onClose}>
        <DialogHeader>
          <DialogTitle>
            {pr ? "Approve pushing and opening a pull request" : "Approve merging into your branch"}
          </DialogTitle>
        </DialogHeader>
        {summary && (
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1">
              <span className="text-muted-foreground">Base</span>
              <span>
                <code>{summary.base}</code> at <code>{short(summary.baseOid)}</code>
                {summary.baseCheckout && !pr && (
                  <span className="block text-xs text-muted-foreground">
                    Checked out in {summary.baseCheckout}; the merge runs there.
                  </span>
                )}
              </span>
              <span className="text-muted-foreground">Head</span>
              <span>
                <code>{summary.head}</code> at <code>{short(summary.headOid)}</code>
              </span>
              <span className="text-muted-foreground">How</span>
              <span>
                {pr
                  ? "Push the integration branch to your remote and open a PR with gh. Nothing merges locally."
                  : summary.fastForward
                    ? "Fast-forward. No merge commit; nothing is pushed."
                    : "A merge commit on the base branch. Nothing is pushed."}
              </span>
            </div>
            <div>
              <div className="mb-1 font-medium">
                {summary.commitCount} commit{summary.commitCount === 1 ? "" : "s"}
              </div>
              <div className="max-h-40 space-y-0.5 overflow-y-auto rounded border p-2 text-xs">
                {summary.commits.map((commit) => (
                  <div key={commit.oid} className="flex gap-2">
                    <code className="shrink-0 text-muted-foreground">{short(commit.oid)}</code>
                    <span className="truncate">{commit.subject}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 font-medium">
                {summary.files.length}
                {summary.filesTruncated ? "+" : ""} file{summary.files.length === 1 ? "" : "s"}
              </div>
              <div className="max-h-40 space-y-0.5 overflow-y-auto rounded border p-2 text-xs">
                {summary.files.map((file) => (
                  <div key={file.path} className="flex gap-2">
                    <code className="w-4 shrink-0 text-muted-foreground">{file.status}</code>
                    <span className="truncate">{file.path}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button disabled={pending || !summary?.headOid} onClick={() => void approve()}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {pr ? "Approve and open PR" : "Approve and merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function MissionIntegrationPanel({
  graph,
  mission,
  onGraph,
  onRefresh,
}: {
  graph: InitiativeGraph
  mission: Mission
  onGraph: (graph: InitiativeGraph) => void
  onRefresh: () => Promise<void>
}) {
  const [status, setStatus] = useState<MissionIntegrationStatus | null>(null)
  const [landOpen, setLandOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const initiativeId = graph.initiative.id

  const load = useCallback(async () => {
    try {
      setStatus(await window.cowork.missionControl.integration.status(mission.id))
    } catch (error) {
      console.warn("[integration] status:", error)
    }
  }, [mission.id])

  // Reload on any graph change for this mission (slices settle, merges land).
  useEffect(() => {
    void load()
  }, [load, mission.status, mission.integrationBranch, graph.slices])

  useEffect(
    () =>
      window.cowork.missionControl.integration.onChanged((changed) => {
        if (changed === initiativeId) void Promise.all([load(), onRefresh()])
      }),
    [initiativeId, load, onRefresh]
  )

  const reload = async () => {
    await Promise.all([load(), onRefresh()])
  }

  if (!status) return null
  const workspace = status.workspace
  const summary = status.summary
  const setPolicy = async (mode: MergePolicyMode) => {
    try {
      onGraph(await window.cowork.missionControl.integration.setPolicy(mission.id, mode))
      await load()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }
  const markMerged = async () => {
    setPending(true)
    try {
      await window.cowork.missionControl.integration.markMerged(mission.id)
      toast.success("Mission completed")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
      await reload()
    }
  }
  const queue = [...status.queue].reverse()
  const landing = status.landing

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <GitBranch className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Integration</h3>
        {status.integrationBranch ? (
          <>
            <Badge variant="outline" className="font-mono">
              {status.integrationBranch}
            </Badge>
            <span className="text-xs text-muted-foreground">
              from <code>{status.baseRef}</code> at <code>{short(status.baseOid)}</code>
            </span>
          </>
        ) : workspace.mode === "git" ? (
          <span className="text-xs text-muted-foreground">
            The integration branch is created from your current branch when the first
            slice runs. Your working tree must be clean then.
          </span>
        ) : null}
        <div className="ml-auto w-72">
          <Select
            value={status.policy}
            onValueChange={(value) => void setPolicy(value as MergePolicyMode)}
            disabled={["completed", "cancelled"].includes(mission.status)}
          >
            <SelectTrigger aria-label="Merge policy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(POLICY_LABELS) as MergePolicyMode[])
                .filter((mode) => status.policies[mode].visible)
                .map((mode) => {
                  const option = status.policies[mode]
                  const locked = status.policyLocked && mode !== "manual" && mode !== status.policy
                  return (
                    <SelectItem
                      key={mode}
                      value={mode}
                      disabled={!option.available || locked}
                    >
                      {POLICY_LABELS[mode]}
                      {locked
                        ? " (locked after start)"
                        : !option.available && option.reason
                          ? ` (${option.reason})`
                          : ""}
                    </SelectItem>
                  )
                })}
            </SelectContent>
          </Select>
        </div>
      </div>

      {workspace.mode !== "git" && (
        <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {workspace.reason}
        </p>
      )}

      {queue.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Merge queue
          </div>
          {queue.map((entry) => (
            <QueueRow key={entry.id} graph={graph} entry={entry} onChanged={reload} />
          ))}
        </div>
      )}

      {mission.status === "review" && (
        <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3">
          <div className="text-sm font-medium">
            {status.integrationBranch
              ? "Every slice is merged into the integration branch."
              : "Every slice is done."}
          </div>
          {summary && (
            <p className="text-xs text-muted-foreground">
              {summary.commitCount} commit{summary.commitCount === 1 ? "" : "s"} and{" "}
              {summary.files.length}
              {summary.filesTruncated ? "+" : ""} file
              {summary.files.length === 1 ? "" : "s"} changed against{" "}
              <code>{summary.base}</code>.
              {status.policy === "manual" &&
                " Merge the integration branch however you like; Mission Control notices when it's in your base branch."}
            </p>
          )}
          <div className="flex gap-2">
            {status.policy !== "manual" && status.integrationBranch ? (
              <Button size="sm" onClick={() => setLandOpen(true)} disabled={!summary?.headOid}>
                <GitMerge className="size-3.5" />
                {status.policy === "open_pr" ? "Review and open PR…" : "Review and merge…"}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => {
                  if (
                    status.integrationBranch &&
                    !window.confirm(
                      `Mark mission ${mission.key} as merged? Do this once ${status.integrationBranch} is in ${status.baseRef}.`
                    )
                  )
                    return
                  void markMerged()
                }}
              >
                <CheckCircle2 className="size-3.5" />
                {status.integrationBranch ? "Mark merged" : "Mark complete"}
              </Button>
            )}
          </div>
        </div>
      )}

      {mission.status === "completed" && landing && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
          <CheckCircle2 className="size-4 text-emerald-600" />
          {landing.prUrl ? (
            <>
              Pull request opened
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0"
                onClick={() => window.open(landing.prUrl, "_blank")}
              >
                {landing.prUrl} <ExternalLink className="size-3" />
              </Button>
            </>
          ) : landing.mergeCommit ? (
            <>
              Merged into <code>{landing.base}</code>
              {landing.fastForward ? " (fast-forward)" : ""} at{" "}
              <code>{short(landing.mergeCommit)}</code>
            </>
          ) : landing.completedBy === "detected" ? (
            <>
              Found the integration branch in <code>{landing.base}</code>
            </>
          ) : (
            <>Marked {landing.base ? "merged" : "complete"} by you</>
          )}
        </div>
      )}

      {status.integrationBranch && (
        <LandDialog
          open={landOpen}
          status={status}
          mission={mission}
          onClose={() => setLandOpen(false)}
          onLanded={reload}
        />
      )}
    </div>
  )
}
