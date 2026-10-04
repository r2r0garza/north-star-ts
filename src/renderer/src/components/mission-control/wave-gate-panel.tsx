import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  FileDiff,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type {
  FeatureGraph,
  GateCriterionOutcome,
  WaveGate,
  WaveGateReport,
  WaveGateStatus,
} from "@/types"
import { CheckResults, EvidenceFiles } from "./proof-panel"

// A milestone's wave acceptance gates (plan 110.02): per gate, how QA triaged
// each criterion of its batch (and any earlier story that regressed), the
// checks behind each outcome, changes QA made to checks that already passed,
// and the commit that put the suite on the integration branch.

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
  const criterionText = (userStoryId: string, id: string) =>
    graph.userStories.find((s) => s.id === userStoryId)?.spec.acceptance[
      Number(id.replace(/^AC-/, "")) - 1
    ] ?? ""
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
                        {criterionText(story.userStoryId, criterion.id)}
                      </div>
                      <div className={`text-xs ${meta.className}`}>
                        {meta.label}
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

export function WaveGateHistory({
  graph,
  gates,
}: {
  graph: FeatureGraph
  gates: WaveGate[]
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
            open={index === 0}
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
