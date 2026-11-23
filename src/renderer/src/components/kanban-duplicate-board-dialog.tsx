import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function DuplicateBoardDialog({
  boardId,
  initialName,
  onOpenChange,
  onEdit,
  onCreated,
}: {
  boardId: string
  initialName: string
  onOpenChange: (open: boolean) => void
  onEdit: (name: string) => void
  onCreated: (boardId: string) => void
}) {
  const [name, setName] = useState(initialName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  function valid() {
    if (name.trim()) return true
    setError("Enter a name for the duplicate board.")
    return false
  }
  async function save() {
    if (!valid()) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.cowork.kanban.duplicate(boardId, name)
      if (!result.ok) return setError(result.reason)
      onCreated(result.boardId)
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Duplicate board</DialogTitle>
          <DialogDescription>
            Copy this board’s workflow and settings, without cards or run
            history. Would you like to edit its intake settings? The copy
            requires fresh intake approval.
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor="duplicate-name">Name</Label>
        <Input
          id="duplicate-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (valid()) onEdit(name.trim())
            }}
          >
            Edit intake settings
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            Keep intake and duplicate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
