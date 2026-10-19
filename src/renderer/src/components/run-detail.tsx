import { useEffect, useState } from "react"
import { toast } from "sonner"
import type { Message } from "../../../main/db/types"
import type {
  WorkflowRun,
  WorkflowStepRun,
} from "../../../shared/workflow-runs"
import {
  ChevronDown,
  CircleCheck,
  CirclePause,
  CircleX,
  Clock3,
  Info,
  Pause,
  Play,
  RotateCcw,
  Wrench,
} from "lucide-react"
import { ScreenHeader } from "@/components/screen-header"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { WorkflowDefinition } from "../../../shared/workflows"

const STATUS_STYLE: Record<string, string> = {
  Completed:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  Paused:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  Active: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  Cancelled: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
}

const ACTIVITY_STYLE = {
  active: {
    label: "Active",
    className: STATUS_STYLE.Active,
    Icon: Spinner,
  },
  completed: {
    label: "Completed",
    className: STATUS_STYLE.Completed,
    Icon: CircleCheck,
  },
  cancelled: {
    label: "Not completed",
    className: STATUS_STYLE.Cancelled,
    Icon: CircleX,
  },
  paused: {
    label: "Paused",
    className: STATUS_STYLE.Paused,
    Icon: CirclePause,
  },
  failed: { label: "Failed", className: STATUS_STYLE.Cancelled, Icon: CircleX },
  interrupted: {
    label: "Interrupted",
    className: STATUS_STYLE.Paused,
    Icon: CirclePause,
  },
  waiting: {
    label: "Waiting",
    className: "bg-muted text-muted-foreground",
    Icon: Clock3,
  },
}

