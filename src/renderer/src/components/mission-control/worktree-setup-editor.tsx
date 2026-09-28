import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Workspace } from "@/types"

// How each user story's worktree gets a working environment. A worktree has
// only tracked files, so an ignored .venv or node_modules is missing there;
// link them from the main checkout, and/or run a setup command in each new
// worktree. Stored on the workspace, so it applies to every feature in it.
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
  const [command, setCommand] = useState(workspace.worktreeSetup.command)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setLinks(workspace.worktreeSetup.linkPaths.join(", "))
    setCommand(workspace.worktreeSetup.command)
  }, [workspace])
  const linkPaths = links
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  const dirty =
    JSON.stringify(linkPaths) !==
      JSON.stringify(workspace.worktreeSetup.linkPaths) ||
    command.trim() !== workspace.worktreeSetup.command
  const save = async () => {
    setSaving(true)
    try {
      onSaved(
        await window.cowork.db.workspaces.update(workspace.id, {
          worktreeSetup: { linkPaths, command: command.trim() },
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
          them), and/or run a setup command in each new worktree. Paths and the
          command are relative to the workspace root.
        </p>
      </div>
      <div className="flex gap-2">
        <Input
          className="h-8 w-56 font-mono text-xs"
          placeholder=".venv, node_modules"
          aria-label="Paths to link from the main checkout"
          value={links}
          onChange={(e) => setLinks(e.target.value)}
        />
        <Input
          className="h-8 min-w-0 flex-1 font-mono text-xs"
          placeholder="Setup command, e.g. pnpm install --frozen-lockfile"
          aria-label="Setup command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
        {dirty && (
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            Save
          </Button>
        )}
      </div>
    </div>
  )
}
