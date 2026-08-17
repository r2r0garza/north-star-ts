import * as React from "react"
import { Pencil, FilePlus, Globe, FileCode } from "lucide-react"
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "@/components/ui/hover-card"
import { DiffView } from "@/components/diff-view"
import { changedFilesFromCalls, type ToolUse } from "@/lib/timeline"
import type { ChangedFile } from "@/lib/timeline"
import type { GitDiffResult } from "@/types"
import { cn } from "@/lib/utils"

// The strip of changed-file pills shown at the end of an assistant turn. Derived
// from the turn's tool calls (no stored data) — see changedFilesFromCalls. Each
// pill hovers to a quick preview (git diff for code, rendered page for html) and
// clicks to open (IDE for code, sidebar agent browser for html). "Review all"
// hands the full list to the sidebar "Changes" mode.

// How many pills to show inline before collapsing the rest into "+N more".
const MAX_VISIBLE = 6

function iconFor(file: ChangedFile) {
  if (file.fileType === "html") return Globe
  return file.kind === "edit" ? Pencil : FilePlus
}

// The hover preview for one file. Code files lazily fetch their git diff when the
// card opens; html files render the file in a sandboxed iframe.
function FilePreview({
  workspace,
  file,
}: {
  workspace: string
  file: ChangedFile
}) {
  const [diff, setDiff] = React.useState<GitDiffResult | null>(null)
  const [loading, setLoading] = React.useState(file.fileType === "code")

  React.useEffect(() => {
    if (file.fileType !== "code" || !workspace) return
    let cancelled = false
    setLoading(true)
    window.cowork.git
      .diff(workspace, file.path)
      .then((res) => {
        if (!cancelled) setDiff(res)
      })
      .catch(() => {
        if (!cancelled) setDiff(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspace, file.path, file.fileType])

  if (file.fileType === "html") {
    // Local preview only; sandbox with no allow-* so the page can't script into
    // the app or reach the network with app privileges.
    const src = `file://${workspace}/${file.path}`
    return (
      <div className="flex flex-col gap-1">
        <span className="truncate text-xs font-medium">{file.path}</span>
        <iframe
          src={src}
          title={file.baseName}
          sandbox=""
          className="h-48 w-full rounded border bg-white"
        />
      </div>
    )
  }

  return (
    <div className="flex max-h-72 flex-col gap-1">
      <span className="truncate text-xs font-medium">{file.path}</span>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading diff…</p>
      ) : (
        <DiffView result={diff} className="max-h-64" />
      )}
    </div>
  )
}

export function ChangedFilesBar({
  calls,
  files: filesProp,
  workspace,
  onOpenHtml,
  onReviewAll,
}: {
  // The turn's tool calls, from which changed files are derived. Optional when a
  // precomputed `files` list is passed instead (e.g. the process run monitor,
  // which derives files from a phase-run worker's whole transcript — plan 030b).
  calls?: ToolUse[]
  // A precomputed changed-file list; takes precedence over `calls` when given.
  files?: ChangedFile[]
  // Absolute workspace root; needed to build file:// URLs and run git. When empty
  // (Chat mode / no workspace) the bar renders nothing.
  workspace: string
  // Open an html file in the sidebar agent browser.
  onOpenHtml: (relPath: string) => void
  // Open the sidebar "Changes" review scoped to this turn's files.
  onReviewAll: (files: ChangedFile[]) => void
}) {
  const files = React.useMemo(
    () => filesProp ?? changedFilesFromCalls(calls ?? []),
    [filesProp, calls]
  )
  if (files.length === 0 || !workspace) return null

  const visible = files.slice(0, MAX_VISIBLE)
  const hidden = files.length - visible.length

  const openFile = (file: ChangedFile) => {
    if (file.fileType === "html") {
      onOpenHtml(file.path)
    } else {
      void window.cowork.openInEditor(workspace, file.path)
    }
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">
        {files.length} file{files.length === 1 ? "" : "s"} changed
      </span>
      {visible.map((file) => {
        const Icon = iconFor(file)
        return (
          <HoverCard key={file.path} openDelay={200} closeDelay={80}>
            <HoverCardTrigger asChild>
              <button
                type="button"
                onClick={() => openFile(file)}
                title={
                  file.fileType === "html"
                    ? `Open ${file.baseName} in the browser`
                    : `Open ${file.baseName} in your editor`
                }
                className={cn(
                  "inline-flex max-w-48 items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5",
                  "text-xs text-foreground transition-colors hover:bg-accent"
                )}
              >
                <Icon className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{file.baseName}</span>
              </button>
            </HoverCardTrigger>
            <HoverCardContent
              align="start"
              className={file.fileType === "html" ? "w-80" : "w-96"}
            >
              <FilePreview workspace={workspace} file={file} />
            </HoverCardContent>
          </HoverCard>
        )
      })}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => onReviewAll(files)}
          className="rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          +{hidden} more
        </button>
      )}
      <button
        type="button"
        onClick={() => onReviewAll(files)}
        className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <FileCode className="size-3" />
        Review all
      </button>
    </div>
  )
}
