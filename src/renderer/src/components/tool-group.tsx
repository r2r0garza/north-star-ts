import { useState } from "react"
import {
  BookOpen,
  Check,
  CircleAlert,
  CircleSlash,
  FilePlus,
  FileText,
  FolderOpen,
  Pencil,
  Search,
  ShieldAlert,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react"
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
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { ToolMediaPreview } from "@/components/tool-media-preview"
import { cn } from "@/lib/utils"
import { isErrorResult, type ToolUse } from "@/lib/timeline"
import { allowsKindWide, kindWideLabel } from "../../../shared/approval-scope"

// How the user resolved an inline approval. `requestId` is the token from the
// approval event. `remember` persists an allowlist rule so the same action isn't
// prompted again — `"workspace"` for every session in this folder,
// `"conversation"` for just this session.
export type ApprovalHandler = (
  requestId: string,
  decision: "approved" | "denied",
  remember?: "workspace" | "conversation" | "kind" | "file_changes"
) => void

// Icon per tool name; falls back to a generic wrench for anything unmapped.
const ICONS: Record<string, LucideIcon> = {
  read_file_tool: FileText,
  edit_file_tool: Pencil,
  write_file_tool: FilePlus,
  search_tool: Search,
  list_files_tool: FolderOpen,
  read_skill: BookOpen,
  run_shell_tool: Terminal,
  spawn_subagent: Users,
  spawn_subagents: Users,
}
const iconFor = (name: string): LucideIcon => ICONS[name] ?? Wrench

// Cap result text shown in the UI (the full text stays in the DB and the
// model's context — this is display-only).
const MAX_RESULT_CHARS = 4000
function clip(text: string): string {
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]`
    : text
}

function approvalDiff(detail: Record<string, unknown> | undefined):
  | {
      diff: string
      additions?: number
      deletions?: number
      truncated?: boolean
    }
  | undefined {
  const diff = detail?.diff
  if (!diff || typeof diff !== "object") return undefined
  const d = diff as Record<string, unknown>
  return typeof d.diff === "string"
    ? {
        diff: d.diff,
        additions: typeof d.additions === "number" ? d.additions : undefined,
        deletions: typeof d.deletions === "number" ? d.deletions : undefined,
        truncated: d.truncated === true,
      }
    : undefined
}

function shellApprovalDetails(
  detail: Record<string, unknown> | undefined
): string[] {
  const analysis = detail?.shellAnalysis
  if (!analysis || typeof analysis !== "object") return []
  const a = analysis as Record<string, unknown>
  const segments = Array.isArray(a.segments) ? a.segments : []
  const executables = segments
    .map((segment) =>
      segment && typeof segment === "object"
        ? (segment as Record<string, unknown>).executable
        : undefined
    )
    .filter((value): value is string => typeof value === "string" && !!value)
  const network = Array.isArray(a.networkOperations)
    ? a.networkOperations.filter(
        (value): value is string => typeof value === "string" && !!value
      )
    : []
  const outside = Array.isArray(a.outsideWorkspacePaths)
    ? a.outsideWorkspacePaths.filter(
        (value): value is string => typeof value === "string" && !!value
      )
    : []
  const writes = Array.isArray(a.candidateWritePaths)
    ? a.candidateWritePaths.filter(
        (value): value is string => typeof value === "string" && !!value
      )
    : []
  const reasons = Array.isArray(a.reasons)
    ? a.reasons.filter(
        (value): value is string => typeof value === "string" && !!value
      )
    : []
  return [
    executables.length ? `Commands: ${executables.join(", ")}` : "",
    network.length ? `Network: ${network.join(", ")}` : "",
    outside.length ? `Outside workspace: ${outside.join(", ")}` : "",
    writes.length ? `Writes: ${writes.join(", ")}` : "",
    reasons.length ? `Syntax: ${reasons.join(", ")}` : "",
  ].filter(Boolean)
}

function browserApprovalDetails(
  detail: Record<string, unknown> | undefined
): string[] {
  if (!detail) return []
  const actionType =
    typeof detail.actionType === "string" ? detail.actionType : undefined
  const origin = typeof detail.origin === "string" ? detail.origin : undefined
  const target = typeof detail.target === "string" ? detail.target : undefined
  const payloadSummary =
    typeof detail.payloadSummary === "string"
      ? detail.payloadSummary
      : undefined
  if (!actionType && !origin && !target && !payloadSummary) return []
  return [
    actionType ? `Action: ${actionType}` : "",
    origin ? `Origin: ${origin}` : "",
    target ? `Target: ${target}` : "",
    payloadSummary ? `Payload: ${payloadSummary}` : "",
  ].filter(Boolean)
}

// Approval waits are not execution. Aggregate precedence: running, approval, failure, settled.
export function ToolGroup({ calls }: { calls: ToolUse[] }) {
  const [open, setOpen] = useState(false)
  if (calls.length === 1) {
    return (
      <Trace>
        <ToolUseRow key={calls[0].id} use={calls[0]} />
      </Trace>
    )
  }
  const awaiting = calls.filter(
    (call) => call.approval?.status === "pending"
  ).length
  const running = calls.filter(
    (call) => call.status === "running" && call.approval?.status !== "pending"
  ).length
  const failed = calls.filter((call) => call.status === "error").length
  const interrupted = calls.filter(
    (call) => call.status === "interrupted"
  ).length
  const status = running
    ? "running"
    : awaiting
      ? "pending"
      : failed
        ? "error"
        : undefined
  const summary = [
    running && `${running} running`,
    awaiting && `${awaiting} awaiting approval`,
    failed && `${failed} failed`,
    interrupted && `${interrupted} interrupted`,
  ]
    .filter(Boolean)
    .join(", ")
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={status}>
            <TraceIcon>
              <Wrench />
            </TraceIcon>
            <TraceTitle>
              {calls.length} tool use{calls.length === 1 ? "" : "s"}
              {summary && ` — ${summary}`}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {open &&
              calls.map((call) => <ToolUseRow key={call.id} use={call} />)}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

interface SubagentDisplayResult {
  id: string
  status: string
  identity: string
  access: string
  content?: string
  error?: string
  conversationId?: string
  durationMs?: number
  usage?: { totalTokens?: number }
  branch?: string
  commits?: string[]
  touchedFileCount?: number
  mergeability?: string
  integrationBranch?: string
  integrationStatus?: string
}

function subagentResults(
  result: string | undefined
): SubagentDisplayResult[] | null {
  if (!result || result.startsWith("ERROR[")) return null
  try {
    const parsed = JSON.parse(result) as { results?: unknown }
    if (!Array.isArray(parsed.results)) return null
    return parsed.results.filter(
      (item): item is SubagentDisplayResult =>
        !!item &&
        typeof item === "object" &&
        typeof (item as SubagentDisplayResult).id === "string"
    )
  } catch {
    return null
  }
}

function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined
  if (durationMs < 1_000) return `${durationMs} ms`
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`
}

