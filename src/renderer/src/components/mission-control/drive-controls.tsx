import { useEffect, useState } from "react"
import { Bell, Pause, Play, RotateCcw, Rocket, Square } from "lucide-react"
import { toast } from "sonner"
import {
  BUDGET_SPECS,
  FEATURE_SETTING_SPECS,
} from "../../../../shared/mission-control/budgets"
import { Badge } from "@/components/ui/badge"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { BudgetMeter, DriveMode, FeatureGraph, Position } from "@/types"
import { milestoneOverlapEstimate } from "@/lib/overlap-schedule"
import { OverlapEstimates } from "./overlap-estimate"

// Feature drive controls (plan 106.6): the drive mode, Start / Pause /
// Resume / Cancel, auto-applying the planning proposal, budget meters, and
// the "Waiting on you" count. Mode and budgets are the user's alone.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

const OVERLAP_POLICIES: Array<{
  value: "wait" | "parallel"
  label: string
  help: string
}> = [
  {
    value: "wait",
    label: "Wait",
    help: "User stories whose touch hints overlap run one at a time. Slower, but they rarely conflict at merge.",
  },
  {
    value: "parallel",
    label: "Run in parallel",
    help: "Overlapping user stories run together. Faster when they touch different parts of shared files; a real collision is resolved in the merge queue, which costs time.",
  },
]

const MODES: Array<{ value: DriveMode; label: string; help: string }> = [
  {
    value: "manual",
    label: "Manual",
    help: "You run user stories and hooks. The Navigator shows what's next.",
  },
  {
    value: "copilot",
    label: "Co-pilot",
    help: "The Navigator directs the lead seat after every change; the lead starts and replans work with its map tools.",
  },
  {
    value: "autopilot",
    label: "Autopilot",
    help: "The Navigator starts ready user stories and due hooks itself and hands judgment calls to the lead.",
  },
]

