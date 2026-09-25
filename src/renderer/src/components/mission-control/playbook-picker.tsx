import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { PlaybookAltitude, PlaybookWithHooks } from "@/types"

const DEFAULT = "default"

// Chooses the playbook an initiative, mission, or slice runs. Unset means the
// runner's default for that altitude: the first playbook by name, created from
// the shipped template when none exists (see ensureDefaultPlaybook).
export function PlaybookPicker({
  altitude,
  value,
  onChange,
}: {
  altitude: PlaybookAltitude
  value: string | null
  onChange: (playbookId: string | null) => Promise<void>
}) {
  const [options, setOptions] = useState<PlaybookWithHooks[]>([])
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    void window.cowork.missionControl.playbooks
      .list()
      .then((all) => setOptions(all.filter((p) => p.altitude === altitude)))
  }, [altitude])
  // The runner's default is the first playbook by name, so it's offered once
  // as "Default" rather than again as its own entry. A row pinned to it
  // explicitly reads as Default too, since both resolve to the same playbook.
  const [fallback, ...others] = options
  const selected = !value || value === fallback?.id ? DEFAULT : value
  return (
    <div className="space-y-1">
      <Label>Playbook</Label>
      <Select
        value={selected}
        disabled={saving}
        onValueChange={(next) => {
          if (next === selected) return
          setSaving(true)
          void onChange(next === DEFAULT ? null : next)
            .catch((error) =>
              toast.error(
                (error instanceof Error ? error.message : String(error))
                  .replace(/^Error invoking remote method '[^']+':\s*/, "")
                  .replace(/^Error:\s*/, "")
              )
            )
            .finally(() => setSaving(false))
        }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>
            Default ({fallback?.name ?? "created on first run"})
          </SelectItem>
          {others.map((playbook) => (
            <SelectItem key={playbook.id} value={playbook.id}>
              {playbook.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
