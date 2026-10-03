import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { Workspace } from "@/types"
import {
  DEFAULT_CHECKS_DIR,
  normalizeChecksDir,
} from "../../../../shared/mission-control/checks"

// Where QA seats write acceptance checks (plan 109.01). A QA seat may write
// only inside its user story's folder under this directory; it is committed
// with the user story, so checks merge with the code. Stored on the
// workspace, so it applies to every feature in it.
export function ChecksDirEditor({
  workspace,
  onSaved,
}: {
  workspace: Workspace
  onSaved: (workspace: Workspace) => void
}) {
  const saved = workspace.missionControl.checksDir
  const [value, setValue] = useState(saved)
  const [saving, setSaving] = useState(false)
  useEffect(() => setValue(saved), [saved])
  const normalized = normalizeChecksDir(value)
  const dirty = value.trim() !== saved
  const save = async (checksDir: string) => {
    setSaving(true)
    try {
      onSaved(
        await window.cowork.db.workspaces.update(workspace.id, {
          missionControl: { checksDir },
        })
      )
      toast.success("Checks directory saved")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs text-muted-foreground">Checks directory</div>
        <p className="text-xs text-muted-foreground">
          QA seats write acceptance checks here as shared test code (page
          objects, fixtures, and tests by product area, each tagged with its
          user story) and can't write anywhere else. Checks are committed with
          the user story, so you can re-run them like any other tests. Must not
          be ignored by git. Relative to the root of{" "}
          {workspace.name || workspace.path}.
        </p>
      </div>
      <div className="flex gap-2">
        <Input
          className="h-8 w-72 font-mono text-xs"
          placeholder={DEFAULT_CHECKS_DIR}
          aria-label="Checks directory"
          aria-invalid={dirty && !normalized}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {dirty && (
          <Button
            size="sm"
            disabled={saving || !normalized}
            onClick={() => normalized && void save(normalized)}
          >
            Save
          </Button>
        )}
        {!dirty && saved !== DEFAULT_CHECKS_DIR && (
          <Button
            size="sm"
            variant="ghost"
            disabled={saving}
            onClick={() => void save(DEFAULT_CHECKS_DIR)}
          >
            Use default
          </Button>
        )}
      </div>
      {dirty && !normalized && (
        <p className="text-xs text-destructive">
          Use a folder inside the workspace, not the workspace root or .git.
        </p>
      )}
    </div>
  )
}