export function DriveControls({
  graph,
  position,
  onGraph,
  onShowWaiting,
  budgetRequest = 0,
  variant = "full",
  waitingCount,
}: {
  graph: FeatureGraph
  position: Position | null
  onGraph: (graph: FeatureGraph) => void
  onShowWaiting: () => void
  // Changes when something else (the inbox) asks to edit budgets.
  budgetRequest?: number
  // "settings": only the drive mode, overlap, and auto-apply controls, for
  // Advanced settings; the Feature home owns the actions (plan 106.11).
  variant?: "full" | "settings"
  // The unified Waiting on you count, when the caller has it.
  waitingCount?: number
}) {
  const full = variant === "full"
  const feature = graph.feature
  const [pending, setPending] = useState(false)
  const [mode, setMode] = useState<DriveMode>(feature.driveMode)
  const [autoApply, setAutoApply] = useState(feature.drive.autoApplyPlan)
  const draft = feature.status === "draft"
  const paused = feature.status === "paused"
  const active = feature.status === "active"
  const finished = ["completed", "cancelled", "failed"].includes(feature.status)
  const editable = draft || paused
  const shownMode = editable ? mode : feature.driveMode
  const waiting =
    waitingCount ??
    (position?.pendingDecisions ?? []).filter((d) => d.owner === "user").length

  const act = async (work: () => Promise<FeatureGraph>) => {
    setPending(true)
    try {
      onGraph(await work())
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }
  const drive = window.cowork.missionControl.drive
  const start = () =>
    act(async () => {
      const result = await drive.start(feature.id, {
        mode,
        autoApplyPlan: autoApply,
      })
      if (result.planningError)
        toast.warning(
          `Started, but planning couldn't run: ${result.planningError}`
        )
      return result.graph
    })
  // Saved at once (drafts too), so Start — from here or the Feature home —
  // uses what's shown.
  const changeMode = (value: DriveMode) => {
    setMode(value)
    if (editable) void act(() => drive.setMode(feature.id, value))
  }
  // Unlike the drive mode, this applies at the next dispatch, so it can
  // change at any time until the feature finishes.
  const changeOverlapPolicy = (value: "wait" | "parallel") =>
    void act(() => drive.setOverlapPolicy(feature.id, value))
  const overlapPolicy = feature.drive.overlapPolicy
  const estimate = finished ? null : milestoneOverlapEstimate(graph)
  const changeAutoApply = (value: boolean) => {
    setAutoApply(value)
    if (editable) void act(() => drive.setAutoApplyPlan(feature.id, value))
  }

  return (
    <div className={full ? "space-y-3 rounded-lg border p-4" : "space-y-3"}>
      <div className="flex flex-wrap items-center gap-3">
        {full && (
          <code className="text-xs text-muted-foreground">{feature.key}</code>
        )}
        {full && <Badge>{feature.status}</Badge>}
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Drive</Label>
          <Select
            value={shownMode}
            disabled={!editable || pending}
            onValueChange={(value) => changeMode(value as DriveMode)}
          >
            <SelectTrigger className="h-8 w-36" aria-label="Drive mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div
          className="flex items-center gap-2"
          title={OVERLAP_POLICIES.find((p) => p.value === overlapPolicy)?.help}
        >
          <Label className="text-xs text-muted-foreground">
            Overlapping stories
          </Label>
          <Select
            value={overlapPolicy}
            disabled={finished || pending}
            onValueChange={(value) =>
              changeOverlapPolicy(value as "wait" | "parallel")
            }
          >
            <SelectTrigger
              className="h-8 w-40"
              aria-label="Overlapping stories"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OVERLAP_POLICIES.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {shownMode === "autopilot" && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              size="sm"
              checked={editable ? autoApply : feature.drive.autoApplyPlan}
              disabled={!editable || pending}
              onCheckedChange={changeAutoApply}
            />
            Auto-apply planning (the plan and what its review adds)
          </label>
        )}
        {full && (
          <div className="ml-auto flex items-center gap-2">
            {waiting > 0 && (
              <Button size="sm" variant="outline" onClick={onShowWaiting}>
                <Bell className="size-4 text-amber-500" /> Waiting on you (
                {waiting})
              </Button>
            )}
            {draft && (
              <Button
                size="sm"
                disabled={pending || !feature.rigId}
                title={feature.rigId ? undefined : "Choose a rig first"}
                onClick={() => void start()}
              >
                <Rocket className="size-4" /> Start
              </Button>
            )}
            {active && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => void act(() => drive.pause(feature.id))}
              >
                <Pause className="size-4" /> Pause
              </Button>
            )}
            {paused && (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => void act(() => drive.resume(feature.id))}
              >
                <Play className="size-4" /> Resume
              </Button>
            )}
            {feature.status === "completed" && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                title="Add more milestones to this feature"
                onClick={() => void act(() => drive.reopen(feature.id))}
              >
                <RotateCcw className="size-4" /> Reopen
              </Button>
            )}
            {!draft && !finished && (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={pending}
                onClick={() => {
                  if (
                    window.confirm(
                      `Cancel “${feature.name}”? Running user stories and hooks stop, and it can't be resumed. Branches and worktrees stay until you delete it.`
                    )
                  )
                    void act(() => drive.cancel(feature.id))
                }}
              >
                <Square className="size-4" /> Cancel
              </Button>
            )}
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {MODES.find((item) => item.value === shownMode)?.help}
        {feature.status === "completed"
          ? " Every milestone is complete. Reopen to add more milestones; it reopens paused so you can check the mode and budgets before resuming."
          : editable || finished
            ? ""
            : " Pause to change the mode."}
      </p>
      {estimate && <OverlapEstimates estimates={[estimate]} />}
      {full && paused && feature.drive.pauseReason && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm">
          Paused: {feature.drive.pauseReason}
        </div>
      )}
      {full && !draft && position && (
        <BudgetMeters
          graph={graph}
          meters={position.budgets}
          onGraph={onGraph}
          editRequest={budgetRequest}
        />
      )}
    </div>
  )
}

