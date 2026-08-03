import { useEffect, useState } from "react"
import { FolderOpen, X } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import type { Project } from "@/types"

// Create or edit a project. A project groups conversations and optionally holds a
// default directory (a workspace): with one, the project can back Interactive and
// North Star (its fresh sessions auto-adopt the directory); without one, it's
// Chat-only. `project` null = create mode; otherwise edit that project.
//
// On save the directory (if any) is upserted into the shared workspaces table so
// the same row backs the project and its conversations. Clearing it passes
// workspaceId: null. `onSaved` lets the caller refetch the sidebar list.
export function ProjectDialog({
  open,
  project,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  project: Project | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [name, setName] = useState("")
  // The chosen directory path (empty = none). Resolved to a workspace id on save.
  const [dir, setDir] = useState("")
  const [saving, setSaving] = useState(false)

  // Seed the form from the project each time the dialog opens (or switches
  // between create/edit). For edit with a directory, resolve the workspace path.
  useEffect(() => {
    if (!open) return
    setName(project?.name ?? "")
    setSaving(false)
    if (project?.workspaceId) {
      window.cowork.db.workspaces.list().then((ws) => {
        const match = ws.find((w) => w.id === project.workspaceId)
        setDir(match?.path ?? "")
      })
    } else {
      setDir("")
    }
  }, [open, project])

  async function pickDir() {
    const picked = await window.cowork.pickWorkspace()
    if (picked.path) setDir(picked.path)
  }

  async function save() {
    const trimmed = name.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      // Resolve the directory to a workspace id (deduped on path). Empty = clear.
      let workspaceId: string | null = null
      if (dir.trim()) {
        const ws = await window.cowork.db.workspaces.upsert(dir.trim())
        workspaceId = ws.id
      }
      if (project) {
        await window.cowork.db.projects.update(project.id, {
          name: trimmed,
          workspaceId,
        })
      } else {
        await window.cowork.db.projects.create({ name: trimmed, workspaceId })
      }
      onSaved()
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  const canSave = !!name.trim() && !saving

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {project ? "Edit project" : "New project"}
          </DialogTitle>
          <DialogDescription>
            Group conversations under a project. A directory is optional — with
            one, the project can be used for Interactive and North Star and new
            sessions start in that folder automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4 py-2">
          <Field>
            <FieldLabel htmlFor="project-name">Name</FieldLabel>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project A"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void save()
                }
              }}
            />
          </Field>
          <Field>
            <FieldLabel>Directory (optional)</FieldLabel>
            <div className="flex w-full items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={pickDir}
              >
                <FolderOpen className="size-4" />
                {dir ? "Change folder" : "Choose folder"}
              </Button>
              {dir && (
                <>
                  <span
                    className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
                    title={dir}
                  >
                    {dir}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    onClick={() => setDir("")}
                    aria-label="Clear directory"
                  >
                    <X className="size-3.5" />
                  </Button>
                </>
              )}
            </div>
            <FieldDescription>
              Without a directory, this project can only be used in Chat.
            </FieldDescription>
          </Field>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={!canSave}>
            {project ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
