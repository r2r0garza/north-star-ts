import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Download,
  Info,
  Loader2,
  OctagonAlert,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Wrench,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"
import {
  CATEGORY_LABELS,
  readinessOf,
} from "../../../../shared/mission-control/workspace-analysis"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type {
  ApplyAllItem,
  Finding,
  Fix,
  Readiness,
  SetupRunView,
  WorkspaceAnalysis,
} from "@/types"
import { SetupTerminal, watchSetupOutput } from "./setup-terminal"
import { TestBrowserFixStatus } from "./test-browser"

// The workspace setup checklist (plan 106.11): findings with concrete fixes,
// Apply all's review sheet, and the live setup run. Every action names a
// finding by key; the main process owns the commands.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

export interface WorkspaceAnalysisState {
  analysis: WorkspaceAnalysis | null
  run: SetupRunView | null
  loading: boolean
  reload: () => Promise<void>
  analyze: () => Promise<void>
}

export function useWorkspaceAnalysis(
  featureId: string,
  workspaceId: string | null,
  // Changes when the settings findings resolve against change elsewhere
  // (the advanced editors, the overlap policy): re-resolve then.
  revision?: string | number
): WorkspaceAnalysisState {
  const [analysis, setAnalysis] = useState<WorkspaceAnalysis | null>(null)
  const [run, setRun] = useState<SetupRunView | null>(null)
  const [loading, setLoading] = useState(true)
  const api = window.cowork.missionControl.analysis
  const reload = useCallback(async () => {
    const [next, latest] = await Promise.all([
      api.get(featureId),
      api.run(featureId),
    ])
    setAnalysis(next)
    setRun(latest)
    setLoading(false)
  }, [api, featureId])
  useEffect(() => {
    setAnalysis(null)
    setRun(null)
    setLoading(true)
    watchSetupOutput()
    void reload().catch(() => setLoading(false))
    // A stored result may be stale if the project changed since.
    void api
      .checkFreshness(featureId)
      .then((next) => next && setAnalysis(next))
      .catch(() => {})
    const offChanged = api.onChanged((changed) => {
      if (changed === featureId) void reload().catch(() => {})
    })
    const offRun = api.onRunChanged((next) => {
      if (next.featureId === featureId) setRun(next)
    })
    return () => {
      offChanged()
      offRun()
    }
    // The workspace is part of the identity: changing it drops the result.
  }, [api, featureId, workspaceId, reload])
  useEffect(() => {
    if (revision === undefined) return
    void reload().catch(() => {})
    // Only a new revision re-reads; the effect above handles identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])
  const analyze = useCallback(async () => {
    try {
      setAnalysis(await api.analyze(featureId))
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }, [api, featureId])
  return { analysis, run, loading, reload, analyze }
}

export const READINESS_TEXT: Record<Readiness, string> = {
  "not-checked": "Not checked yet",
  checking: "Checking your project…",
  ready: "Project ready",
  recommendations: "Ready, with recommendations",
  "needs-input": "Needs your input",
  failed: "Could not check the project",
}

export function readinessLine(analysis: WorkspaceAnalysis | null): {
  readiness: Readiness
  text: string
  detail: string | null
} {
  const readiness = readinessOf(analysis)
  const open = (analysis?.findings ?? []).filter((f) => f.status === "open")
  const blockers = open.filter((f) => f.severity === "blocker").length
  const warnings = open.filter((f) => f.severity === "warning").length
  let detail: string | null = null
  if (readiness === "checking") detail = analysis?.stage ?? null
  else if (readiness === "needs-input")
    detail = `${blockers} thing${blockers === 1 ? "" : "s"} to fix before starting${warnings ? `, ${warnings} recommendation${warnings === 1 ? "" : "s"}` : ""}`
  else if (readiness === "recommendations")
    detail = `${warnings} recommendation${warnings === 1 ? "" : "s"} to make parallel work run smoothly`
  else if (readiness === "failed") detail = analysis?.error ?? null
  else if (readiness === "not-checked")
    detail =
      "Start checks the project first, or analyze it now to review the setup."
  return { readiness, text: READINESS_TEXT[readiness], detail }
}

function SeverityIcon({ finding }: { finding: Finding }) {
  if (finding.status === "resolved")
    return (
      <CheckCircle2
        className="size-4 shrink-0 text-emerald-500"
        aria-label="Resolved"
      />
    )
  if (finding.status === "dismissed")
    return (
      <CircleSlash
        className="size-4 shrink-0 text-muted-foreground"
        aria-label="Dismissed"
      />
    )
  if (finding.severity === "blocker")
    return (
      <OctagonAlert
        className="size-4 shrink-0 text-destructive"
        aria-label="Blocker"
      />
    )
  if (finding.severity === "warning")
    return (
      <AlertTriangle
        className="size-4 shrink-0 text-amber-500"
        aria-label="Warning"
      />
    )
  return <Info className="size-4 shrink-0 text-sky-500" aria-label="Info" />
}

function commandsOf(
  fix: Fix
): Array<{ label: string; command: string; cwd: string }> {
  if (fix.kind === "run-command") return fix.commands
  if (fix.kind === "run-checks")
    return fix.probes.map((p) => ({
      label: p.label,
      command: p.command ?? "",
      cwd: p.cwd,
    }))
  if (fix.kind === "apply-settings")
    return [
      ...(fix.patch.worktreeSetupSteps?.add ?? []).map((s) => ({
        label: s.label,
        command: s.command,
        cwd: s.cwd,
      })),
      ...(fix.patch.generatedFiles?.add ?? []).map((r) => ({
        label: `Regenerates ${r.paths.join(", ")}`,
        command: r.command,
        cwd: "",
      })),
      ...(fix.patch.appLaunch?.add ?? []).map((service) => ({
        label: `Starts ${service.label}`,
        command: service.command,
        cwd: service.cwd,
      })),
    ]
  return []
}

function CommandList({ fix }: { fix: Fix }) {
  const commands = commandsOf(fix)
  if (!commands.length) return null
  return (
    <div className="space-y-1">
      {commands.map((c, i) => (
        <div key={i} className="flex min-w-0 items-baseline gap-2 text-xs">
          <code className="min-w-0 rounded bg-muted px-1.5 py-0.5 font-mono break-all">
            {c.command}
          </code>
          {c.cwd && (
            <span className="shrink-0 text-muted-foreground">in {c.cwd}/</span>
          )}
        </div>
      ))}
    </div>
  )
}

function actionLabel(fix: Fix): string {
  if (fix.kind === "run-command") return fix.patch ? "Apply and run" : "Run"
  if (fix.kind === "run-checks") return "Run checks"
  if (fix.kind === "download-test-browser") return "Download"
  return "Apply"
}

function ActionIcon({ fix }: { fix: Fix }) {
  if (fix.kind === "run-command" || fix.kind === "run-checks")
    return <Play className="size-4" />
  if (fix.kind === "download-test-browser")
    return <Download className="size-4" />
  return <Wrench className="size-4" />
}

function FindingRow({
  finding,
  busy,
  onFix,
  onDismiss,
}: {
  finding: Finding
  busy: boolean
  onFix: (key: string, alternative: number | null) => Promise<void>
  onDismiss: (key: string, dismissed: boolean) => Promise<void>
}) {
  const [why, setWhy] = useState(false)
  const open = finding.status === "open"
  const fix = finding.fix
  return (
    <li
      id={`finding-${finding.key}`}
      className={`space-y-2 rounded-md border p-3 text-sm ${open ? "" : "opacity-80"} ${finding.severity === "blocker" && open ? "border-destructive/40 bg-destructive/5" : ""}`}
    >
      <div className="flex items-start gap-2">
        <SeverityIcon finding={finding} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{finding.title}</span>
            {finding.confidence !== "verified" && (
              <Badge
                variant="outline"
                className="font-normal"
                title={
                  finding.confidence === "likely"
                    ? "Inferred from strong signals, not fully verified"
                    : "A best guess; review before applying"
                }
              >
                {finding.confidence === "likely" ? "Likely" : "Guess"}
              </Badge>
            )}
            {finding.source === "model" && (
              <Badge
                variant="secondary"
                className="gap-1 font-normal"
                title="Suggested by the model from the project's docs and files"
              >
                <Sparkles className="size-3" /> Suggested
              </Badge>
            )}
            {finding.resolution && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400">
                {finding.resolution}
              </span>
            )}
          </div>
          <p className="text-muted-foreground">{finding.explanation}</p>
          {open && (fix.kind !== "manual" || finding.replacesUserSetting) && (
            <div className="space-y-1">
              <div className="text-xs font-medium">{fix.summary}</div>
              <CommandList fix={fix} />
              {fix.kind === "download-test-browser" && <TestBrowserFixStatus />}
              {finding.replacesUserSetting && (
                <p className="text-xs text-amber-600">
                  This replaces a setting you wrote.
                </p>
              )}
            </div>
          )}
          {open && fix.kind === "manual" && (
            <ol className="list-decimal space-y-0.5 pl-5 text-xs">
              {fix.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
              {fix.link && (
                <li className="list-none">
                  <a
                    className="text-primary underline"
                    href={fix.link}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Instructions
                  </a>
                </li>
              )}
            </ol>
          )}
          {finding.lastRun && open && (
            <p
              className={`text-xs ${finding.lastRun.ok ? "text-emerald-600" : "text-destructive"}`}
            >
              Last attempt: {finding.lastRun.note}
            </p>
          )}
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setWhy((v) => !v)}
            aria-expanded={why}
          >
            {why ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            Why? ({finding.evidence.length}{" "}
            {finding.evidence.length === 1 ? "clue" : "clues"} ·{" "}
            {CATEGORY_LABELS[finding.category]})
          </button>
          {why && (
            <ul className="space-y-0.5 border-l pl-3 text-xs text-muted-foreground">
              {finding.evidence.map((e) => (
                <li key={e.id}>
                  {e.label}
                  {e.detail && (
                    <pre className="mt-0.5 font-mono text-[11px] break-all whitespace-pre-wrap">
                      {e.detail}
                    </pre>
                  )}
                </li>
              ))}
              {finding.lastRun?.outputTail && (
                <li>
                  Last output:
                  <pre className="mt-0.5 max-h-40 overflow-auto font-mono text-[11px] break-all whitespace-pre-wrap">
                    {finding.lastRun.outputTail}
                  </pre>
                </li>
              )}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {open && fix.kind !== "manual" && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void onFix(finding.key, null)}
            >
              <ActionIcon fix={fix} />
              {actionLabel(fix)}
            </Button>
          )}
          {open &&
            finding.alternatives.map((alt, i) =>
              alt.kind === "manual" ? null : (
                <Button
                  key={i}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  title={alt.summary}
                  onClick={() => void onFix(finding.key, i)}
                >
                  {alt.kind === "run-command"
                    ? "Run instead"
                    : "Use this instead"}
                </Button>
              )
            )}
          {finding.status === "open" && finding.severity !== "info" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-muted-foreground"
              onClick={() => void onDismiss(finding.key, true)}
            >
              Dismiss
            </Button>
          )}
          {finding.status === "dismissed" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => void onDismiss(finding.key, false)}
            >
              Restore
            </Button>
          )}
        </div>
      </div>
      {open && finding.alternatives.some((a) => a.kind !== "manual") && (
        <div className="space-y-1 pl-6 text-xs text-muted-foreground">
          {finding.alternatives.map((alt, i) =>
            alt.kind === "manual" ? null : (
              <div key={i}>
                Other option: {alt.summary}
                <CommandList fix={alt} />
              </div>
            )
          )}
        </div>
      )}
      {open &&
        finding.alternatives.some((a) => a.kind === "manual") &&
        fix.kind !== "manual" && (
          <details className="pl-6 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Or do it by hand</summary>
            {finding.alternatives.map((alt, i) =>
              alt.kind === "manual" ? (
                <ol key={i} className="mt-1 list-decimal pl-5">
                  {alt.steps.map((s, j) => (
                    <li key={j}>{s}</li>
                  ))}
                </ol>
              ) : null
            )}
          </details>
        )}
    </li>
  )
}

