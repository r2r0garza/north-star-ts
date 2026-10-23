import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ConversationArtifact } from "@/components/conversation-artifact"
import { isCommandCompletionEvent } from "../../../shared/runtime-messages"
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
  Activity,
  Info,
  Pause,
  Play,
  RotateCcw,
  Wrench,
  Terminal,
} from "lucide-react"
import { ScreenHeader } from "@/components/screen-header"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
} from "@/components/ui/trace"
import {
  buildTimeline,
  deriveLabel,
  isErrorResult,
  parseArgs,
} from "@/lib/timeline"
import type { CommandSnapshot } from "@/lib/command-presentation"
import { CommandOutput } from "@/components/command-output"
import { commandPresentation } from "@/lib/command-presentation"
import { transcriptShouldFollow } from "@/lib/transcript-scroll"
import type {
  WorkflowStep,
  WorkflowDefinition,
} from "../../../shared/workflows"

const STATUS_STYLE: Record<string, string> = {
  Completed:
    "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  Paused:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300",
  Active: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  Cancelled: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
}

// Paused/cancelled/interrupted keep their label but no Trace status, so they never animate.
const ACTIVITY_STYLE: Record<
  WorkflowStepRun["status"],
  {
    label: string
    className: string
    Icon: typeof Activity
    trace?: "running" | "error" | "pending"
  }
> = {
  active: {
    label: "Active",
    className: STATUS_STYLE.Active,
    Icon: Activity,
    trace: "running",
  },
  completed: {
    label: "Completed",
    className: STATUS_STYLE.Completed,
    Icon: CircleCheck,
  },
  cancelled: {
    label: "Cancelled",
    className: STATUS_STYLE.Cancelled,
    Icon: CircleX,
  },
  paused: {
    label: "Paused",
    className: STATUS_STYLE.Paused,
    Icon: CirclePause,
  },
  failed: {
    label: "Failed",
    className: STATUS_STYLE.Cancelled,
    Icon: CircleX,
    trace: "error",
  },
  interrupted: {
    label: "Interrupted",
    className: STATUS_STYLE.Paused,
    Icon: CirclePause,
  },
  waiting: {
    label: "Waiting",
    className: "bg-muted text-muted-foreground",
    Icon: Clock3,
    trace: "pending",
  },
}

export function RunDetail(props: {
  run: WorkflowRun
  workflow?: WorkflowDefinition
  onBack: () => void
  onClose: () => void
}) {
  return <RunDetailView key={props.run.id} {...props} />
}

function initialDestination(run: WorkflowRun) {
  if (run.status === "Completed") return "outcome"
  return (
    run.steps.find((step) => step.status === "active")?.id ??
    run.steps.find((step) => !["completed", "waiting"].includes(step.status))
      ?.id ??
    run.steps.findLast((step) => step.status === "completed")?.id ??
    run.steps[0]?.id ??
    "outcome"
  )
}

type ReaderTab = "Transcript" | "Result" | "Details"
type ReadingPosition = { top: number; following: boolean }

