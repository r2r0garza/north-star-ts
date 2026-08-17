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

// The upload modal for importing a skill: a dashed drop zone that is both
// click-to-open-native-picker and a drag-and-drop target, a location picker
// (when more than one writable source exists), and the file requirements. Both
// the picker and drop paths converge on skills.import; on success it closes and
// hands the new SKILL.md path back to the caller to select.
//
// A dropped file's disk path comes from window.cowork.getPathForFile — Electron
// 37 removed File.path, so the preload's webUtils bridge is the only source.

// Client-side extension gate (main re-validates). Mirrors the picker's filter.
const ACCEPTED = [".md", ".markdown", ".zip"]

function hasAcceptedExt(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPTED.some((ext) => lower.endsWith(ext))
}

export function SkillUploadModal({
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

  // Run the import for a resolved source path into the current dir.
  async function importFrom(sourcePath: string) {
    if (!dir || importing) return
    if (!hasAcceptedExt(sourcePath)) {
      toast.error("Import a .md (SKILL.md) or a .zip of a skill folder.")
      return
    }
    setImporting(true)
    try {
      const newPath = await window.cowork.skills.import({ sourcePath, dir })
      onImported(newPath, dir)
      onOpenChange(false)
      toast.success("Skill imported")
    } catch (err) {
      toast.error(`Could not import skill: ${err}`)
    } finally {
      setImporting(false)
    }
  }

  // Click the drop zone → native single-select .md/.zip picker.
  async function openPicker() {
    if (importing) return
    let picked: { paths?: string[]; canceled?: boolean }
    try {
      picked = await window.cowork.skills.pickImport()
    } catch (err) {
      toast.error(`Could not open the file picker: ${err}`)
      return
    }
    if (picked.canceled || !picked.paths?.length) return
    await importFrom(picked.paths[0])
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    // Electron 37: no File.path — resolve via the preload webUtils bridge.
    const sourcePath = window.cowork.getPathForFile(file)
    if (!sourcePath) {
      toast.error("Could not read the dropped file's path.")
      return
    }
    void importFrom(sourcePath)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload skill</DialogTitle>
        </DialogHeader>

        {/* Drop zone — click to open the picker, or drag a file onto it. */}
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
              <span className="font-mono">.md</span> file must contain skill name
              and description formatted in YAML
            </li>
            <li>
              <span className="font-mono">.zip</span> file must include a{" "}
              <span className="font-mono">SKILL.md</span> file
            </li>
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  )
}