export function RunDetail({
  run,
  workflow,
  onBack,
  onClose,
}: {
  run: WorkflowRun
  workflow?: WorkflowDefinition
  onBack: () => void
  onClose: () => void
}) {
  const StatusIcon =
    run.status === "Completed"
      ? CircleCheck
      : run.status === "Paused"
        ? CirclePause
        : run.status === "Active"
          ? Spinner
          : CircleX
  const timestamp = new Date(run.createdAt)
  const activities = run.steps
  const [controlling, setControlling] = useState(false)
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({})
  useEffect(() => {
    void window.cowork.providers.listWithModels().then(
      (accounts) =>
        setModelLabels(
          Object.fromEntries(
            accounts.flatMap(({ account, models }) =>
              models.map((model) => [
                `${account.id}::${model.modelId}`,
                `${account.displayName} · ${model.modelName?.trim() || model.modelId}`,
              ])
            )
          )
        ),
      () => toast.error("Could not load model details")
    )
  }, [])
  const [liveText, setLiveText] = useState("")
  const activeStepId = run.steps.find((step) => step.status === "active")?.id
  useEffect(() => {
    setLiveText("")
    return window.cowork.tasks.onEvent(({ taskId, event }) => {
      if (taskId !== run.taskId) return
      if (event.type === "token")
        setLiveText((text) => (text + event.delta).slice(-16000))
    })
  }, [run.taskId, activeStepId])
  async function control(action: "pause" | "resume" | "cancel" | "retry") {
    setControlling(true)
    try {
      await window.cowork.workflowRuns[action](run.id)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update run"
      )
    } finally {
      setControlling(false)
    }
  }

  return (
    <div
      data-slot="run-detail"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background pt-11 text-sm text-foreground"
    >
      <ScreenHeader
        title={run.title}
        onBack={onBack}
        backLabel="Back to runs"
        onClose={onClose}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
          <section className="rounded-xl border bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-2">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Workflow run
                </p>
                <h2 className="font-heading text-xl font-semibold">
                  {run.title}
                </h2>
                <p className="text-muted-foreground">
                  {run.projectName ?? "No project"} · {run.workspacePath}
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <Badge
                  variant="secondary"
                  className={cn("gap-1.5", STATUS_STYLE[run.status])}
                >
                  <StatusIcon className="size-3.5" />
                  {run.status}
                </Badge>
                {run.status === "Active" && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={controlling}
                      onClick={() => void control("pause")}
                    >
                      <Pause className="size-4" />
                      Pause
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={controlling}
                      onClick={() => void control("cancel")}
                    >
                      <CircleX className="size-4" />
                      Cancel
                    </Button>
                  </div>
                )}
                {["Paused", "Interrupted"].includes(run.status) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={controlling}
                    onClick={() => void control("resume")}
                  >
                    <Play className="size-4" />
                    Resume
                  </Button>
                )}
                {run.status === "Failed" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={controlling}
                    onClick={() => void control("retry")}
                  >
                    <RotateCcw className="size-4" />
                    Retry
                  </Button>
                )}
              </div>
            </div>
            <div className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">Started</p>
                <time dateTime={timestamp.toISOString()}>
                  {timestamp.toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Run ID</p>
                <code className="text-xs">{run.id}</code>
              </div>
            </div>
          </section>
          <section
            aria-label="Run objective"
            className="rounded-xl border bg-card"
          >
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 font-medium focus-visible:outline-2 focus-visible:outline-ring">
                <span>Objective</span>
                <ChevronDown
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <p className="border-t px-4 py-3 text-muted-foreground">
                {run.objective}
              </p>
            </details>
          </section>
          {run.indexing && run.indexing !== "ready" && (
            <p
              role="status"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              {run.indexing === "running" && run.status === "Active" && (
                <Spinner className="size-3.5" />
              )}
              {run.indexing === "running"
                ? "Indexing workspace before the first step…"
                : run.indexing === "timed_out"
                  ? "Workspace indexing was still running; steps started with a partial index."
                  : "Workspace indexing failed; steps ran without the index."}
            </p>
          )}
          <OutcomeSection
            step={
              run.status === "Completed"
                ? run.steps.at(-1)
                : (run.steps.find(
                    (step) =>
                      step.status !== "completed" && step.status !== "waiting"
                  ) ??
                  run.steps.findLast((step) => step.status === "completed"))
            }
            active={run.status === "Active"}
          />
          {run.error && (
            <p role="alert" className="text-destructive">
              {run.error}
            </p>
          )}
          <section aria-label="Run activity" className="space-y-3">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-medium">Activity</h3>
                <Badge variant="outline" className="text-[10px]">
                  Auto mode
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Steps run in order. Cancelling does not undo workspace changes.
              </p>
            </div>
            {activities.length > 0 ? (
              <ol className="space-y-3">
                {activities.map((activity, index) => {
                  const display = ACTIVITY_STYLE[activity.status]
                  const StepIcon = display.Icon
                  const step = workflow?.steps[index]
                  return (
                    <li
                      key={step?.id ?? index}
                      className="rounded-xl border bg-card"
                    >
                      <details className="group">
                        <summary className="flex cursor-pointer list-none items-start gap-3 p-4 focus-visible:outline-2 focus-visible:outline-ring">
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                            {index + 1}
                          </div>
                          <div className="min-w-0 flex-1 space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <h4 className="font-medium">
                                  {step?.title ?? `Step ${index + 1}`}
                                </h4>
                                <Badge
                                  variant="outline"
                                  className="max-w-full truncate text-[10px]"
                                >
                                  {activity.accountId && activity.modelId
                                    ? (modelLabels[
                                        `${activity.accountId}::${activity.modelId}`
                                      ] ??
                                      `${activity.accountId} · ${activity.modelId}`)
                                    : (modelLabels[
                                        `${run.accountId}::${run.modelId}`
                                      ] ?? `${run.accountId} · ${run.modelId}`)}
                                </Badge>
                              </div>
                              <Badge
                                variant="secondary"
                                className={cn(
                                  "w-28 justify-center gap-1",
                                  display.className
                                )}
                              >
                                <StepIcon className="size-3" />
                                {display.label}
                              </Badge>
                            </div>
                            {step?.instructions && (
                              <p className="border-l-2 pl-2 text-xs text-muted-foreground">
                                {step.instructions}
                              </p>
                            )}
                          </div>
                          <ChevronDown
                            className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                            aria-hidden="true"
                          />
                        </summary>
                        <div className="space-y-4 border-t px-4 py-4 pl-14">
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {activity.error ??
                              activity.result ??
                              (activity.status === "waiting"
                                ? "Waiting for earlier steps"
                                : "Executing step")}
                          </p>
                          <StepTranscript step={activity} />
                          {activity.status === "active" && liveText && (
                            <p
                              aria-label="Live output"
                              className="text-xs break-words whitespace-pre-wrap"
                            >
                              {liveText}
                            </p>
                          )}
                        </div>
                      </details>
                    </li>
                  )
                })}
              </ol>
            ) : (
              <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                No step activity is available.
              </div>
            )}
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3 className="size-3.5" />
              Activity and results are saved automatically.
            </p>
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}

