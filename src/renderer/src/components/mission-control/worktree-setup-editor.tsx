import { useEffect, useState } from "react"
import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Workspace, WorktreeSetupStep } from "@/types"

// How each user story's worktree gets a working environment. A worktree has
// only tracked files, so an ignored .venv or node_modules is missing there;
// link them from the main checkout, and/or run setup steps in each new
// worktree, in order (plan 106.11). Stored on the workspace, so it applies to
// every feature in it.

let nextId = 0
function newStepId() {
  nextId += 1
  return `user-${Date.now().toString(36)}-${nextId}`
}

function same(a: WorktreeSetupStep[], b: WorktreeSetupStep[]) {
  const shape = (steps: WorktreeSetupStep[]) =>
    JSON.stringify(
      steps.map((s) => [s.id, s.label.trim(), s.command.trim(), s.cwd.trim()])
    )
  return shape(a) === shape(b)
}

export function WorktreeSetupEditor({
  workspace,
  onSaved,
}: {
  workspace: Workspace
  onSaved: (workspace: Workspace) => void
}) {
  const [links, setLinks] = useState(
    workspace.worktreeSetup.linkPaths.join(", ")
  )
  const [steps, setSteps] = useState<WorktreeSetupStep[]>(
    workspace.worktreeSetup.steps
  )
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setLinks(workspace.worktreeSetup.linkPaths.join(", "))
    setSteps(workspace.worktreeSetup.steps)
  }, [workspace])
  const linkPaths = links
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  const dirty =
    JSON.stringify(linkPaths) !==
      JSON.stringify(workspace.worktreeSetup.linkPaths) ||
    !same(steps, workspace.worktreeSetup.steps)
  const update = (index: number, patch: Partial<WorktreeSetupStep>) =>
    setSteps((current) =>
      current.map((step, i) =>
        i === index
          ? {
              ...step,
              ...patch,
              // Editing an analysis step makes it the user's.
              source:
                patch.command !== undefined || patch.cwd !== undefined
                  ? "user"
                  : step.source,
            }
          : step
      )
    )
  const move = (index: number, by: number) =>
    setSteps((current) => {
      const next = [...current]
      const [step] = next.splice(index, 1)
      next.splice(index + by, 0, step)
      return next
    })
  const save = async () => {
    setSaving(true)
    try {
      onSaved(
        await window.cowork.db.workspaces.update(workspace.id, {
          worktreeSetup: {
            linkPaths,
            steps: steps
              .filter((s) => s.command.trim())
              .map((s) => ({
                ...s,
                label: s.label.trim() || s.command.trim(),
                command: s.command.trim(),
                cwd: s.cwd.trim(),
              })),
          },
        })
      )
      toast.success("Worktree environment saved")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs text-muted-foreground">
          Worktree environment
        </div>
        <p className="text-xs text-muted-foreground">
          Each user story runs in its own worktree, which has only tracked
          files. Link ignored paths from the main checkout (fast, if it has
          them), and/or run setup steps in each new worktree, in order. A failed
          step stops the ones after it. Paths and directories are relative to
          the workspace root.
        </p>
      </div>
      <Input
        className="h-8 w-full font-mono text-xs"
        placeholder=".venv, node_modules"
        aria-label="Paths to link from the main checkout"
        value={links}
        onChange={(e) => setLinks(e.target.value)}
      />
      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li
            key={step.id}
            className="flex flex-wrap items-center gap-2 rounded-md border p-2"
          >
            <span className="w-5 text-center text-xs text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <Input
              className="h-8 w-44 text-xs"
              placeholder="Label"
              aria-label={`Step ${index + 1} label`}
              value={step.label}
              onChange={(e) => update(index, { label: e.target.value })}
            />
            {step.kind === "python-shared-venv" ? (
              // Built in: not a shell command, so not edited as one.
              <div
                className="min-w-40 flex-1 text-xs text-muted-foreground"
                title={[
                  `Without a usable ${step.venv ?? ".venv"} in the main checkout: ${(step.fallback ?? []).map((c) => c.command).join(" → ") || "nothing"}`,
                  `When a story's dependencies differ: ${(step.refresh ?? []).map((c) => c.command).join(" → ") || "nothing"}`,
                ].join("\n")}
              >
                Built in: a thin {step.venv ?? ".venv"} per worktree that reuses
                this checkout's installed packages
                {step.cwd ? ` (in ${step.cwd}/)` : ""}
              </div>
            ) : (
              <>
                <Input
                  className="h-8 min-w-40 flex-1 font-mono text-xs"
                  placeholder="Command, e.g. pnpm install --frozen-lockfile"
                  aria-label={`Step ${index + 1} command`}
                  value={step.command}
                  onChange={(e) => update(index, { command: e.target.value })}
                />
                <Input
                  className="h-8 w-28 font-mono text-xs"
                  placeholder="Directory"
                  aria-label={`Step ${index + 1} directory`}
                  value={step.cwd}
                  onChange={(e) => update(index, { cwd: e.target.value })}
                />
              </>
            )}
            {step.source === "analysis" && (
              <Badge
                variant="secondary"
                className="gap-1"
                title="Added from a workspace setup finding"
              >
                <Sparkles className="size-3" /> Suggested
              </Badge>
            )}
            <div className="ml-auto flex">
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={index === 0}
                aria-label={`Move step ${index + 1} up`}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={index === steps.length - 1}
                aria-label={`Move step ${index + 1} down`}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Remove step ${index + 1}`}
                onClick={() =>
                  setSteps((current) => current.filter((_, i) => i !== index))
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setSteps((current) => [
              ...current,
              {
                id: newStepId(),
                label: "",
                command: "",
                cwd: "",
                source: "user",
              },
            ])
          }
        >
          <Plus className="size-4" /> Add step
        </Button>
        {dirty && (
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            Save
          </Button>
        )}
      </div>
    </div>
  )
}
