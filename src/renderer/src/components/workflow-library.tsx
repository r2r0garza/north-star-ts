import { MoreHorizontal, Play, Plus, Search, X } from "lucide-react"
import type { WorkflowDefinition } from "../../../shared/workflows"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function WorkflowLibrary({
  workflows,
  loaded,
  loading,
  error,
  creating,
  query,
  onQueryChange,
  onRetry,
  onCreate,
  onImport,
  onEdit,
  onRun,
  onExport,
  onDelete,
}: {
  workflows: WorkflowDefinition[]
  loaded: boolean
  loading: boolean
  error: boolean
  creating: boolean
  query: string
  onQueryChange: (query: string) => void
  onRetry: () => void
  onCreate: () => void
  onImport: () => void
  onEdit: (workflow: WorkflowDefinition) => void
  onRun: (workflow: WorkflowDefinition) => void
  onExport: (workflow: WorkflowDefinition) => void
  onDelete: (workflow: WorkflowDefinition) => void
}) {
  const search = query.trim().toLocaleLowerCase()
  const visible = [...workflows]
    .filter(
      (workflow) =>
        !search ||
        [
          workflow.name,
          workflow.description,
          ...workflow.steps.map((step) => step.title),
        ].some((text) => text.toLocaleLowerCase().includes(search))
    )
    .sort((a, b) =>
      a.name
        .trim()
        .localeCompare(b.name.trim(), undefined, { sensitivity: "base" })
    )
  const empty = loaded && workflows.length === 0
  const actions = (
    <div className="flex shrink-0 items-center gap-2">
      <Button variant="outline" size="sm" disabled={!loaded} onClick={onImport}>
        Import JSON
      </Button>
      <Button size="sm" disabled={!loaded || creating} onClick={onCreate}>
        <Plus className="size-4" />
        {creating ? "Creating…" : "New workflow"}
      </Button>
    </div>
  )

  return (
    <section
      aria-label="Workflow library"
      className="flex h-full min-h-0 flex-col"
    >
      <header className="shrink-0 space-y-4 border-b p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Workflow library</h2>
          {!empty && actions}
        </div>
        {loaded && !empty && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-md">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search workflows"
                placeholder="Search workflows…"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                className="pr-10 pl-9"
              />
              {query && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Clear search"
                  className="absolute top-1/2 right-1 -translate-y-1/2"
                  onClick={() => onQueryChange("")}
                >
                  <X className="size-4" />
                </Button>
              )}
            </div>
            <p role="status" className="text-xs text-muted-foreground">
              {search
                ? `${visible.length} of ${workflows.length}`
                : workflows.length}{" "}
              {workflows.length === 1 ? "workflow" : "workflows"}
            </p>
          </div>
        )}
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {error ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 px-6 py-16 text-center"
          >
            <h3 className="font-medium">Could not load workflows</h3>
            <p className="text-muted-foreground">
              Try loading your library again.
            </p>
            <Button variant="outline" disabled={loading} onClick={onRetry}>
              {loading ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : !loaded ? (
          <p role="status" className="p-5 text-muted-foreground">
            Loading workflows…
          </p>
        ) : empty ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <h3 className="text-base font-semibold">No workflows yet</h3>
            <p className="max-w-sm text-muted-foreground">
              Create a reusable sequence of steps, or import a workflow from a
              JSON file.
            </p>
            {actions}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <h3 className="font-medium">No matching workflows</h3>
            <p className="text-muted-foreground">
              Search by workflow name, description, or step.
            </p>
            <Button variant="outline" onClick={() => onQueryChange("")}>
              Clear search
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-4 p-5">
            {visible.map((workflow) => {
              const name = workflow.name.trim() || "Untitled workflow"
              return (
                <Card
                  key={workflow.id}
                  className="flex min-w-0 flex-col gap-4 p-5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="min-w-0 text-base font-semibold">
                      <button
                        type="button"
                        title={name}
                        className="line-clamp-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => onEdit(workflow)}
                      >
                        {name}
                      </button>
                    </h3>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0"
                          aria-label={`Workflow actions: ${name}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => onExport(workflow)}>
                          Export
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => onDelete(workflow)}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
                    {workflow.description.trim() || "No description yet."}
                  </p>
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {workflow.steps.length
                        ? `${workflow.steps.length} ${workflow.steps.length === 1 ? "step" : "steps"}`
                        : "No steps yet"}
                    </p>
                    {workflow.steps.length ? (
                      <ol className="space-y-2 text-sm">
                        {workflow.steps.slice(0, 3).map((step, index) => (
                          <li
                            key={step.id}
                            className="flex items-baseline gap-3"
                          >
                            <span
                              aria-hidden="true"
                              className="w-3 shrink-0 text-xs text-muted-foreground"
                            >
                              {index + 1}
                            </span>
                            <span className="line-clamp-2">
                              {step.title.trim() || "Untitled step"}
                            </span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Add steps in the editor before running.
                      </p>
                    )}
                    {workflow.steps.length > 3 && (
                      <p className="pl-6 text-xs text-muted-foreground">
                        + {workflow.steps.length - 3} more{" "}
                        {workflow.steps.length === 4 ? "step" : "steps"}
                      </p>
                    )}
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit workflow: ${name}`}
                      onClick={() => onEdit(workflow)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!workflow.steps.length}
                      onClick={() => onRun(workflow)}
                    >
                      <Play className="size-4" />
                      Run workflow
                    </Button>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </section>
  )
}