function RunDetailView({
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
  const [selectedId, setSelectedId] = useState(() => initialDestination(run))
  const [tab, setTab] = useState<ReaderTab>("Transcript")
  const positions = useRef(new Map<string, ReadingPosition>())
  const following = useRef(true)
  const selectedStep = run.steps.find((step) => step.id === selectedId)
  function select(id: string) {
    setSelectedId(id)
    setTab("Transcript")
  }
  const [controlling, setControlling] = useState(false)
  // The control the feedback modal will run when submitted; null while closed.
  const [feedbackAction, setFeedbackAction] = useState<
    "retry" | "resume" | null
  >(null)
  const [feedback, setFeedback] = useState("")
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
  const previousActive = useRef(activeStepId)
  useEffect(() => {
    if (
      activeStepId &&
      activeStepId !== previousActive.current &&
      selectedId === previousActive.current &&
      tab === "Transcript" &&
      following.current
    ) {
      setSelectedId(activeStepId)
    }
    previousActive.current = activeStepId
  }, [activeStepId, selectedId, tab])
  useEffect(() => {
    setLiveText("")
    return window.cowork.tasks.onEvent(({ taskId, event }) => {
      if (taskId !== run.taskId) return
      if (event.type === "token")
        setLiveText((text) => (text + event.delta).slice(-16000))
      else if (
        (event.type === "tool" && event.phase === "start") ||
        (event.type === "stream_attempt" && event.phase !== "commit")
      )
        setLiveText("")
    })
  }, [run.taskId, activeStepId])
  async function control(
    action: "pause" | "resume" | "cancel" | "retry",
    feedback?: string
  ) {
    setControlling(true)
    try {
      if (action === "retry" || action === "resume") {
        await window.cowork.workflowRuns[action](run.id, feedback)
        setFeedbackAction(null)
        setFeedback("")
      } else await window.cowork.workflowRuns[action](run.id)
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
      <div className="shrink-0 border-b px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <details className="min-w-0 flex-1">
            <summary className="cursor-pointer text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
              Run details{" "}
              <span className="ml-2 text-xs">
                {run.steps.filter((step) => step.status === "completed").length}{" "}
                of {run.steps.length} steps completed
              </span>
            </summary>
            <div className="max-h-48 space-y-2 overflow-auto pt-3 text-sm">
              <p className="break-words whitespace-pre-wrap">{run.objective}</p>
              <p className="break-all text-muted-foreground">
                {run.projectName ?? "No project"} · {run.workspacePath}
              </p>
              <p className="text-xs text-muted-foreground">
                Started {timestamp.toLocaleString()}
                <br />
                Run ID: {run.id}
              </p>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-2">
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
                onClick={() => setFeedbackAction("resume")}
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
                onClick={() => setFeedbackAction("retry")}
              >
                <RotateCcw className="size-4" />
                Retry
              </Button>
            )}
            <Dialog
              open={feedbackAction !== null}
              onOpenChange={(open) => !open && setFeedbackAction(null)}
            >
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {feedbackAction === "resume" ? "Resume run" : "Retry run"}
                  </DialogTitle>
                  <DialogDescription>
                    Optionally tell the agent what to do differently. Your
                    feedback is sent to the unfinished step and its validator.
                  </DialogDescription>
                </DialogHeader>
                <Field>
                  <FieldLabel htmlFor="retry-feedback">
                    Feedback (optional)
                  </FieldLabel>
                  <Textarea
                    id="retry-feedback"
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="e.g. Use the existing test setup instead of installing a new runner."
                    rows={16}
                    className="field-sizing-fixed resize-none"
                    autoFocus
                  />
                </Field>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setFeedbackAction(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    disabled={controlling}
                    onClick={() => void control(feedbackAction!, feedback)}
                  >
                    {feedbackAction === "resume" ? (
                      <>
                        <Play className="size-4" />
                        Resume
                      </>
                    ) : (
                      <>
                        <RotateCcw className="size-4" />
                        Retry
                      </>
                    )}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
        {run.error && (
          <p role="alert" className="mt-2 text-destructive">
            {run.error}
          </p>
        )}
        {run.indexing && run.indexing !== "ready" && (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {run.indexing === "running"
              ? "Indexing workspace before the first step…"
              : run.indexing === "timed_out"
                ? "Steps started with a partial workspace index."
                : "Workspace indexing failed; steps ran without the index."}
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label="Run steps"
          className="hidden w-64 shrink-0 overflow-y-auto border-r p-3 md:block"
        >
          <p className="px-3 py-2 text-xs text-muted-foreground">Steps</p>
          <ol className="space-y-1">
            {run.steps.map((step, index) => {
              const display = ACTIVITY_STYLE[step.status]
              const Icon = display.Icon
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    aria-current={selectedId === step.id ? "step" : undefined}
                    onClick={() => select(step.id)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring",
                      selectedId === step.id
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted"
                    )}
                  >
                    <TraceLine
                      status={display.trace}
                      className="w-full flex-wrap items-start gap-x-2 gap-y-0 text-inherit"
                    >
                      <TraceIcon className="mt-0.5">
                        <Icon
                          className={cn(
                            step.status === "active" && "text-primary"
                          )}
                        />
                      </TraceIcon>
                      {/* Plain span, not TraceTitle: shimmer is invisible on foreground text, so the muted label carries it. */}
                      <span className="min-w-0 flex-1 font-medium break-words">
                        {index + 1}.{" "}
                        {workflow?.steps.find(
                          (definition) => definition.id === step.id
                        )?.title ?? `Step ${index + 1}`}
                      </span>
                      <TraceDescription
                        className={cn(
                          "basis-full pl-6 text-xs text-muted-foreground",
                          display.trace === "running" &&
                            "trace-shimmer motion-reduce:trace-shimmer-none"
                        )}
                      >
                        {display.label}
                      </TraceDescription>
                    </TraceLine>
                  </button>
                </li>
              )
            })}
          </ol>
          <button
            type="button"
            aria-current={selectedId === "outcome" ? "page" : undefined}
            onClick={() => select("outcome")}
            className={cn(
              "mt-4 w-full rounded-md border-t px-3 py-3 text-left font-medium focus-visible:outline-2 focus-visible:outline-ring",
              selectedId === "outcome" ? "bg-accent" : "hover:bg-muted"
            )}
          >
            Run outcome
          </button>
        </nav>
        <div className="shrink-0 border-b p-3 md:hidden">
          <label htmlFor="run-step" className="sr-only">
            Select step
          </label>
          <select
            id="run-step"
            value={selectedId}
            onChange={(event) => select(event.target.value)}
            className="w-full rounded-md border bg-background p-2"
          >
            {run.steps.map((step, index) => (
              <option key={step.id} value={step.id}>
                {index + 1}.{" "}
                {workflow?.steps.find((definition) => definition.id === step.id)
                  ?.title ?? `Step ${index + 1}`}{" "}
                — {ACTIVITY_STYLE[step.status].label}
              </option>
            ))}
            <option value="outcome">Run outcome</option>
          </select>
        </div>
        <main
          aria-label="Run reader"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <div className="shrink-0 border-b px-5 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
              <h2 className="min-w-0 font-medium break-words">
                {selectedStep
                  ? (workflow?.steps.find((step) => step.id === selectedId)
                      ?.title ?? `Step ${run.steps.indexOf(selectedStep) + 1}`)
                  : "Run outcome"}
              </h2>
              {activeStepId &&
                (selectedId !== activeStepId || tab !== "Transcript") && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => select(activeStepId)}
                  >
                    View active step
                  </Button>
                )}
              {selectedStep && (
                <Badge variant="secondary">
                  {ACTIVITY_STYLE[selectedStep.status].label}
                </Badge>
              )}
            </div>
            {selectedStep && (
              <div
                role="tablist"
                aria-label="Step content"
                className="flex gap-4"
              >
                {(["Transcript", "Result", "Details"] as const).map((name) => (
                  <button
                    key={name}
                    id={`step-tab-${name}`}
                    role="tab"
                    aria-selected={tab === name}
                    aria-controls="step-panel"
                    tabIndex={tab === name ? 0 : -1}
                    onKeyDown={(event) => {
                      const names: ReaderTab[] = [
                        "Transcript",
                        "Result",
                        "Details",
                      ]
                      const next =
                        event.key === "ArrowRight"
                          ? (names.indexOf(name) + 1) % 3
                          : event.key === "ArrowLeft"
                            ? (names.indexOf(name) + 2) % 3
                            : event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? 2
                                : -1
                      if (next >= 0) {
                        event.preventDefault()
                        setTab(names[next])
                        document
                          .getElementById(`step-tab-${names[next]}`)
                          ?.focus()
                      }
                    }}
                    onClick={() => setTab(name)}
                    className={cn(
                      "border-b-2 px-1 pb-3 focus-visible:outline-2 focus-visible:outline-ring",
                      tab === name
                        ? "border-primary font-medium"
                        : "border-transparent text-muted-foreground"
                    )}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {selectedStep ? (
            <div
              id="step-panel"
              role="tabpanel"
              aria-labelledby={`step-tab-${tab}`}
              className="flex min-h-0 flex-1 flex-col"
            >
              <StepReader
                key={`${selectedStep.id}:${tab}`}
                activity={selectedStep}
                taskId={run.taskId}
                tab={tab}
                definition={workflow?.steps.find(
                  (step) => step.id === selectedId
                )}
                modelLabel={
                  modelLabels[
                    `${selectedStep.accountId ?? run.accountId}::${selectedStep.modelId ?? run.modelId}`
                  ] ??
                  `${selectedStep.accountId ?? run.accountId} · ${selectedStep.modelId ?? run.modelId}`
                }
                liveText={selectedStep.status === "active" ? liveText : ""}
                positions={positions.current}
                onFollowingChange={(value) => {
                  following.current = value
                }}
              />
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto max-w-[80ch] p-5">
                <OutcomeSection
                  step={
                    run.status === "Completed"
                      ? run.steps.at(-1)
                      : (run.steps.find(
                          (step) =>
                            !["completed", "waiting"].includes(step.status)
                        ) ??
                        run.steps.findLast(
                          (step) => step.status === "completed"
                        ))
                  }
                  active={run.status === "Active"}
                />
              </div>
            </ScrollArea>
          )}
        </main>
      </div>
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
    const timer = active ? setInterval(() => void refresh(), 1000) : undefined
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [step?.conversationId, active])

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

function StepReader({
  activity,
  taskId,
  definition,
  modelLabel,
  liveText,
  tab,
  positions,
  onFollowingChange,
}: {
  activity: WorkflowStepRun
  taskId: string | null
  definition?: WorkflowStep
  modelLabel: string
  liveText: string
  tab: ReaderTab
  positions: Map<string, ReadingPosition>
  onFollowingChange: (following: boolean) => void
}) {
  const { messages, loaded } = useStepMessages(activity, tab === "Transcript")
  const [commandUpdates, setCommandUpdates] = useState<Record<string, string>>(
    {}
  )
  useEffect(() => {
    setCommandUpdates({})
    return window.cowork.tasks.onEvent(({ taskId: source, event }) => {
      if (source === taskId && event.type === "command_output") {
        setCommandUpdates((updates) => ({
          ...updates,
          [event.id]: event.result,
        }))
      }
    })
  }, [taskId, activity.id])
  const restored = useRef(false)
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const position = useRef<ReadingPosition>(
    positions.get(activity.id) ?? { top: 0, following: true }
  )
  const [away, setAway] = useState(!position.current.following)
  const [newActivity, setNewActivity] = useState(false)
  const previousOutput = useRef("")
  const output = `${messages.map((message) => `${message.id}:${message.content ?? ""}:${JSON.stringify(message.toolCalls)}`).join("|")}:${liveText}`
  useLayoutEffect(() => {
    if (tab !== "Transcript") {
      onFollowingChange(false)
      return
    }
    const node = viewport.current!
    onFollowingChange(position.current.following)
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            if (position.current.following) {
              node.scrollTop = node.scrollHeight
              position.current.top = node.scrollTop
            }
          })
    if (content.current) observer?.observe(content.current)
    return () => {
      positions.set(activity.id, {
        ...position.current,
        top: restored.current ? node.scrollTop : position.current.top,
      })
      observer?.disconnect()
    }
  }, [activity.id, positions, tab])
  useLayoutEffect(() => {
    if (tab !== "Transcript" || !loaded) return
    if (!restored.current && viewport.current) {
      viewport.current.scrollTop = position.current.following
        ? viewport.current.scrollHeight
        : position.current.top
      position.current.top = viewport.current.scrollTop
      restored.current = true
    }
    if (position.current.following && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight
      position.current.top = viewport.current.scrollTop
    } else if (previousOutput.current && previousOutput.current !== output)
      setNewActivity(true)
    previousOutput.current = output
  }, [output, tab, loaded])
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={viewport}
        aria-label={
          tab === "Transcript" ? "Transcript scroll area" : `${tab} scroll area`
        }
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 focus-visible:outline-2 focus-visible:outline-ring"
        onScroll={(event) => {
          if (tab !== "Transcript" || !restored.current) return
          const node = event.currentTarget
          const following = transcriptShouldFollow(
            position.current.following,
            position.current.top,
            node
          )
          position.current = { top: node.scrollTop, following }
          positions.set(activity.id, position.current)
          onFollowingChange(following)
          setAway(!following)
          if (following) setNewActivity(false)
        }}
      >
        <div
          ref={content}
          className="mx-auto w-full max-w-[80ch] space-y-5 pb-14"
        >
          {tab === "Transcript" ? (
            <>
              {messages.length ? (
                <StepTranscript
                  commandUpdates={commandUpdates}
                  messages={messages}
                  active={activity.status === "active"}
                />
              ) : (
                <p className="text-muted-foreground">
                  {activity.status === "waiting"
                    ? "Waiting for earlier steps."
                    : "No saved messages yet."}
                </p>
              )}
              {activity.status === "active" &&
                liveText &&
                !messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.content?.endsWith(liveText)
                ) && (
                  <p
                    aria-label="Live output"
                    className="break-words whitespace-pre-wrap"
                  >
                    {liveText}
                  </p>
                )}
            </>
          ) : tab === "Result" ? (
            <p
              className={cn(
                "break-words whitespace-pre-wrap",
                activity.error && "text-destructive"
              )}
            >
              {activity.error ??
                activity.result ??
                (activity.status === "active"
                  ? "This step is still running."
                  : activity.status === "waiting"
                    ? "Waiting for earlier steps."
                    : "No saved result is available for this step.")}
            </p>
          ) : (
            <dl className="space-y-5">
              <div>
                <dt className="mb-1 font-medium">Instructions</dt>
                <dd className="break-words whitespace-pre-wrap text-muted-foreground">
                  {definition?.instructions || "No instructions available."}
                </dd>
              </div>
              <div>
                <dt className="mb-1 font-medium">Model</dt>
                <dd className="break-words text-muted-foreground">
                  {modelLabel}
                </dd>
              </div>
              {activity.agentName && (
                <div>
                  <dt className="mb-1 font-medium">Agent</dt>
                  <dd>{activity.agentName}</dd>
                </div>
              )}
              {activity.skillName && (
                <div>
                  <dt className="mb-1 font-medium">Skill</dt>
                  <dd>{activity.skillName}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      </div>
      {tab === "Transcript" && away && (
        <Button
          className="absolute bottom-4 left-1/2 -translate-x-1/2 shadow-sm"
          size="sm"
          variant="secondary"
          onClick={() => {
            const node = viewport.current!
            node.scrollTop = node.scrollHeight
            position.current = { top: node.scrollTop, following: true }
            positions.set(activity.id, position.current)
            onFollowingChange(true)
            setAway(false)
            setNewActivity(false)
          }}
        >
          {newActivity ? "New activity · Jump to latest" : "Jump to latest"}
        </Button>
      )}
    </div>
  )
}

function useStepMessages(step: WorkflowStepRun, open: boolean) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loaded, setLoaded] = useState(!step.conversationId)
  useEffect(() => {
    setMessages([])
    setLoaded(!step.conversationId)
  }, [step.conversationId])
  useEffect(() => {
    if (!open || !step.conversationId) return
    let cancelled = false
    const refresh = () =>
      window.cowork.db.messages
        .list(step.conversationId!)
        .then((list) => {
          if (!cancelled) {
            setMessages(list)
            setLoaded(true)
          }
        })
        .catch(() => {
          if (!cancelled) toast.error("Could not load step transcript")
        })
    void refresh()
    const timer =
      step.status === "active"
        ? setInterval(() => void refresh(), 1000)
        : undefined
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [step.conversationId, step.status, open])
  return { messages, loaded }
}

function StepTranscript({
  messages,
  active,
  commandUpdates,
}: {
  messages: Message[]
  active: boolean
  commandUpdates: Record<string, string>
}) {
  const outcomes = new Map(
    buildTimeline(messages).flatMap((item) =>
      item.kind === "tools"
        ? item.calls.map((call) => [call.id, call.commandOutcome] as const)
        : []
    )
  )
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
      !isCommandCompletionEvent(message.content) &&
      (message.role !== "tool" ||
        !message.toolCallId ||
        !callIds.has(message.toolCallId))
  )
  return (
    <div className="space-y-3" aria-label="Step transcript">
      {transcript.map((message) => (
        <div key={message.id} className="border-b pb-5 last:border-0">
          <p className="font-medium">{message.toolName ?? message.role}</p>
          <p className="break-words whitespace-pre-wrap">{message.content}</p>
          {message.toolCalls?.map((call) => (
            <WorkflowToolCall
              key={call.id}
              call={call}
              responses={responses.get(call.id) ?? []}
              commandLive={commandUpdates[call.id]}
              finalOutcome={outcomes.get(call.id)}
              active={active}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function WorkflowToolCall({
  call,
  responses,
  active,
  commandLive,
  finalOutcome,
}: {
  call: NonNullable<Message["toolCalls"]>[number]
  responses: Message[]
  active: boolean
  commandLive?: string
  finalOutcome?: CommandSnapshot
}) {
  const [open, setOpen] = useState(false)
  const currentResult =
    commandLive ?? (finalOutcome ? JSON.stringify(finalOutcome) : undefined)
  const commands =
    currentResult !== undefined
      ? [commandPresentation(call.name, currentResult)]
      : responses.map((response) =>
          commandPresentation(call.name, response.content ?? "")
        )
  const command =
    commands.find((value) => value?.outcome === "failure") ?? commands.at(-1)
  const args = parseArgs(call.arguments)
  const failed =
    responses.some((response) => isErrorResult(response.content ?? "")) ||
    commands.some((value) => value?.outcome === "failure")
  const running =
    active &&
    (command?.outcome === "reported_running" ||
      (!command && responses.length === 0))
  const artifactResponse = responses.find((response) => response.artifact)
  const presentation = ["present_chart", "present_table"].includes(call.name)
  return (
    <>
      <Trace className="mt-2">
        <TraceCollapsible open={open} onOpenChange={setOpen}>
          <TraceCollapsibleTrigger>
            <TraceLine
              status={failed ? "error" : running ? "running" : undefined}
            >
              <TraceIcon>
                {call.name === "exec_command" ||
                call.name === "run_shell_tool" ? (
                  <Terminal />
                ) : (
                  <Wrench />
                )}
              </TraceIcon>
              <TraceTitle>
                {deriveLabel(
                  call.name,
                  args,
                  failed
                    ? "error"
                    : running
                      ? "running"
                      : !command && responses.length === 0
                        ? "interrupted"
                        : "done"
                )}
              </TraceTitle>
              {(failed || running || command) && (
                <TraceDescription>
                  {failed
                    ? (command?.label ?? "Failed")
                    : running
                      ? "Running"
                      : command?.label}
                </TraceDescription>
              )}
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="space-y-2">
            {!command && (
              <>
                <p className="font-medium">Arguments</p>
                <pre className="break-words whitespace-pre-wrap">
                  {call.arguments}
                </pre>
              </>
            )}
            {currentResult !== undefined && command ? (
              <CommandOutput
                name={call.name}
                args={args}
                rawArgs={call.arguments}
                result={responses.at(-1)?.content ?? undefined}
                presentation={command}
                live={!!commandLive}
              />
            ) : (
              responses.map((response) => (
                <div key={response.id} className="space-y-1 border-t pt-2">
                  <p className="font-medium">Response</p>
                  {commandPresentation(call.name, response.content ?? "") ? (
                    <CommandOutput
                      name={call.name}
                      args={args}
                      rawArgs={call.arguments}
                      result={response.content ?? ""}
                    />
                  ) : (
                    <pre className="break-words whitespace-pre-wrap">
                      {response.content}
                    </pre>
                  )}
                </div>
              ))
            )}
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
      {presentation &&
        !failed &&
        responses.length > 0 &&
        (artifactResponse?.artifact ? (
          <ConversationArtifact
            reference={artifactResponse.artifact}
            conversationId={artifactResponse.conversationId}
          />
        ) : (
          <p role="status" className="my-2 text-sm text-muted-foreground">
            Artifact unavailable: no supported saved reference.
          </p>
        ))}
    </>
  )
}
