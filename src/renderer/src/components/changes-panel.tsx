import * as React from "react"
import { Pencil, FilePlus, Globe, ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import { DiffView } from "@/components/diff-view"
import type { ChangedFile } from "@/lib/timeline"
import type { GitDiffResult } from "@/types"

// The sidebar "Changes" review surface: the roomy counterpart to the transcript's
// hover popovers. Lists the files handed to it (a turn's changed files) and shows
// the selected file's full git diff (code) or a rendered preview (html) at full
// panel height. Clicking "open" routes code → IDE, html → agent browser (via the
// callbacks the Shell wires).

export function ChangesPanel({
  files,
  workspace,
  onOpenHtml,
}: {
  files: ChangedFile[]
  workspace: string
  onOpenHtml: (relPath: string) => void
}) {
  const [selectedPath, setSelectedPath] = React.useState<string | null>(
    files[0]?.path ?? null
  )
  // Keep a valid selection as the reviewed set changes (new turn reviewed).
  React.useEffect(() => {
    if (files.length === 0) {
      setSelectedPath(null)
    } else if (!files.some((f) => f.path === selectedPath)) {
      setSelectedPath(files[0].path)
    }
  }, [files, selectedPath])

  const selected = files.find((f) => f.path === selectedPath) ?? null

  const [diff, setDiff] = React.useState<GitDiffResult | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (!selected || selected.fileType !== "code" || !workspace) {
      setDiff(null)
      return
    }
    let cancelled = false
    setLoading(true)
    window.cowork.git
      .diff(workspace, selected.path)
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
  }, [selected, workspace])

  if (files.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center">
        <p className="text-xs text-muted-foreground">
          No changes to review. Use "Review all" on a turn's changed files.
        </p>
      </div>
    )
  }

  const openSelected = () => {
    if (!selected) return
    if (selected.fileType === "html") onOpenHtml(selected.path)
    else void window.cowork.openInEditor(workspace, selected.path)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col pl-1">
      {/* File list */}
      <ul className="max-h-40 shrink-0 overflow-auto border-b py-1">
        {files.map((file) => {
          const Icon =
            file.fileType === "html"
              ? Globe
              : file.kind === "edit"
                ? Pencil
                : FilePlus
          return (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => setSelectedPath(file.path)}
                title={file.path}
                className={cn(
                  "flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors hover:bg-accent",
                  file.path === selectedPath &&
                    "bg-accent text-accent-foreground"
                )}
              >
                <Icon className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{file.baseName}</span>
              </button>
            </li>
          )
        })}
      </ul>
      {/* Selected file detail */}
      {selected && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-medium">
              {selected.path}
            </span>
            <button
              type="button"
              onClick={openSelected}
              title={
                selected.fileType === "html"
                  ? "Open in the browser"
                  : "Open in your editor"
              }
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1">
            {selected.fileType === "html" ? (
              <iframe
                src={`file://${workspace}/${selected.path}`}
                title={selected.baseName}
                sandbox=""
                className="h-full min-h-64 w-full rounded border bg-white"
              />
            ) : loading ? (
              <p className="p-2 text-xs text-muted-foreground">Loading diff…</p>
            ) : (
              <DiffView result={diff} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
