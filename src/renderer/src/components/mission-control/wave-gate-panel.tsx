import { useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  FileDiff,
  Hammer,
  ShieldCheck,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type {
  FeatureGraph,
  GateCriterionOutcome,
  GateEscalation,
  GateEscalationAction,
  WaveGate,
  WaveGateReport,
  WaveGateStatus,
} from "@/types"
import { CheckResults, EvidenceFiles } from "./proof-panel"

// A milestone's wave acceptance gates (plan 110.02): per gate, how QA triaged
// each criterion of its batch (and any earlier story that regressed), the
// checks behind each outcome, changes QA made to checks that already passed,
// and the commit that put the suite on the integration branch. Since 110.03
// also the fix stories its app bugs became, and the criteria past the
// fix-round cap that wait on the user.

const GATE_STATUS: Record<
  WaveGateStatus,
  { label: string; variant: "default" | "destructive" | "outline" }
> = {
  running: { label: "running", variant: "outline" },
  passed: { label: "passed", variant: "default" },
  fixing: { label: "fixing", variant: "outline" },
  escalated: { label: "needs you", variant: "destructive" },
  failed: { label: "failed", variant: "destructive" },
}

const OUTCOME_META: Record<
  GateCriterionOutcome,
  { label: string; icon: typeof CheckCircle2; className: string }
> = {
  passed: {
    label: "Passed",
    icon: CheckCircle2,
    className: "text-emerald-600 dark:text-emerald-500",
  },
  check_fixed: {
    label: "Passed after correcting its check",
    icon: Wrench,
    className: "text-amber-600 dark:text-amber-500",
  },
  app_bug: { label: "App bug", icon: XCircle, className: "text-destructive" },
  unreachable: {
    label: "Couldn't reach the app",
    icon: CircleSlash,
    className: "text-amber-600 dark:text-amber-500",
  },
}

const short = (oid: string | null | undefined) => (oid ? oid.slice(0, 8) : "")

function isReport(value: unknown): value is WaveGateReport {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { stories?: unknown }).stories)
  )
}

function reasonOf(value: unknown): string | null {
  const reason = (value as { reason?: unknown } | null)?.reason
  return typeof reason === "string" ? reason : null
}