function OutcomeSection({
  step,
  active,
}: {
  step?: WorkflowStepRun
  active: boolean
}) {
  const [messages, setMessages] = useState<Message[]>([])
  useEffect(() => {
    if (!step?.conversationId) {
      setMessages([])
      return
    }
    let cancelled = false
    const refresh = () =>
      window.cowork.db.messages
        .list(step.conversationId!)
        .then((list) => {
          if (!cancelled) setMessages(list)
        })
        .catch(() => {
          if (!cancelled) toast.error("Could not load run outcome")
        })
    void refresh()
    const timer = setInterval(() => void refresh(), 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [step?.conversationId])

  const response = messages.findLast(
    (message) => message.role === "assistant" && message.content?.trim()
  )?.content
  const outcome = step?.result ?? step?.error ?? response

  return (
    <section aria-label="Run outcome" className="rounded-xl border bg-card">
      <details className="group" open>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 font-medium focus-visible:outline-2 focus-visible:outline-ring">
          <span>Outcome</span>
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="border-t px-4 py-3 text-muted-foreground">
          <p className="mb-3 flex items-start gap-2 text-xs">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              AI-generated results can make mistakes or overlook important
              details. Review findings and verify critical information before
              relying on them.
            </span>
          </p>
          {active ? (
            <p className="text-xs">
              Workflow results will appear here when the run finishes.
            </p>
          ) : outcome ? (
            <p className="break-words whitespace-pre-wrap">{outcome}</p>
          ) : (
            <p className="text-xs">No agent response is available.</p>
          )}
        </div>
      </details>
    </section>
  )
}

function StepTranscript({ step }: { step: WorkflowStepRun }) {
  const [messages, setMessages] = useState<Message[]>([])
  useEffect(() => {
    if (!step.conversationId) return
    let cancelled = false
    const refresh = () =>
      window.cowork.db.messages
        .list(step.conversationId!)
        .then((list) => {
          if (!cancelled) setMessages(list)
        })
        .catch(() => {
          if (!cancelled) toast.error("Could not load step transcript")
        })
    void refresh()
    const timer = setInterval(() => void refresh(), 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [step.conversationId])
  const callIds = new Set(
    messages.flatMap(
      (message) => message.toolCalls?.map((call) => call.id) ?? []
    )
  )
  const responses = new Map<string, Message[]>()
  for (const message of messages) {
    if (message.role !== "tool" || !message.toolCallId) continue
    const results = responses.get(message.toolCallId) ?? []
    results.push(message)
    responses.set(message.toolCallId, results)
  }
  const transcript = messages.filter(
    (message) =>
      message.role !== "tool" ||
      !message.toolCallId ||
      !callIds.has(message.toolCallId)
  )
  return (
    <div className="space-y-3" aria-label="Step transcript">
      {transcript.map((message) => (
        <div key={message.id} className="rounded-lg bg-muted/60 p-3 text-xs">
          <p className="font-medium">{message.toolName ?? message.role}</p>
          <p className="break-words whitespace-pre-wrap">{message.content}</p>
          {message.toolCalls?.map((call) => (
            <details key={call.id} className="mt-2">
              <summary className="flex cursor-pointer list-none items-center gap-1 focus-visible:outline-2 focus-visible:outline-ring">
                <Wrench className="size-3" />
                {call.name}
              </summary>
              <div className="mt-2 space-y-2">
                <p className="font-medium">Arguments</p>
                <pre className="break-words whitespace-pre-wrap">
                  {call.arguments}
                </pre>
                {responses.get(call.id)?.map((response) => (
                  <div key={response.id} className="space-y-1 border-t pt-2">
                    <p className="font-medium">Response</p>
                    <pre className="break-words whitespace-pre-wrap">
                      {response.content}
                    </pre>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      ))}
    </div>
  )
}
