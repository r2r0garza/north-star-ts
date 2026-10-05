import { useEffect, useState } from "react"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { GeneratedFilesRule, Workspace } from "@/types"

interface Row {
  paths: string
  command: string
}

const toRows = (rules: GeneratedFilesRule[]): Row[] =>
  rules.map((rule) => ({ paths: rule.paths.join(", "), command: rule.command }))

const toRules = (rows: Row[]): GeneratedFilesRule[] =>
  rows
    .map((row) => ({
      paths: row.paths
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      command: row.command.trim(),
    }))
    .filter((rule) => rule.paths.length && rule.command)

// A workspace's generated files (a code index, a lockfile, codegen output)
// and the command that rebuilds them. When a merge conflicts only on these,
// the merge queue runs the command instead of asking the integrator to merge
// them by hand. Stored on the workspace, so it applies to every feature in it.
export function GeneratedFilesEditor({
  workspace,
  onSaved,
}: {
  workspace: Workspace
  onSaved: (workspace: Workspace) => void
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    toRows(workspace.generatedFiles)
  )
  const [saving, setSaving] = useState(false)
  useEffect(() => setRows(toRows(workspace.generatedFiles)), [workspace])
  const dirty =
    JSON.stringify(toRules(rows)) !== JSON.stringify(workspace.generatedFiles)
  const update = (index: number, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row))
    )
  const save = async () => {
    setSaving(true)
    try {
      onSaved(
        await window.cowork.db.workspaces.update(workspace.id, {
          generatedFiles: toRules(rows),
        })
      )
      toast.success("Generated files saved")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs text-muted-foreground">Generated files</div>
        <p className="text-xs text-muted-foreground">
          When a merge conflicts only on these, the merge queue reruns the
          command instead of merging them by hand. Globs and the command are
          relative to the workspace root. Applies to every feature in{" "}
          {workspace.name || workspace.path}.
        </p>
      </div>
      {rows.map((row, index) => (
        <div key={index} className="flex gap-2">
          <Input
            className="h-8 w-56 font-mono text-xs"
            placeholder=".code-index/**, **/package-lock.json"
            aria-label="Generated file globs"
            value={row.paths}
            onChange={(e) => update(index, { paths: e.target.value })}
          />
          <Input
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            placeholder="Command that rebuilds them"
            aria-label="Regenerate command"
            value={row.command}
            onChange={(e) => update(index, { command: e.target.value })}
          />
          <Button
            size="icon-sm"
            variant="ghost"
            title="Remove"
            onClick={() =>
              setRows((current) => current.filter((_, i) => i !== index))
            }
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setRows((current) => [...current, { paths: "", command: "" }])
          }
        >
          <Plus className="size-4" /> Add
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
