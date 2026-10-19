import { ChevronDown, CircleCheck, CirclePause, CircleX, Clock3, LoaderCircle, Pause, Play, RotateCcw, Wrench } from "lucide-react"
import { ScreenHeader } from "@/components/screen-header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { WorkflowDefinition } from "../../../shared/workflows"

type Run = {
  id: string
  title: string
  status: string
  createdAt: number
  objective: string
}

type Activity = {
  status: "completed" | "cancelled" | "paused" | "active" | "waiting"
  summary: string
  transcript: { role: "assistant" | "user"; text: string }[]
  toolCalls: { name: string; detail: string; result: string }[]
}

const STATUS_STYLE: Record<string, string> = {
  Completed: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  Paused: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  Active: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  Cancelled: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
}

const EXAMPLE_ACTIVITY: Record<string, Activity[]> = {
  "example-active-run": [
    { status: "completed", summary: "Compared the proposed changes with surrounding code and noted the affected areas.", transcript: [{ role: "assistant", text: "I’ll map the changed files to their surrounding implementation before reviewing behavior." }, { role: "assistant", text: "The changes touch workflow run presentation and its focused tests." }], toolCalls: [{ name: "Read files", detail: "src/renderer/src/components/run-detail.tsx", result: "Read the run detail component and activity definitions." }, { name: "Search code", detail: "Find references to run detail and activity", result: "Located the screen integration and workflow sample definitions." }] },
    { status: "active", summary: "Checking for behavioral risks, security implications, and relevant test coverage.", transcript: [{ role: "assistant", text: "The changed files are mapped. I’m now checking likely regressions and test coverage." }], toolCalls: [{ name: "Search code", detail: "Search relevant UI and run tests", result: "Illustrative search in progress; no live work was performed." }] },
    { status: "waiting", summary: "Waiting to prepare the review summary.", transcript: [{ role: "assistant", text: "The final review summary has not been prepared yet." }], toolCalls: [] },
  ],
  "code-review": [
    { status: "completed", summary: "Compared the proposed changes with surrounding code and noted the affected areas.", transcript: [{ role: "assistant", text: "I’ll map the changed files to their surrounding implementation before reviewing behavior." }, { role: "assistant", text: "The changes touch workflow run presentation and its focused tests." }], toolCalls: [{ name: "Read files", detail: "src/renderer/src/components/run-detail.tsx", result: "Read the run detail component and activity definitions." }, { name: "Search code", detail: "Find references to run detail and activity", result: "Located the screen integration and workflow sample definitions." }] },
    { status: "completed", summary: "Checked for behavioral risks, security implications, and relevant test coverage.", transcript: [{ role: "assistant", text: "Next I’ll check likely regressions and whether the UI behavior is covered." }, { role: "assistant", text: "The preview remains explicitly illustrative and does not execute tools." }], toolCalls: [{ name: "Search code", detail: "Search relevant UI and run tests", result: "Found existing workflow screen tests and no execution backend." }] },
    { status: "completed", summary: "Prepared a concise review summary with findings and follow-up suggestions.", transcript: [{ role: "assistant", text: "Review complete. I’ll summarize the key findings and note any remaining limitations." }], toolCalls: [] },
  ],
  "project-health": [
    { status: "completed", summary: "Reviewed the project structure and checked the available quality signals.", transcript: [{ role: "assistant", text: "I’ll inspect the project layout and available quality signals." }, { role: "assistant", text: "The repository has a renderer, main process, and shared workflow definitions." }], toolCalls: [{ name: "List files", detail: "Project structure", result: "Found renderer, main, shared, and test directories." }, { name: "Check scripts", detail: "package.json", result: "Found build, test, and formatting scripts." }] },
    { status: "cancelled", summary: "The run was cancelled before the project health summary was prepared.", transcript: [{ role: "assistant", text: "I’ve gathered the initial signals. The run was cancelled before I could prepare the report." }], toolCalls: [] },
  ],
  "release-preparation": [
    { status: "completed", summary: "Reviewed test status and checked for outstanding release blockers.", transcript: [{ role: "assistant", text: "I’ll review the available test status and check for release blockers." }, { role: "assistant", text: "No blocker summary has been persisted; this is only a simulated preview." }], toolCalls: [{ name: "Check status", detail: "Available validation signals", result: "Illustrative check completed; no live release data was queried." }] },
    { status: "paused", summary: "Waiting to prepare the release summary.", transcript: [{ role: "assistant", text: "Readiness review is complete. Waiting to prepare the release summary." }], toolCalls: [] },
  ],
}

const ACTIVITY_STYLE = {
  active: { label: "Active", className: STATUS_STYLE.Active, Icon: LoaderCircle },
  completed: { label: "Completed", className: STATUS_STYLE.Completed, Icon: CircleCheck },
  cancelled: { label: "Not completed", className: STATUS_STYLE.Cancelled, Icon: CircleX },
  paused: { label: "Paused", className: STATUS_STYLE.Paused, Icon: CirclePause },
  waiting: { label: "Waiting", className: "bg-muted text-muted-foreground", Icon: Clock3 },
}