function amount(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export function BudgetMeters({
  graph,
  meters,
  onGraph,
  editRequest = 0,
}: {
  graph: FeatureGraph
  meters: BudgetMeter[]
  onGraph: (graph: FeatureGraph) => void
  editRequest?: number
}) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (editRequest) openEditor()
    // Only a new request opens the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest])
  function openEditor() {
    const next: Record<string, string> = {}
    for (const spec of [...BUDGET_SPECS, ...FEATURE_SETTING_SPECS]) {
      const value = graph.feature.budgets[spec.key]
      next[spec.key] = typeof value === "number" ? String(value) : ""
    }
    setValues(next)
    setOpen(true)
  }
  const save = async () => {
    const patch: Record<string, number | null> = {}
    for (const spec of BUDGET_SPECS) {
      const raw = values[spec.key]?.trim() ?? ""
      if (!raw) patch[spec.key] = null
      else {
        const value = Number(raw)
        if (!Number.isInteger(value) || value < 0) {
          toast.error(`${spec.label} must be a whole number of 0 or more.`)
          return
        }
        patch[spec.key] = value
      }
    }
    // Refocus and seat memory settings (plan 106.7) share the record.
    for (const spec of FEATURE_SETTING_SPECS) {
      const raw = values[spec.key]?.trim() ?? ""
      if (!raw) patch[spec.key] = null
      else {
        const value = Number(raw)
        if (!Number.isInteger(value) || value < 0) {
          toast.error(`${spec.label} must be a whole number of 0 or more.`)
          return
        }
        patch[spec.key] = value
      }
    }
    setSaving(true)
    try {
      onGraph(
        await window.cowork.missionControl.drive.setBudgets(
          graph.feature.id,
          patch
        )
      )
      setOpen(false)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  return (
    <div>
      <div className="mb-2 flex items-center">
        <span className="text-xs font-medium text-muted-foreground">
          Budgets
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 text-xs"
          onClick={openEditor}
        >
          Edit budgets
        </Button>
      </div>
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        {meters.map((meter) => {
          const ratio =
            meter.limit > 0 ? Math.min(1, meter.used / meter.limit) : 1
          // A full concurrency slot count is normal operation, not a warning.
          const level =
            meter.key === "maxConcurrentUserStories" || meter.final
              ? "ok"
              : meter.level
          return (
            <div key={meter.key} className="text-xs" title={meter.help}>
              <div className="flex gap-2">
                <span className="truncate text-muted-foreground">
                  {meter.label}
                  {meter.scope && (
                    <span className="opacity-70"> · {meter.scope}</span>
                  )}
                </span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {amount(meter.used)} / {meter.limit}
                  {meter.unit === "hours" ? " h" : ""}
                  {meter.context && (
                    <span className="text-muted-foreground">
                      {" "}
                      · {meter.context}
                    </span>
                  )}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full ${level === "hard" ? "bg-destructive" : level === "soft" ? "bg-amber-500" : "bg-primary"}`}
                  style={{ width: `${Math.round(ratio * 100)}%` }}
                />
              </div>
            </div>
          )
        })}
        <div className="text-xs text-muted-foreground">
          Tokens / cost: not tracked (no provider accounting yet)
        </div>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Budgets</DialogTitle>
            <DialogDescription>
              Hard limits for this feature. Only you can change them; leave a
              field empty for its default.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {BUDGET_SPECS.map((spec) => (
              <div
                key={spec.key}
                className="grid grid-cols-[1fr_7rem] items-center gap-3"
              >
                <div>
                  <Label htmlFor={`budget-${spec.key}`}>{spec.label}</Label>
                  <p className="text-xs text-muted-foreground">
                    At the limit: {spec.onHard}
                  </p>
                </div>
                <Input
                  id={`budget-${spec.key}`}
                  inputMode="numeric"
                  placeholder={String(spec.default)}
                  value={values[spec.key] ?? ""}
                  onChange={(e) =>
                    setValues((current) => ({
                      ...current,
                      [spec.key]: e.target.value,
                    }))
                  }
                />
              </div>
            ))}
            <p className="pt-2 text-xs font-medium text-muted-foreground">
              Refocus and seat memory
            </p>
            {FEATURE_SETTING_SPECS.map((spec) => (
              <div
                key={spec.key}
                className="grid grid-cols-[1fr_7rem] items-center gap-3"
              >
                <div>
                  <Label htmlFor={`setting-${spec.key}`}>{spec.label}</Label>
                  <p className="text-xs text-muted-foreground">{spec.help}</p>
                </div>
                {spec.kind === "toggle" ? (
                  <Switch
                    id={`setting-${spec.key}`}
                    className="justify-self-end"
                    checked={
                      (values[spec.key]?.trim()
                        ? Number(values[spec.key])
                        : spec.default) > 0
                    }
                    onCheckedChange={(checked) =>
                      setValues((current) => ({
                        ...current,
                        [spec.key]: checked ? "1" : "0",
                      }))
                    }
                  />
                ) : (
                  <Input
                    id={`setting-${spec.key}`}
                    inputMode="numeric"
                    placeholder={String(spec.default)}
                    value={values[spec.key] ?? ""}
                    onChange={(e) =>
                      setValues((current) => ({
                        ...current,
                        [spec.key]: e.target.value,
                      }))
                    }
                  />
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={saving} onClick={() => void save()}>
              Save budgets
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
