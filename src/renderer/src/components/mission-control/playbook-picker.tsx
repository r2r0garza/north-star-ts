import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Label } from "@/components/ui/label"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  PlaybookAltitude,
  PlaybookDefaultDiff,
  PlaybookStepChange,
  PlaybookWithHooks,
} from "@/types"

const DEFAULT = "default"

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^Error:\s*/, "")
}

// Chooses the playbook a feature, milestone, or user story runs. Unset means the
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
  const [diff, setDiff] = useState<PlaybookDefaultDiff | null>(null)
  const load = () =>
    window.cowork.missionControl.playbooks
      .list()
      .then((all) => setOptions(all.filter((p) => p.altitude === altitude)))
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            .catch((error) => toast.error(errorText(error)))
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
      {/* Plan 109.02: a default created before the shipped template changed
          keeps its steps (they're user data) until the user resets it. */}
      {selected === DEFAULT && fallback && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
          disabled={saving}
          onClick={() =>
            void window.cowork.missionControl.playbooks
              .defaultDiff(fallback.id)
              .then((next) =>
                next.differs
                  ? setDiff(next)
                  : toast.success(
                      `${fallback.name} already matches the default.`
                    )
              )
              .catch((error) => toast.error(errorText(error)))
          }
        >
          Reset to default…
        </button>
      )}
      <AlertDialog
        open={diff !== null}
        onOpenChange={(open) => !open && setDiff(null)}
      >
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reset “{diff?.name.current}” to the default?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its steps are replaced with the shipped default. Everything that
              uses this playbook keeps using it. Runs already in progress are
              unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {diff && <PlaybookDiff diff={diff} />}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const id = diff!.playbookId
                setSaving(true)
                void window.cowork.missionControl.playbooks
                  .resetToDefault(id)
                  .then(async (playbook) => {
                    await load()
                    toast.success(`Reset to ${playbook.name}.`)
                  })
                  .catch((error) => toast.error(errorText(error)))
                  .finally(() => setSaving(false))
              }}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const FIELD_LABELS: Record<string, string> = {
  name: "instruction",
  role: "role",
  proofStep: "proof step",
  validator: "validator",
  contextScope: "context",
}

function StepLine({ change }: { change: PlaybookStepChange }) {
  const { step } = change
  const mark =
    change.change === "added"
      ? { sign: "+", className: "text-emerald-600 dark:text-emerald-400" }
      : change.change === "removed"
        ? { sign: "−", className: "text-destructive line-through" }
        : change.change === "changed"
          ? { sign: "~", className: "text-amber-600 dark:text-amber-400" }
          : { sign: "·", className: "text-muted-foreground" }
  return (
    <li className="flex gap-2">
      <span className={`w-3 shrink-0 font-mono ${mark.className}`}>
        {mark.sign}
      </span>
      <span className="min-w-0">
        <span className={mark.className}>
          <span className="font-mono">{step.key}</span>
          {step.role ? ` · ${step.role}` : ""}
          {step.proofStep ? " · proof" : ""}
        </span>
        <span className="block text-muted-foreground">{step.name}</span>
        {change.change === "changed" && (
          <span className="block text-xs text-muted-foreground">
            Changes{" "}
            {change.fields
              .map((field) => FIELD_LABELS[field] ?? field)
              .join(", ")}
            {change.fields.includes("name") && (
              <>
                {" "}
                (was: <span className="italic">{change.from.name}</span>)
              </>
            )}
          </span>
        )}
      </span>
    </li>
  )
}

function PlaybookDiff({ diff }: { diff: PlaybookDefaultDiff }) {
  return (
    <div className="max-h-80 space-y-3 overflow-y-auto text-sm">
      {diff.name.current !== diff.name.template && (
        <p>
          Renamed to <span className="font-medium">{diff.name.template}</span>.
        </p>
      )}
      {diff.hooks
        .filter((hook) => hook.steps.length)
        .map((hook) => (
          <div key={hook.hook} className="space-y-1">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {hook.hook.replace(/_/g, " ")}
            </p>
            <ul className="space-y-1.5">
              {hook.steps.map((change) => (
                <StepLine
                  key={`${change.change}:${change.step.key}`}
                  change={change}
                />
              ))}
            </ul>
          </div>
        ))}
    </div>
  )
}