function SubagentResults({ results }: { results: SubagentDisplayResult[] }) {
  return (
    <Trace>
      {results.map((result) => (
        <TraceCollapsible key={result.id}>
          <TraceCollapsibleTrigger>
            <TraceLine status={subagentStatus(result.status)}>
              <TraceIcon>
                <Users />
              </TraceIcon>
              <TraceTitle className="overflow-visible break-words text-clip whitespace-normal">
                {result.id} — {result.status}
              </TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent className="text-xs">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium">{result.id}</span>
              <span className="rounded bg-background px-1.5 py-0.5 text-[0.65rem] text-muted-foreground">
                {result.identity} · {result.access}
              </span>
              <span
                className={cn(
                  "ml-auto text-[0.7rem]",
                  result.status === "completed"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : subagentStatus(result.status) === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                )}
              >
                {result.status}
              </span>
            </div>
            {(result.content || result.error) && (
              <p className="mt-1.5 break-words whitespace-pre-wrap text-muted-foreground">
                {clip(result.error ?? result.content ?? "")}
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[0.68rem] text-muted-foreground">
              {formatDuration(result.durationMs) && (
                <span>{formatDuration(result.durationMs)}</span>
              )}
              {result.usage?.totalTokens !== undefined && (
                <span>{result.usage.totalTokens.toLocaleString()} tokens</span>
              )}
              {result.touchedFileCount !== undefined && (
                <span>{result.touchedFileCount} files</span>
              )}
              {result.commits?.length ? (
                <span>{result.commits.length} commits</span>
              ) : null}
              {result.mergeability && <span>merge: {result.mergeability}</span>}
              {result.branch && (
                <span className="font-mono">{result.branch}</span>
              )}
              {result.integrationStatus && (
                <span>integration: {result.integrationStatus}</span>
              )}
              {result.integrationBranch && (
                <span className="font-mono">{result.integrationBranch}</span>
              )}
              {result.conversationId && (
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("open-conversation", {
                        detail: { conversationId: result.conversationId },
                      })
                    )
                  }
                >
                  Open transcript
                </button>
              )}
            </div>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      ))}
    </Trace>
  )
}

