import { useCallback, useEffect, useState } from "react"
import { Copy, FileDiff, FolderOpen, GitBranch, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DiffView } from "@/components/diff-view"
import type { SliceWorkspaceInfo, WorkSlice } from "@/types"

// A slice attempt's branch and worktree (plan 106.5): where it builds, a way
// to open it, and its changes against the integration commit it started from.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

export function SliceWorktreePanel({ slice }: { slice: WorkSlice }) {
  const [info, setInfo] = useState<SliceWorkspaceInfo | null>(null)
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean } | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const api = window.cowork.missionControl.integration

  useEffect(() => {
    api
      .sliceInfo(slice.id)
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [api, slice.id, slice.status, slice.worktreePath, slice.branch])

  const loadDiff = useCallback(async () => {
    setLoadingDiff(true)
    try {
      setDiff(await api.sliceDiff(slice.id))
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setLoadingDiff(false)
    }
  }, [api, slice.id])

  useEffect(() => {
    if (diffOpen) void loadDiff()
  }, [diffOpen, loadDiff, slice.status])

  if (!info?.branch) return null
  const path = info.exists ? info.workspacePath : null
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <GitBranch className="size-4 text-muted-foreground" />
        <code className="text-xs">{info.branch}</code>
        {info.baseOid && (
          <span className="text-xs text-muted-foreground">
            from <code>{info.integrationBranch}</code> at <code>{info.baseOid.slice(0, 8)}</code>
          </span>
        )}
        <div className="ml-auto flex gap-1.5">
          {path && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void api.openWorktree(slice.id).then((error) => {
                    if (error) toast.error(error)
                  })
                }
              >
                <FolderOpen className="size-3.5" /> Open in IDE
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Copy worktree path"
                title="Copy worktree path (open a terminal there)"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(path)
                    .then(() => toast.success("Worktree path copied"))
                    .catch((error) => toast.error(errorMessage(error)))
                }
              >
                <Copy className="size-3.5" />
              </Button>
            </>
          )}
          {info.baseOid && (
            <Button size="sm" variant="ghost" onClick={() => setDiffOpen((open) => !open)}>
              <FileDiff className="size-3.5" /> {diffOpen ? "Hide diff" : "Diff"}
            </Button>
          )}
        </div>
      </div>
      {path ? (
        <p className="truncate text-xs text-muted-foreground" title={path}>
          Worktree: {path}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {slice.status === "done"
            ? "Merged; its worktree was removed."
            : "The worktree was removed; the branch is kept for inspection."}
        </p>
      )}
      {diffOpen &&
        (loadingDiff && !diff ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : diff && !diff.diff.trim() ? (
          <p className="text-xs text-muted-foreground">
            No changes against the integration base yet.
          </p>
        ) : diff ? (
          <div className="max-h-[28rem] overflow-auto rounded border">
            <DiffView result={{ diff: diff.diff, truncated: diff.truncated, untracked: false }} />
          </div>
        ) : null)}
    </div>
  )
}
