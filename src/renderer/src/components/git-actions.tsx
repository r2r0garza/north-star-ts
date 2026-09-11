import * as React from "react"
import { Check, ChevronDown, GitBranch, LoaderCircle } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Textarea } from "@/components/ui/textarea"
import type { GitStatusEntry } from "@/types"
import { useGitStatus } from "@/lib/git-status"
import { runGitMutation, useGitMutationBusy } from "@/lib/git-operation"

function committable(entry: GitStatusEntry) {
  return entry.kind !== "ignored" && entry.kind !== "unmerged"
}

function statusLabel(entry: GitStatusEntry) {
  if (entry.kind === "untracked") return "Untracked"
  if (entry.kind === "unmerged") return "Conflict"
  if (entry.kind === "renamed") return "Renamed"
  if (entry.index === "D" || entry.worktree === "D") return "Deleted"
  if (entry.index === "A") return "Added"
  return "Modified"
}

type RepositoryStatus =
  | "checking"
  | "unavailable"
  | "clean"
  | "changes"
  | "conflict"

function repositoryStatus(entries: GitStatusEntry[]): RepositoryStatus {
  if (entries.some((entry) => entry.kind === "unmerged")) return "conflict"
  if (entries.some((entry) => entry.kind !== "ignored")) return "changes"
  return "clean"
}

export function pushLabel(ahead: number | undefined): string {
  return ahead && ahead > 0 ? `Push (${ahead})` : "Push"
}

const STATUS_LIGHT: Record<
  RepositoryStatus,
  { className: string; label: string }
> = {
  checking: {
    className: "bg-muted-foreground/50",
    label: "Checking Git status",
  },
  unavailable: {
    className: "bg-muted-foreground/50",
    label: "Not a Git repository",
  },
  clean: {
    className: "bg-emerald-500",
    label: "Working tree clean",
  },
  changes: {
    className: "bg-amber-500",
    label: "Uncommitted changes",
  },
  conflict: {
    className: "bg-destructive",
    label: "Merge conflicts need attention",
  },
}

export function GitActions({
  workspace,
  rightOffset,
}: {
  workspace: string
  rightOffset: number
}) {
  const gitStatus = useGitStatus(workspace)
  const repoStatus: RepositoryStatus = gitStatus.loading
    ? "checking"
    : !gitStatus.status?.isRepo
      ? "unavailable"
      : repositoryStatus(gitStatus.status.entries)
  const [busy, setBusy] = React.useState<"fetch" | "pull" | "push" | null>(null)
  const mutationBusy = useGitMutationBusy(workspace)
  const [commitOpen, setCommitOpen] = React.useState(false)
  const [error, setError] = React.useState<{
    title: string
    message: string
  } | null>(null)

  const action = async (kind: "fetch" | "pull" | "push") => {
    setBusy(kind)
    try {
      const result = await runGitMutation(workspace, () =>
        window.cowork.git[kind](workspace)
      )
      if (!result.ok)
        setError({
          title: `${kind[0].toUpperCase()}${kind.slice(1)} failed`,
          message: result.error,
        })
      else {
        toast.success(result.summary)
        window.dispatchEvent(new Event("git-state-changed"))
      }
    } finally {
      setBusy(null)
    }
  }

  if (!workspace) return null
  const statusLight = STATUS_LIGHT[repoStatus]
  return (
    <>
      <div
        className="pointer-events-auto absolute top-2 z-10 transition-[right] duration-200 ease-linear [-webkit-app-region:no-drag]"
        style={{ right: rightOffset }}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={repoStatus === "unavailable" || mutationBusy}
              title={
                repoStatus === "unavailable"
                  ? "This folder is not a Git repository"
                  : `${statusLight.label}. Git actions`
              }
              aria-label={`${statusLight.label}. Git actions`}
              className="relative flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <GitBranch className="size-4" />
              )}
              <span
                aria-hidden="true"
                className={`absolute top-0.5 right-0.5 size-1.5 rounded-full ring-2 ring-background ${statusLight.className}`}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void action("fetch")}>
              Fetch
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void action("pull")}>
              Pull
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setCommitOpen(true)}>
              Commit…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void action("push")}>
              {pushLabel(gitStatus.status?.ahead)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CommitDialog
        workspace={workspace}
        open={commitOpen}
        onOpenChange={setCommitOpen}
        onError={setError}
      />
      <ErrorDialog error={error} onClose={() => setError(null)} />
    </>
  )
}