function subagentStatus(status: string) {
  if (["active", "running", "in_progress"].includes(status)) return "running"
  if (["pending", "queued", "waiting", "waiting_for_approval"].includes(status))
    return "pending"
  if (["failed", "error"].includes(status)) return "error"
  return undefined
}

function ToolUseRow({ use }: { use: ToolUse }) {
  const [open, setOpen] = useState(false)
  const Icon = iconFor(use.name)
  const error = use.status === "error"
  const interrupted = use.status === "interrupted"
  const awaiting = use.approval?.status === "pending"
  const delegated =
    use.name === "spawn_subagents" ? subagentResults(use.result) : null
  const status = awaiting
    ? "pending"
    : use.status === "running"
      ? "running"
      : error
        ? "error"
        : undefined
  const label = awaiting
    ? "Awaiting approval"
    : error
      ? "Failed"
      : interrupted
        ? "Interrupted"
        : use.status === "running"
          ? "Running"
          : undefined
  return (
    <TraceCollapsible open={open} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={status}>
          <TraceIcon>{interrupted ? <CircleSlash /> : <Icon />}</TraceIcon>
          <TraceTitle>{use.label || use.name}</TraceTitle>
          {label && (
            <TraceDescription className="shrink whitespace-normal">
              {label}
            </TraceDescription>
          )}
          {use.status === "done" && (
            <TraceIcon>
              <Check />
            </TraceIcon>
          )}
          {error && (
            <TraceIcon>
              <CircleAlert />
            </TraceIcon>
          )}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="text-xs">
        <div className="flex max-w-full min-w-0 flex-col gap-2">
          {(use.args || use.rawArgs) && (
            <pre className="w-full max-w-full min-w-0 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-muted-foreground">
              {use.args ? JSON.stringify(use.args, null, 2) : use.rawArgs}
            </pre>
          )}
          {delegated ? (
            <SubagentResults results={delegated} />
          ) : (
            use.result !== undefined && (
              <Bubble
                align="start"
                variant={isErrorResult(use.result) ? "destructive" : "muted"}
              >
                <BubbleContent>
                  <pre className="max-h-64 overflow-auto break-words whitespace-pre-wrap">
                    {clip(use.result)}
                  </pre>
                </BubbleContent>
              </Bubble>
            )
          )}
          {open && use.media && use.media.length > 0 && (
            <ToolMediaPreview
              key={`${use.conversationId}:${use.resultMessageId}`}
              media={use.media}
              conversationId={use.conversationId}
              messageId={use.resultMessageId}
            />
          )}
          {interrupted && (
            <Bubble align="start" variant="muted">
              <BubbleContent>
                This request was interrupted before it finished and wasn't
                completed. Send a new message to try again.
              </BubbleContent>
            </Bubble>
          )}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

// Approval prompt for a gated tool action. Shows the action summary and why it
// was flagged, with Approve / Always-allow-in-workspace / Deny actions. Rendered
// above the composer (App.tsx) so it stays put while the transcript scrolls.
export function ApprovalCard({
  approval,
  onApproval,
  runLabel = "conversation",
}: {
  approval: NonNullable<ToolUse["approval"]>
  onApproval: ApprovalHandler
  // What a kind-wide grant covers, for the button label: a background task's
  // grant is scoped to its own worker conversation, i.e. "this task".
  runLabel?: "conversation" | "task"
}) {
  const { requestId } = approval
  // Delegation (handing work to a background task) is asked every time — there's
  // no "always allow" for it, so hide that affordance for delegate approvals.
  const allowRemember = approval.kind !== "delegate" && !approval.explicit
  // Web and browser approvals are tied to current external/session state, so
  // their "remember" is scoped to this conversation. Other gated actions remember
  // per workspace.
  const isWeb = approval.kind === "web"
  const isBrowser = approval.kind === "browser"
  // Coarser grant: every action of this kind for this conversation/task.
  const allowKind = allowRemember && allowsKindWide(approval.kind)
  const webOrigin =
    isWeb && typeof approval.detail?.origin === "string"
      ? approval.detail.origin
      : null
  const diff = approvalDiff(approval.detail)
  const shellDetails = shellApprovalDetails(approval.detail)
  const browserDetails = browserApprovalDetails(approval.detail)
  return (
    <div className="flex max-h-[50dvh] min-h-0 min-w-0 flex-col gap-2 overflow-hidden rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
      <div
        data-slot="approval-details"
        tabIndex={0}
        role="region"
        aria-label="Approval details"
        className="min-h-0 space-y-2 overflow-auto [overflow-wrap:anywhere]"
      >
        <div className="flex items-center gap-2 font-medium text-destructive">
          <ShieldAlert className="size-3.5 shrink-0" />
          <span>
            {approval.explicit
              ? "Explicit approval required"
              : "Approval required"}{" "}
            — {approval.reason}
          </span>
        </div>
        <pre className="max-w-full overflow-hidden rounded-md bg-muted px-2 py-1.5 break-words whitespace-pre-wrap text-muted-foreground">
          {approval.summary}
        </pre>
        {shellDetails.length > 0 && (
          <div className="rounded-md border bg-background px-2 py-1.5 text-muted-foreground">
            {shellDetails.map((line) => (
              <div key={line} className="break-words">
                {line}
              </div>
            ))}
          </div>
        )}
        {browserDetails.length > 0 && (
          <div className="rounded-md border bg-background px-2 py-1.5 text-muted-foreground">
            {browserDetails.map((line) => (
              <div key={line} className="break-words">
                {line}
              </div>
            ))}
          </div>
        )}
        {diff && (
          <div className="max-w-full min-w-0 rounded-md border bg-background">
            <div className="flex items-center justify-between gap-2 border-b px-2 py-1 text-[0.7rem] text-muted-foreground">
              <span>
                {diff.additions ?? 0} additions, {diff.deletions ?? 0} deletions
              </span>
              {diff.truncated && <span>Preview truncated</span>}
            </div>
            <pre className="max-h-56 max-w-full overflow-auto px-2 py-1.5 font-mono text-[0.7rem] leading-4 whitespace-pre">
              {diff.diff}
            </pre>
          </div>
        )}
      </div>
      <div
        data-slot="approval-actions"
        className="flex shrink-0 flex-wrap items-center gap-2"
      >
        <Button size="xs" onClick={() => onApproval(requestId, "approved")}>
          Approve once
          <Kbd className="ml-1.5">⏎</Kbd>
        </Button>
        {allowRemember &&
          (isWeb || isBrowser ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onApproval(requestId, "approved", "conversation")}
            >
              {webOrigin
                ? `Allow reads from ${webOrigin} for this conversation`
                : "Approve for this session"}
              <Kbd className="ml-1.5">S</Kbd>
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onApproval(requestId, "approved", "workspace")}
            >
              Always allow in this workspace
              <Kbd className="ml-1.5">S</Kbd>
            </Button>
          ))}
        {allowKind && approval.kind && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onApproval(requestId, "approved", "kind")}
          >
            Allow all {kindWideLabel(approval.kind)} for this {runLabel}
            <Kbd className="ml-1.5">A</Kbd>
          </Button>
        )}
        {allowKind && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => onApproval(requestId, "approved", "file_changes")}
          >
            Allow all file changes for this {runLabel}
            <Kbd className="ml-1.5">F</Kbd>
          </Button>
        )}
        <Button
          size="xs"
          variant="destructive"
          onClick={() => onApproval(requestId, "denied")}
        >
          Deny
          <Kbd className="ml-1.5">Esc</Kbd>
        </Button>
      </div>
    </div>
  )
}
