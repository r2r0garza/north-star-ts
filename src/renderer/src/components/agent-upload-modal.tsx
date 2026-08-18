import { useEffect, useState } from "react"
import { FolderPlus } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select"
import { toast } from "sonner"

// The upload modal for importing one-or-more agents: a dashed drop zone that is
// both click-to-open-native-picker and a drag-and-drop target, a location picker
// (when more than one writable source exists), and the file requirements. Both
// the picker and drop paths converge on a best-effort loop over agents.import;
// on success it closes and hands the first new path back to the caller to select.
//
// A dropped file's disk path comes from window.cowork.getPathForFile — Electron
// 37 removed File.path, so the preload's webUtils bridge is the only source.

// Client-side extension gate (main re-validates). An agent is a flat `.agent.md`.
const ACCEPTED = [".agent.md"]

function hasAcceptedExt(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPTED.some((ext) => lower.endsWith(ext))
}

export function AgentUploadModal({
  open,
  onOpenChange,
  writableDirs,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  writableDirs: Array<{ path: string; label: string }>
  onImported: (newPath: string, dir: string) => void
}) {
  // The chosen target dir. Seeded to the first writable dir when the modal opens.
  const [dir, setDir] = useState("")
  const [importing, setImporting] = useState(false)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!open) return
    setDir(writableDirs[0]?.path ?? "")
    setImporting(false)
    setDragging(false)
  }, [open, writableDirs])

  // Import each source path into the current dir, best-effort: a bad file is
  // rejected with its own message; the rest still land. Aggregates the outcome
  // into success/failure toasts and selects the first agent that landed.
  async function importAll(sourcePaths: string[]) {
    if (!dir || importing || sourcePaths.length === 0) return
    setImporting(true)
    try {
      let firstNewPath: string | null = null
      let imported = 0
      const failures: string[] = []
      for (const sourcePath of sourcePaths) {
        const base = sourcePath.split(/[\\/]/).pop() ?? sourcePath
        if (!hasAcceptedExt(sourcePath)) {
          failures.push(`${base} — not a .agent.md file`)
          continue
        }
        try {
          const newPath = await window.cowork.agents.import({ sourcePath, dir })
          if (!firstNewPath) firstNewPath = newPath
          imported++
        } catch (err) {
          failures.push(`${base} — ${err instanceof Error ? err.message : err}`)
        }
      }

      if (imported > 0) {
        toast.success(
          imported === 1 ? "Agent imported" : `Imported ${imported} agents`
        )
      }
      if (failures.length > 0) {
        toast.error(
          `${failures.length} failed: ${failures.join("; ")}`
        )
      }
      if (firstNewPath) {
        onImported(firstNewPath, dir)
        onOpenChange(false)
      }
    } finally {
      setImporting(false)
    }
  }

  // Click the drop zone → native multi-select .agent.md picker.
  async function openPicker() {
    if (importing) return
    let picked: { paths?: string[]; canceled?: boolean }
    try {
      picked = await window.cowork.agents.pickImport()
    } catch (err) {
      toast.error(`Could not open the file picker: ${err}`)
      return
    }
    if (picked.canceled || !picked.paths?.length) return
    await importAll(picked.paths)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length === 0) return
    // Electron 37: no File.path — resolve via the preload webUtils bridge.
    const sourcePaths = files
      .map((f) => window.cowork.getPathForFile(f))
      .filter((p): p is string => Boolean(p))
    if (sourcePaths.length === 0) {
      toast.error("Could not read the dropped file's path.")
      return
    }
    void importAll(sourcePaths)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import agents</DialogTitle>
        </DialogHeader>

        {/* Drop zone — click to open the picker, or drag files onto it. */}
        <button
          type="button"
          onClick={openPicker}
          disabled={importing || !dir}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={
            "flex w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center transition-colors disabled:opacity-50 " +
            (dragging
              ? "border-ring bg-accent/50"
              : "border-input hover:bg-accent/30")
          }
        >
          <FolderPlus className="size-7 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {importing
              ? "Importing…"
              : "Drag and drop or click to upload"}
          </span>
        </button>

        {writableDirs.length > 1 && (
          <div className="space-y-1.5">
            <Label className="text-sm">Location</Label>
            <NativeSelect
              className="w-full"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
            >
              {writableDirs.map((d) => (
                <NativeSelectOption key={d.path} value={d.path}>
                  {d.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}

        <div className="space-y-1 text-sm">
          <p className="font-medium">File requirements</p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>
              <span className="font-mono">.agent.md</span> file with{" "}
              <span className="font-mono">name</span> and{" "}
              <span className="font-mono">description</span> in YAML frontmatter
            </li>
            <li>
              the frontmatter <span className="font-mono">name</span> must match
              the filename (e.g. <span className="font-mono">planner</span> →{" "}
              <span className="font-mono">planner.agent.md</span>)
            </li>
            <li>select multiple files to import several at once</li>
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  )
}