function CommitDialog({
  workspace,
  open,
  onOpenChange,
  onError,
}: {
  workspace: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onError: (error: { title: string; message: string }) => void
}) {
  const [entries, setEntries] = React.useState<GitStatusEntry[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [expanded, setExpanded] = React.useState({
    tracked: true,
    untracked: true,
  })
  const [message, setMessage] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [asking, setAsking] = React.useState(false)
  const [committing, setCommitting] = React.useState(false)
  const [aiError, setAiError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setAiError(null)
    setMessage("")
    void window.cowork.git
      .status(workspace)
      .then((status) => {
        if (cancelled) return
        const next =
          status?.entries.filter((entry) => entry.kind !== "ignored") ?? []
        setEntries(next)
        setSelected(new Set())
      })
      .catch(() => {
        if (!cancelled) setEntries([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, workspace])

  const groups = {
    tracked: entries.filter((entry) => entry.kind !== "untracked"),
    untracked: entries.filter((entry) => entry.kind === "untracked"),
  }
  const toggleGroup = (kind: "tracked" | "untracked", checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      groups[kind]
        .filter(committable)
        .forEach((entry) =>
          checked ? next.add(entry.path) : next.delete(entry.path)
        )
      return next
    })
  const askAi = async () => {
    setAsking(true)
    setAiError(null)
    try {
      const result = await window.cowork.git.generateCommitMessage(workspace, [
        ...selected,
      ])
      if (result.ok) setMessage(result.commitMessage)
      else setAiError(result.error)
    } finally {
      setAsking(false)
    }
  }
  const commit = async () => {
    setCommitting(true)
    try {
      const result = await runGitMutation(workspace, () =>
        window.cowork.git.commit(workspace, [...selected], message)
      )
      if (!result.ok) {
        onError({ title: "Commit failed", message: result.error })
        return
      }
      toast.success(`Committed ${result.sha}: ${result.subject}`)
      onOpenChange(false)
      window.dispatchEvent(new Event("git-state-changed"))
    } finally {
      setCommitting(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Commit changes</DialogTitle>
          <DialogDescription>
            Select complete files to include in this commit. Existing staged
            work outside your selection is preserved.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-2 overflow-auto rounded-md border p-2">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading changes…</p>
          ) : (
            (["tracked", "untracked"] as const).map((kind) => (
              <FileGroup
                key={kind}
                title={kind === "tracked" ? "Tracked" : "Untracked"}
                entries={groups[kind]}
                selected={selected}
                expanded={expanded[kind]}
                onExpanded={() =>
                  setExpanded((value) => ({ ...value, [kind]: !value[kind] }))
                }
                onSelect={(path, checked) =>
                  setSelected((current) => {
                    const next = new Set(current)
                    checked ? next.add(path) : next.delete(path)
                    return next
                  })
                }
                onSelectAll={(checked) => toggleGroup(kind, checked)}
              />
            ))
          )}
        </div>
        <Textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Commit message"
          rows={4}
        />
        {aiError && <p className="text-sm text-destructive">{aiError}</p>}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => void askAi()}
            disabled={asking || selected.size === 0}
          >
            {asking && <LoaderCircle className="animate-spin" />}Ask AI
          </Button>
          <Button
            type="button"
            onClick={() => void commit()}
            disabled={committing || selected.size === 0 || !message.trim()}
          >
            {committing && <LoaderCircle className="animate-spin" />}Commit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FileGroup({
  title,
  entries,
  selected,
  expanded,
  onExpanded,
  onSelect,
  onSelectAll,
}: {
  title: string
  entries: GitStatusEntry[]
  selected: Set<string>
  expanded: boolean
  onExpanded: () => void
  onSelect: (path: string, checked: boolean) => void
  onSelectAll: (checked: boolean) => void
}) {
  const eligible = entries.filter(committable)
  const count = eligible.filter((entry) => selected.has(entry.path)).length
  return (
    <section className="rounded border">
      <div className="flex items-center gap-2 p-2">
        <Checkbox
          checked={
            count === 0
              ? false
              : count === eligible.length
                ? true
                : "indeterminate"
          }
          disabled={eligible.length === 0}
          onCheckedChange={(value) => onSelectAll(value === true)}
        />
        <button
          type="button"
          onClick={onExpanded}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-sm font-medium"
        >
          <ChevronDown className={expanded ? "size-4" : "size-4 -rotate-90"} />
          {title}{" "}
          <span className="text-muted-foreground">
            {count}/{eligible.length}
          </span>
        </button>
      </div>
      {expanded && (
        <div className="border-t">
          {entries.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              No {title.toLowerCase()} changes.
            </p>
          ) : (
            entries.map((entry) => (
              <label
                key={entry.path}
                className="flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox
                  checked={selected.has(entry.path)}
                  disabled={!committable(entry)}
                  onCheckedChange={(value) =>
                    onSelect(entry.path, value === true)
                  }
                />
                <span className="min-w-16 text-xs text-muted-foreground">
                  {statusLabel(entry)}
                </span>
                <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                {entry.kind === "unmerged" && (
                  <span className="text-xs text-destructive">
                    Resolve first
                  </span>
                )}
              </label>
            ))
          )}
        </div>
      )}
    </section>
  )
}

function ErrorDialog({
  error,
  onClose,
}: {
  error: { title: string; message: string } | null
  onClose: () => void
}) {
  return (
    <Dialog open={!!error} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{error?.title}</DialogTitle>
          <DialogDescription>
            Git did not complete the requested action.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-72 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap select-text">
          {error?.message}
        </pre>
        <DialogFooter>
          <Button onClick={onClose}>
            <Check />
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
