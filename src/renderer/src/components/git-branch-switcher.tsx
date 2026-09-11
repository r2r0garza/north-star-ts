import * as React from "react"
import { Check, GitBranch, LoaderCircle, Plus, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { useGitStatus } from "@/lib/git-status"
import { runGitMutation, useGitMutationBusy } from "@/lib/git-operation"
import type { GitBranchEntry, GitBranchesResult } from "@/types"
import { cn } from "@/lib/utils"

export const BRANCH_NAME_MAX_LENGTH = 255

export function filterBranches(
  branches: GitBranchEntry[],
  query: string
): GitBranchEntry[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return branches
  return branches.filter((branch) =>
    branch.name.toLocaleLowerCase().includes(normalized)
  )
}

export function branchNameError(value: string): string | null {
  const name = value.trim()
  if (!name) return "Enter a branch name."
  if (name.length > BRANCH_NAME_MAX_LENGTH)
    return `Branch names must be at most ${BRANCH_NAME_MAX_LENGTH} characters.`
  if (
    name.startsWith("-") ||
    name.startsWith("refs/") ||
    /[\0-\x1f\x7f]/.test(name)
  )
    return "Enter a valid local branch name."
  if (
    /\.\.|@\{|[ ~^:?*\\]/.test(name) ||
    name.endsWith(".") ||
    name.endsWith("/")
  )
    return "Enter a valid local branch name."
  return null
}

export type BranchPickerOption =
  | { kind: "branch"; name: string; current: boolean }
  | { kind: "create"; name: string; error: string | null }

export function branchPickerOptions(
  branches: GitBranchEntry[],
  query: string
): BranchPickerOption[] {
  const name = query.trim()
  const options: BranchPickerOption[] = filterBranches(branches, query).map(
    (branch) => ({ kind: "branch", ...branch })
  )
  const exactMatch = branches.some(
    (branch) => branch.name.toLocaleLowerCase() === name.toLocaleLowerCase()
  )
  if (name && !exactMatch) {
    options.push({ kind: "create", name, error: branchNameError(name) })
  }
  return options
}

type GitError = { title: string; message: string } | null

export function GitBranchSwitcher({
  workspace,
  compact,
}: {
  workspace: string
  compact: boolean
}) {
  const gitStatus = useGitStatus(workspace)
  const mutationBusy = useGitMutationBusy(workspace)
  const [open, setOpen] = React.useState(false)
  const [branches, setBranches] = React.useState<GitBranchesResult | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [listError, setListError] = React.useState<string | null>(null)
  const [search, setSearch] = React.useState("")
  const [highlightedIndex, setHighlightedIndex] = React.useState(0)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const [error, setError] = React.useState<GitError>(null)
  const request = React.useRef(0)
  const workspaceRef = React.useRef(workspace)
  workspaceRef.current = workspace

  const branch = gitStatus.status?.isRepo
    ? (gitStatus.status.branch ?? gitStatus.status.sha ?? null)
    : null
  const options = React.useMemo(
    () => branchPickerOptions(branches?.branches ?? [], search),
    [branches, search]
  )
  const highlightedOption = options[highlightedIndex]

  React.useEffect(() => {
    request.current += 1
    setOpen(false)
    setBranches(null)
    setListError(null)
    setSearch("")
    setHighlightedIndex(0)
    setError(null)
  }, [workspace])

  React.useEffect(() => {
    setHighlightedIndex(0)
  }, [options.length, search])

  const load = React.useCallback(async () => {
    const sequence = ++request.current
    setLoading(true)
    setListError(null)
    try {
      const result = await window.cowork.git.branches(workspace)
      if (sequence !== request.current) return
      setBranches(result)
      if (!result.isRepo) setListError("This folder is not a Git repository.")
    } catch {
      if (sequence === request.current)
        setListError("Could not load local branches.")
    } finally {
      if (sequence === request.current) setLoading(false)
    }
  }, [workspace])

  const switchBranch = async (name: string) => {
    const activeWorkspace = workspace
    setOpen(false)
    try {
      const result = await runGitMutation(activeWorkspace, () =>
        window.cowork.git.switchBranch(activeWorkspace, name)
      )
      if (activeWorkspace !== workspaceRef.current) return
      if (!result.ok) {
        setError({ title: "Switch branch failed", message: result.error })
        return
      }
      branchChanged(activeWorkspace, "branch-switched")
    } catch {
      if (activeWorkspace === workspaceRef.current) {
        setError({
          title: "Switch branch failed",
          message: "Git operation failed.",
        })
      }
    }
  }

  const createBranch = async (name: string) => {
    if (branchNameError(name) || mutationBusy) return
    const activeWorkspace = workspace
    setOpen(false)
    try {
      const result = await runGitMutation(activeWorkspace, () =>
        window.cowork.git.createBranch(activeWorkspace, name)
      )
      if (activeWorkspace !== workspaceRef.current) return
      if (!result.ok) {
        setError({ title: "Create branch failed", message: result.error })
        return
      }
      branchChanged(activeWorkspace, "branch-created")
    } catch {
      if (activeWorkspace === workspaceRef.current) {
        setError({
          title: "Create branch failed",
          message: "Git operation failed.",
        })
      }
    }
  }

  const activateOption = (option: BranchPickerOption | undefined) => {
    if (!option || mutationBusy) return
    if (option.kind === "branch") {
      if (!option.current) void switchBranch(option.name)
      return
    }
    if (!option.error) void createBranch(option.name)
  }

  if (!branch) return null
  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          setSearch("")
          setHighlightedIndex(0)
          if (next) {
            void load()
            window.requestAnimationFrame(() => searchRef.current?.focus())
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={mutationBusy}
            title={branch}
            aria-label={`Current Git branch: ${branch}. Choose branch`}
            className={cn(
              "flex items-center rounded bg-accent font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
              compact ? "p-1" : "max-w-48 gap-1 px-1.5 py-0.5"
            )}
          >
            {mutationBusy ? (
              <LoaderCircle className="size-3 shrink-0 animate-spin" />
            ) : (
              <GitBranch className="size-3 shrink-0" />
            )}
            {!compact && <span className="truncate">{branch}</span>}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <div
            className="relative p-1"
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.preventDefault()
                event.stopPropagation()
                setSearch("")
                return
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                event.stopPropagation()
                if (!options.length) return
                const direction = event.key === "ArrowDown" ? 1 : -1
                setHighlightedIndex(
                  (index) =>
                    (index + direction + options.length) % options.length
                )
                return
              }
              if (event.key === "Enter") {
                event.preventDefault()
                event.stopPropagation()
                activateOption(highlightedOption)
                return
              }
              if (
                event.key.length === 1 ||
                [
                  "Backspace",
                  "Delete",
                  "Home",
                  "End",
                  "ArrowLeft",
                  "ArrowRight",
                ].includes(event.key)
              )
                event.stopPropagation()
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find or create a branch…"
              aria-label="Find or create a local branch"
              aria-activedescendant={
                highlightedOption
                  ? `branch-picker-option-${highlightedIndex}`
                  : undefined
              }
              className="h-8 pr-8 pl-8 text-xs"
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch("")
                  searchRef.current?.focus()
                }}
                aria-label="Clear branch search"
                className="absolute top-1/2 right-2.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          <DropdownMenuSeparator />
          {loading && (
            <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              Loading branches…
            </div>
          )}
          {!loading && listError && (
            <div className="px-2 py-2 text-xs text-destructive">
              {listError}
            </div>
          )}
          {!loading && branches?.detached && (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              HEAD is detached at {branches.current}. Choose a branch or create
              one from this commit.
            </div>
          )}
          {!loading && branches?.isRepo && options.length === 0 && (
            <div className="px-2 py-2 text-xs text-muted-foreground">
              {search.trim()
                ? `No branches match “${search.trim()}”.`
                : "No local branches."}
            </div>
          )}
          {!loading &&
            options.map((option, index) => {
              const disabled =
                mutationBusy ||
                (option.kind === "branch" ? option.current : !!option.error)
              return (
                <DropdownMenuItem
                  id={`branch-picker-option-${index}`}
                  key={`${option.kind}:${option.name}`}
                  disabled={disabled}
                  onPointerMove={() => setHighlightedIndex(index)}
                  onFocus={() => setHighlightedIndex(index)}
                  onSelect={() => activateOption(option)}
                  title={
                    option.kind === "create"
                      ? (option.error ?? option.name)
                      : option.name
                  }
                  className={cn(index === highlightedIndex && "bg-accent")}
                >
                  {option.kind === "branch" ? (
                    <>
                      <Check
                        className={option.current ? "opacity-100" : "opacity-0"}
                      />
                      <span className="truncate font-mono text-xs">
                        {option.name}
                      </span>
                    </>
                  ) : (
                    <>
                      <Plus />
                      <span className="min-w-0 text-xs">
                        Create new branch: “
                        <span className="font-mono">{option.name}</span>”
                      </span>
                    </>
                  )}
                </DropdownMenuItem>
              )
            })}
          {!loading &&
            highlightedOption?.kind === "create" &&
            highlightedOption.error && (
              <div className="px-2 py-1.5 text-xs text-destructive">
                {highlightedOption.error}
              </div>
            )}
          {!loading && branches?.truncated && (
            <div className="border-t px-2 py-2 text-xs text-muted-foreground">
              Showing the first 200 local branches.
            </div>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <BranchErrorDialog error={error} onClose={() => setError(null)} />
    </>
  )
}

function BranchErrorDialog({
  error,
  onClose,
}: {
  error: GitError
  onClose: () => void
}) {
  return (
    <Dialog open={!!error} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{error?.title}</DialogTitle>
          <DialogDescription>
            Git left the repository unchanged.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-72 overflow-auto rounded-md border bg-muted p-3 text-xs whitespace-pre-wrap select-text">
          {error?.message}
        </pre>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function branchChanged(
  workspace: string,
  reason: "branch-switched" | "branch-created"
) {
  window.dispatchEvent(
    new CustomEvent("git-state-changed", { detail: { workspace, reason } })
  )
}