function GateReport({
  graph,
  report,
}: {
  graph: FeatureGraph
  report: WaveGateReport
}) {
  const criterionText = (
    userStoryId: string,
    id: string,
    text: string | undefined
  ) =>
    text ??
    graph.userStories.find((s) => s.id === userStoryId)?.spec.acceptance[
      Number(id.replace(/^AC-/, "")) - 1
    ] ??
    ""
  const earlier = report.checkChanges.filter((c) => c.earlierStories.length)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="gap-1">
          <ShieldCheck className="size-3" /> Recorded by {report.recordedBy}
        </Badge>
        <span>
          {report.suite.passed}/{report.suite.checks} automated checks passing
          on the whole suite
        </span>
      </div>
      {report.stories.map((story) => (
        <div key={story.userStoryId} className="rounded-md border">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-sm font-medium">
            {story.key}
            {!story.batch && (
              <Badge variant="outline" className="h-5 text-[11px] font-normal">
                passed an earlier gate
              </Badge>
            )}
          </div>
          <div className="divide-y">
            {story.criteria.map((criterion) => {
              const meta = OUTCOME_META[criterion.outcome]
              const Icon = meta.icon
              const note =
                criterion.problem ?? criterion.justification ?? criterion.reason
              return (
                <div key={criterion.id} className="space-y-1.5 p-3">
                  <div className="flex items-start gap-2">
                    <Icon
                      className={`mt-0.5 size-4 shrink-0 ${meta.className}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">
                        <span className="font-medium">{criterion.id}</span>{" "}
                        {criterionText(
                          story.userStoryId,
                          criterion.id,
                          criterion.text
                        )}
                      </div>
                      <div className={`text-xs ${meta.className}`}>
                        {meta.label}
                        {criterion.waived && (
                          <span className="text-muted-foreground">
                            {" "}
                            · accepted as is earlier, so it counts as passed
                          </span>
                        )}
                      </div>
                      {note && (
                        <div className="text-xs">
                          {criterion.outcome === "check_fixed"
                            ? "Why the check changed: "
                            : criterion.outcome === "app_bug"
                              ? "What's wrong: "
                              : "Reason: "}
                          {note}
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground">
                        {criterion.evidence}
                      </div>
                    </div>
                  </div>
                  {criterion.checks.length > 0 && (
                    <div className="pl-6">
                      <CheckResults checks={criterion.checks} />
                    </div>
                  )}
                  {criterion.artifacts?.length ? (
                    <div className="pl-6">
                      <EvidenceFiles paths={criterion.artifacts} />
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {earlier.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-500">
            <AlertTriangle className="size-3.5" />
            Changed checks that passed an earlier gate
          </div>
          <ul className="space-y-0.5">
            {earlier.map((change) => (
              <li key={change.path}>
                <code>{change.path}</code> ({change.change}) · checks of{" "}
                {change.earlierStories.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {report.checkChanges.length > earlier.length && (
        <div className="space-y-0.5 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <FileDiff className="size-3.5" /> Suite changes
          </div>
          <ul className="pl-5">
            {report.checkChanges
              .filter((c) => !c.earlierStories.length)
              .map((change) => (
                <li key={change.path}>
                  <code>{change.path}</code> ({change.change})
                </li>
              ))}
          </ul>
        </div>
      )}
      {report.warnings.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-600 dark:text-amber-500">
          {report.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

const RESOLUTION_LABEL: Record<GateEscalationAction, string> = {
  accept: "Accepted as is",
  user_fix: "You're fixing it",
  drop: "Criterion dropped",
}

function EscalationCard({
  gate,
  escalation,
  onChanged,
}: {
  gate: WaveGate
  escalation: GateEscalation
  onChanged?: () => Promise<void>
}) {
  const [note, setNote] = useState("")
  const [pending, setPending] = useState(false)
  const label = `${escalation.root.key} ${escalation.root.criterionId}`
  const decide = async (action: GateEscalationAction, success: string) => {
    setPending(true)
    try {
      await window.cowork.missionControl.integration.resolveGateEscalation({
        gateId: gate.id,
        escalationId: escalation.id,
        action,
        note: note.trim() || undefined,
      })
      toast.success(success)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
      await onChanged?.()
    }
  }
  const resolution = escalation.resolution
  return (
    <div
      className={`space-y-2 rounded-md border p-3 text-sm ${resolution ? "" : "border-destructive/50 bg-destructive/5"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle
          className={`size-4 ${resolution ? "text-muted-foreground" : "text-destructive"}`}
        />
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">
          still failing after {escalation.rounds} fix round
          {escalation.rounds === 1 ? "" : "s"}
        </span>
        {resolution && (
          <Badge variant="outline" className="ml-auto">
            {RESOLUTION_LABEL[resolution.action]}
          </Badge>
        )}
      </div>
      <p className="text-sm">{escalation.root.criterion}</p>
      {escalation.problem && (
        <p className="text-xs">What's wrong: {escalation.problem}</p>
      )}
      <p className="text-xs text-muted-foreground">{escalation.evidence}</p>
      {escalation.checks.length > 0 && (
        <CheckResults checks={escalation.checks} />
      )}
      {escalation.artifacts?.length ? (
        <EvidenceFiles paths={escalation.artifacts} />
      ) : null}
      {resolution ? (
        resolution.note && (
          <p className="text-xs text-muted-foreground">
            Note: {resolution.note}
          </p>
        )
      ) : (
        <div className="space-y-2 pt-1">
          <Input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Note (optional): why, or what you'll change"
            className="h-8 text-xs"
            disabled={pending}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              title="Waive the criterion: it counts as passed from now on, and the story can be done"
              onClick={() => void decide("accept", `${label} accepted as is`)}
            >
              <CheckCircle2 className="size-3.5" /> Accept as is
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              title="Pause the feature while you fix it on the integration branch; resuming runs the acceptance gate again"
              onClick={() =>
                void decide(
                  "user_fix",
                  "Paused. Resume when it's fixed; the gate runs again."
                )
              }
            >
              <Hammer className="size-3.5" /> I'll fix it
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              disabled={pending}
              title="Remove the criterion from the user story; the gate runs again"
              onClick={() => {
                if (
                  !window.confirm(
                    `Drop "${escalation.root.criterion}" from ${escalation.root.key}? The criterion is removed from the user story and the acceptance gate runs again.`
                  )
                )
                  return
                void decide("drop", `${label} dropped`)
              }}
            >
              <Trash2 className="size-3.5" /> Drop the criterion
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function GateFollowups({
  graph,
  gate,
  report,
  onChanged,
}: {
  graph: FeatureGraph
  gate: WaveGate
  report: WaveGateReport
  onChanged?: () => Promise<void>
}) {
  const fixes = report.fixes ?? []
  const escalations = report.escalations ?? []
  if (!fixes.length && !escalations.length) return null
  const fixStories = graph.userStories.filter((s) => s.gateId === gate.id)
  return (
    <div className="space-y-2">
      {fixes.length > 0 && (
        <div className="space-y-1 rounded-md border p-3 text-xs">
          <div className="flex items-center gap-1.5 font-medium">
            <Wrench className="size-3.5" /> Fix stories
          </div>
          <ul className="space-y-0.5">
            {fixes.map((fix) => {
              const story =
                fixStories.find((s) => s.id === fix.fixStoryId) ??
                fixStories.find(
                  (s) =>
                    s.fixes?.userStoryId === fix.root.userStoryId &&
                    s.fixes?.criterion === fix.root.criterion
                )
              return (
                <li key={`${fix.root.userStoryId}:${fix.root.criterion}`}>
                  {fix.root.key} {fix.root.criterionId} (fix round{" "}
                  {fix.fixRound}) →{" "}
                  {story ? (
                    <>
                      <code>{story.key}</code> · {story.status}
                    </>
                  ) : fix.proposalId ? (
                    "proposed: apply it from the inbox"
                  ) : (
                    "not created"
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      {escalations.map((escalation) => (
        <EscalationCard
          key={escalation.id}
          gate={gate}
          escalation={escalation}
          onChanged={onChanged}
        />
      ))}
    </div>
  )
}

export function WaveGateHistory({
  graph,
  gates,
  onChanged,
}: {
  graph: FeatureGraph
  gates: WaveGate[]
  onChanged?: () => Promise<void>
}) {
  if (!gates.length) return null
  const keys = (ids: string[]) =>
    ids
      .map((id) => graph.userStories.find((s) => s.id === id)?.key ?? "?")
      .join(", ")
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Acceptance gates
      </div>
      {gates.map((gate, index) => {
        const status = GATE_STATUS[gate.status]
        const report = isReport(gate.report) ? gate.report : null
        const reason = reasonOf(gate.report)
        const commitNote = (gate.report as { commitNote?: string } | null)
          ?.commitNote
        return (
          <details
            key={gate.id}
            open={index === 0 || gate.status === "escalated"}
            className="group rounded-md border p-3"
          >
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm select-none">
              <span className="font-medium">Round {gate.round}</span>
              <Badge variant={status.variant}>{status.label}</Badge>
              <span className="text-xs text-muted-foreground">
                {keys(gate.storyIds)}
              </span>
              {gate.checksCommit && (
                <span className="text-xs text-muted-foreground">
                  · suite at <code>{short(gate.checksCommit)}</code>
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground group-open:hidden">
                Show
              </span>
              <span className="ml-auto hidden text-xs text-muted-foreground group-open:inline">
                Hide
              </span>
            </summary>
            <div className="mt-3 space-y-3">
              {reason && gate.status !== "passed" && (
                <p className="text-xs text-destructive">{reason}</p>
              )}
              {commitNote && (
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  {commitNote}
                </p>
              )}
              {report && (
                <GateFollowups
                  graph={graph}
                  gate={gate}
                  report={report}
                  onChanged={onChanged}
                />
              )}
              {report ? (
                <GateReport graph={graph} report={report} />
              ) : gate.status === "running" ? (
                <p className="text-xs text-muted-foreground">
                  QA is writing and running the acceptance suite on the
                  integration branch.
                </p>
              ) : (
                !reason && (
                  <p className="text-xs text-muted-foreground">
                    No report was recorded.
                  </p>
                )
              )}
            </div>
          </details>
        )
      })}
    </div>
  )
}