export function RunDetail({
  run,
  workflow,
  onBack,
  onClose,
}: {
  run: Run
  workflow?: WorkflowDefinition
  onBack: () => void
  onClose: () => void
}) {
  const StatusIcon = run.status === "Completed" ? CircleCheck : run.status === "Paused" ? CirclePause : run.status === "Active" ? LoaderCircle : CircleX
  const timestamp = new Date(run.createdAt)
  const activities = EXAMPLE_ACTIVITY[run.id] ?? EXAMPLE_ACTIVITY[workflow?.id ?? ""] ?? []

  return (
    <div data-slot="run-detail" className="flex min-h-0 min-w-0 flex-1 flex-col bg-background pt-11 text-sm text-foreground">
      <ScreenHeader title={run.title} onBack={onBack} backLabel="Back to runs" onClose={onClose} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
          <section className="rounded-xl border bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Workflow run</p>
                <h2 className="font-heading text-xl font-semibold">{run.title}</h2>
                <p className="text-muted-foreground">No project · Example run for layout preview only</p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <Badge variant="secondary" className={cn("gap-1.5", STATUS_STYLE[run.status])}>
                  <StatusIcon className="size-3.5" />{run.status}
                </Badge>
                {run.status === "Active" && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled><Pause className="size-4" />Pause</Button>
                    <Button size="sm" variant="destructive" disabled><CircleX className="size-4" />Cancel</Button>
                  </div>
                )}
                {run.status === "Paused" && <Button size="sm" variant="outline" disabled><Play className="size-4" />Resume</Button>}
                {run.status === "Cancelled" && <Button size="sm" variant="outline" disabled><RotateCcw className="size-4" />Retry</Button>}
              </div>
            </div>
            <div className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-2">
              <div><p className="text-xs text-muted-foreground">Started</p><time dateTime={timestamp.toISOString()}>{timestamp.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time></div>
              <div><p className="text-xs text-muted-foreground">Run ID</p><code className="text-xs">{run.id}</code></div>
            </div>
          </section>
          <section aria-label="Run objective" className="rounded-xl border bg-card">
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 font-medium focus-visible:outline-2 focus-visible:outline-ring">
                <span>Objective</span>
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <p className="border-t px-4 py-3 text-muted-foreground">{run.objective}</p>
            </details>
          </section>
          <section aria-label="Run activity" className="space-y-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-medium">Activity</h3>
                <Badge variant="outline" className="text-[10px]">Simulated preview</Badge>
              </div>
              <p className="text-xs text-muted-foreground">Illustrative step activity based on this workflow’s definition; no work was executed.</p>
            </div>
            {activities.length > 0 ? (
              <ol className="space-y-3">
                {activities.map((activity, index) => {
                  const display = ACTIVITY_STYLE[activity.status]
                  const StepIcon = display.Icon
                  const step = workflow?.steps[index]
                  return (
                    <li key={step?.id ?? index} className="rounded-xl border bg-card">
                      <details className="group">
                        <summary className="flex cursor-pointer list-none items-start gap-3 p-4 focus-visible:outline-2 focus-visible:outline-ring">
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">{index + 1}</div>
                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <h4 className="font-medium">{step?.title ?? `Step ${index + 1}`}</h4>
                              <Badge variant="secondary" className={cn("w-28 justify-center gap-1", display.className)}>
                                <StepIcon className="size-3" />{display.label}
                              </Badge>
                            </div>
                            <p className="text-xs leading-relaxed text-muted-foreground">{activity.summary}</p>
                            {step?.instructions && <p className="border-l-2 pl-2 text-xs text-muted-foreground">{step.instructions}</p>}
                          </div>
                          <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
                        </summary>
                        <div className="space-y-4 border-t px-4 py-4 pl-14">
                          <div className="space-y-3" aria-label="Simulated transcript">
                            {activity.transcript.map((message, messageIndex) => (
                              <div key={messageIndex} className="rounded-lg bg-muted/60 p-3">
                                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{message.role}</p>
                                <p className="text-xs leading-relaxed">{message.text}</p>
                              </div>
                            ))}
                          </div>
                          {activity.toolCalls.length > 0 && (
                            <div className="space-y-2">
                              <h5 className="flex items-center gap-1.5 text-xs font-medium"><Wrench className="size-3.5" />Tool calls</h5>
                              {activity.toolCalls.map((call, callIndex) => (
                                <div key={callIndex} className="rounded-lg border p-3 text-xs">
                                  <p className="font-medium">{call.name}</p>
                                  <p className="mt-1 font-mono text-muted-foreground">{call.detail}</p>
                                  <p className="mt-2 leading-relaxed">{call.result}</p>
                                </div>
                              ))}
                            </div>
                          )}
                          <p className="text-[10px] text-muted-foreground">Illustrative transcript and tool calls only — nothing was executed.</p>
                        </div>
                      </details>
                    </li>
                  )
                })}
              </ol>
            ) : (
              <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No simulated step activity is available for this workflow.</div>
            )}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 className="size-3.5" />Activity timestamps and execution output are not available in this preview.</p>
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}