function Group({
  title,
  findings,
  defaultOpen,
  ...row
}: {
  title: string
  findings: Finding[]
  defaultOpen: boolean
  busy: boolean
  onFix: (key: string, alternative: number | null) => Promise<void>
  onDismiss: (key: string, dismissed: boolean) => Promise<void>
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (!findings.length) return null
  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        {title} ({findings.length})
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {findings.map((f) => (
            <FindingRow key={f.key} finding={f} {...row} />
          ))}
        </ul>
      )}
    </div>
  )
}

export function SetupRunPanel({ run }: { run: SetupRunView }) {
  const [selected, setSelected] = useState<string | null>(null)
  const running = run.steps.find((s) => s.status === "running")
  const shown =
    run.steps.find((s) => s.sessionId && s.sessionId === selected) ??
    running ??
    [...run.steps].reverse().find((s) => s.sessionId) ??
    null
  return (
    <div className="space-y-2 rounded-md border p-3" aria-live="polite">
      <div className="flex items-center gap-2 text-sm font-medium">
        {run.status === "running" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : run.status === "succeeded" ? (
          <CheckCircle2 className="size-4 text-emerald-500" />
        ) : (
          <XCircle className="size-4 text-destructive" />
        )}
        {run.status === "running"
          ? "Setting up your project…"
          : run.status === "succeeded"
            ? "Setup finished"
            : run.status === "cancelled"
              ? "Setup cancelled"
              : "Setup stopped"}
        {run.status === "running" && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7"
            onClick={() =>
              void window.cowork.missionControl.analysis.cancelRun(run.id)
            }
          >
            <Square className="size-3" /> Stop
          </Button>
        )}
      </div>
      <ol className="space-y-1 text-xs">
        {run.steps.map((step, i) => (
          <li key={i}>
            <button
              type="button"
              disabled={!step.sessionId}
              onClick={() => setSelected(step.sessionId)}
              className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left ${step === shown ? "bg-muted" : ""}`}
            >
              {step.status === "running" ? (
                <Loader2 className="size-3 shrink-0 animate-spin" />
              ) : step.status === "ok" ? (
                <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />
              ) : step.status === "failed" ? (
                <XCircle className="size-3 shrink-0 text-destructive" />
              ) : (
                <span className="size-3 shrink-0 rounded-full border" />
              )}
              <span className="min-w-0 flex-1 truncate">{step.label}</span>
              <code className="max-w-[50%] min-w-0 truncate text-muted-foreground">
                {step.command}
              </code>
              {step.exitCode !== null && step.status === "failed" && (
                <span className="shrink-0 text-destructive">
                  exit {step.exitCode}
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
      {shown?.sessionId && (
        <SetupTerminal
          key={shown.sessionId}
          sessionId={shown.sessionId}
          interactive={shown.status === "running"}
        />
      )}
      {run.note && <p className="text-xs text-muted-foreground">{run.note}</p>}
    </div>
  )
}

// The review Start pauses for (plan 106.11): the setup it found that saves
// or runs commands, before the feature starts without it.
export interface StartReview {
  // Finding keys to show.
  only: string[]
  // Applied; the run (when commands run) must finish before starting.
  onApplied: (run: SetupRunView | null) => void
  onStartWithout: () => void
}

export function ApplyAllDialog({
  featureId,
  open,
  onOpenChange,
  start,
}: {
  featureId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  start?: StartReview
}) {
  const [items, setItems] = useState<ApplyAllItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (!open) return
    void window.cowork.missionControl.analysis
      .previewApplyAll(featureId)
      .then((all) => {
        const next = start
          ? all.filter((i) => start.only.includes(i.findingKey))
          : all
        setItems(next)
        setSelected(
          new Set(next.filter((i) => i.defaultSelected).map((i) => i.id))
        )
      })
    // The start review's keys are fixed while it's open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId, open])
  const chosen = items.filter((i) => selected.has(i.id))
  const commands = chosen
    .filter((i) => i.kind !== "settings")
    .reduce((n, i) => n + i.commands.length, 0)
  const submit = async () => {
    setPending(true)
    try {
      const result = await window.cowork.missionControl.analysis.applyAll(
        featureId,
        [...selected]
      )
      if (start) start.onApplied(result.run)
      else
        toast.success(
          result.run
            ? "Applying setup; commands are running in the setup terminal"
            : "Setup applied"
        )
      onOpenChange(false)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {start ? "Set up the project before starting?" : "Apply setup"}
          </DialogTitle>
          <DialogDescription>
            {start
              ? "The check found setup that saves or runs commands, so it needs your OK. Without it, story worktrees may not be able to run the project, or merges may conflict on generated files. "
              : ""}
            Everything below runs in this order. Settings are saved first; then
            commands run one at a time in the setup terminal, stopping at the
            first failure. Saved setup steps also run in each new worktree.
          </DialogDescription>
        </DialogHeader>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to apply.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-start gap-3 rounded-md border p-3 text-sm"
              >
                <Checkbox
                  id={`apply-${item.id}`}
                  checked={selected.has(item.id)}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (checked) next.add(item.id)
                      else next.delete(item.id)
                      return next
                    })
                  }
                  aria-label={item.title}
                />
                <label
                  htmlFor={`apply-${item.id}`}
                  className="min-w-0 flex-1 space-y-1"
                >
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {item.title}
                    <Badge variant="outline" className="font-normal">
                      {item.kind === "settings"
                        ? "Setting"
                        : item.kind === "check"
                          ? "Runs build scripts"
                          : item.kind === "download"
                            ? "Downloads a browser"
                            : "Runs a command"}
                    </Badge>
                    {item.confidence !== "verified" && (
                      <Badge variant="outline" className="font-normal">
                        {item.confidence === "likely" ? "Likely" : "Guess"}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {item.summary}
                  </div>
                  {item.commands.map((c, i) => (
                    <div key={i} className="text-xs">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono break-all">
                        {c.command}
                      </code>
                      {c.cwd && (
                        <span className="text-muted-foreground">
                          {" "}
                          in {c.cwd}/
                        </span>
                      )}
                    </div>
                  ))}
                </label>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {start && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                onOpenChange(false)
                start.onStartWithout()
              }}
            >
              Start without them
            </Button>
          )}
          <Button
            disabled={pending || !chosen.length}
            onClick={() => void submit()}
          >
            {start
              ? `Apply and start (${chosen.length})`
              : commands
                ? `Run selected (${chosen.length})`
                : `Apply selected (${chosen.length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function WorkspaceChecklist({
  featureId,
  state,
  compact = false,
}: {
  featureId: string
  state: WorkspaceAnalysisState
  // Inside the Feature home card: no outer border or header.
  compact?: boolean
}) {
  const { analysis, run } = state
  const [busy, setBusy] = useState(false)
  const [applyAll, setApplyAll] = useState(false)
  const api = window.cowork.missionControl.analysis
  const findings = analysis?.findings ?? []
  const groups = useMemo(
    () => ({
      blockers: findings.filter(
        (f) => f.status === "open" && f.severity === "blocker"
      ),
      warnings: findings.filter(
        (f) => f.status === "open" && f.severity === "warning"
      ),
      info: findings.filter(
        (f) => f.status === "open" && f.severity === "info"
      ),
      resolved: findings.filter((f) => f.status === "resolved"),
      dismissed: findings.filter((f) => f.status === "dismissed"),
    }),
    [findings]
  )
  const onFix = async (key: string, alternative: number | null) => {
    setBusy(true)
    try {
      const result = await api.applyFix(featureId, key, alternative)
      const fix = findings.find((f) => f.key === key)?.fix
      if (result.run) toast.message("Running in the setup terminal below")
      else if (fix?.kind === "download-test-browser" && alternative === null)
        toast.message("Downloading the test browser")
      else toast.success("Applied")
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const onDismiss = async (key: string, dismissed: boolean) => {
    try {
      await api.dismiss(featureId, key, dismissed)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }
  const running = analysis?.status === "running"
  const runActive = run?.status === "running"
  const actionable = findings.some(
    (f) => f.status === "open" && f.fix.kind !== "manual"
  )
  const row = { busy: busy || runActive || running, onFix, onDismiss }
  return (
    <div className={compact ? "space-y-3" : "space-y-3 rounded-lg border p-4"}>
      <div className="flex flex-wrap items-center gap-2">
        {!compact && <h3 className="font-medium">Workspace setup</h3>}
        {running && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />{" "}
            {analysis?.stage ?? "Checking…"}
          </span>
        )}
        {analysis?.stale && !running && (
          <Badge
            variant="outline"
            className="border-amber-500/50 font-normal text-amber-600"
          >
            The project changed since this check
          </Badge>
        )}
        <div className="ml-auto flex gap-2">
          {actionable && (
            <Button
              size="sm"
              disabled={busy || runActive || running}
              onClick={() => setApplyAll(true)}
            >
              Apply all…
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={running || runActive}
            onClick={() => void state.analyze()}
          >
            <RefreshCw className="size-4" />{" "}
            {analysis ? "Analyze again" : "Analyze workspace"}
          </Button>
        </div>
      </div>
      {analysis?.modelNote && (
        <p className="text-xs text-muted-foreground">{analysis.modelNote}</p>
      )}
      {analysis?.modelStatus === "running" && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Reading the project's docs
          for anything the checks missed…
        </p>
      )}
      {run &&
        (run.status === "running" ||
          Date.now() - (run.finishedAt ?? 0) < 10 * 60_000) && (
          <SetupRunPanel run={run} />
        )}
      {analysis?.status === "failed" && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <div className="font-medium">Could not check the project</div>
          <p className="text-muted-foreground">{analysis.error}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Retry, or set things up by hand in Advanced settings (worktree
            environment and generated files).
          </p>
        </div>
      )}
      {analysis &&
        analysis.status !== "failed" &&
        !findings.length &&
        !running && (
          <p className="text-sm text-muted-foreground">
            Nothing to set up. The project looks ready for parallel work.
          </p>
        )}
      {!!(groups.blockers.length + groups.warnings.length) && (
        <ul className="space-y-2">
          {[...groups.blockers, ...groups.warnings].map((f) => (
            <FindingRow key={f.key} finding={f} {...row} />
          ))}
        </ul>
      )}
      <Group
        title="Good to know"
        findings={groups.info}
        defaultOpen={!groups.blockers.length && !groups.warnings.length}
        {...row}
      />
      <Group
        title="Already set up"
        findings={groups.resolved}
        defaultOpen={false}
        {...row}
      />
      <Group
        title="Dismissed"
        findings={groups.dismissed}
        defaultOpen={false}
        {...row}
      />
      {!!analysis?.rejected.length && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {analysis.rejected.length} model suggestion
            {analysis.rejected.length === 1 ? " was" : "s were"} discarded
          </summary>
          <ul className="mt-1 list-disc pl-5">
            {analysis.rejected.map((r, i) => (
              <li key={i}>
                {r.title}: {r.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ApplyAllDialog
        featureId={featureId}
        open={applyAll}
        onOpenChange={setApplyAll}
      />
    </div>
  )
}
