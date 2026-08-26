import { useState } from "react"
import {
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  CircleSlash,
  FilePlus,
  FileText,
  FolderOpen,
  Pencil,
  Search,
  ShieldAlert,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Marker, MarkerIcon, MarkerContent } from "@/components/ui/marker"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { isErrorResult, type ToolUse } from "@/lib/timeline"

// How the user resolved an inline approval. `requestId` is the token from the
// approval event. `remember` persists an allowlist rule so the same action isn't
// prompted again — `"workspace"` for every session in this folder,
// `"conversation"` for just this session.
export type ApprovalHandler = (
  requestId: string,
  decision: "approved" | "denied",
  remember?: "workspace" | "conversation"
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

// A collapsible group of tool calls for one assistant turn. Collapsed by
// default; summary shows the count (and a spinner while any call is running).
// A pending approval no longer force-opens the group: the approval prompt now
// renders above the composer (see App.tsx), not inline here. The running row
// just shows an "awaiting approval" hint.
export function ToolGroup({ calls }: { calls: ToolUse[] }) {
  const anyRunning = calls.some((c) => c.status === "running")
  const n = calls.length

  const [open, setOpen] = useState(false)

  return (
    <Collapsible
      className="w-full max-w-full min-w-0"
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger asChild>
        <button type="button" className="group/tg w-full text-left">
          <Marker>
            <MarkerIcon>
              {anyRunning ? (
                <Spinner />
              ) : (
                <ChevronRight className="transition-transform group-data-[state=open]/tg:rotate-90" />
              )}
            </MarkerIcon>
            <MarkerContent>
              {n} tool use{n === 1 ? "" : "s"}
            </MarkerContent>
          </Marker>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="max-w-full min-w-0">
        <div className="mt-1 flex max-w-full min-w-0 flex-col gap-1 pl-2">
          {calls.map((c) => (
            <ToolUseRow key={c.id} use={c} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// One tool call: a collapsible row whose trigger is the labeled marker and whose
// content reveals the arguments and the result/output. When the action is
// awaiting human approval, the row shows an "awaiting approval" hint — the
// actionable prompt itself renders above the composer (see App.tsx).
function ToolUseRow({ use }: { use: ToolUse }) {
  const Icon = iconFor(use.name)
  const error = use.status === "error"
  const interrupted = use.status === "interrupted"
  const awaiting = use.approval?.status === "pending"
  return (
    <div className="flex max-w-full min-w-0 flex-col gap-1">
      <Collapsible className="w-full max-w-full min-w-0">
        <CollapsibleTrigger asChild>
          <button type="button" className="group/row w-full text-left">
            <Marker
              className={cn(
                error && "text-destructive",
                interrupted && "text-muted-foreground"
              )}
            >
              <MarkerIcon>
                {use.status === "running" ? (
                  <Spinner />
                ) : interrupted ? (
                  <CircleSlash />
                ) : (
                  <Icon />
                )}
              </MarkerIcon>
              <MarkerContent>{use.label}</MarkerContent>
              {awaiting && (
                <span className="ml-auto flex items-center gap-1 text-[0.7rem] text-destructive">
                  <ShieldAlert className="size-3.5 shrink-0" /> awaiting
                  approval
                </span>
              )}
              {interrupted && (
                <span className="ml-auto flex items-center gap-1 text-[0.7rem] text-muted-foreground">
                  <CircleSlash className="size-3.5 shrink-0" /> interrupted
                </span>
              )}
              {use.status === "done" && (
                <Check className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              {error && (
                <CircleAlert className="size-3.5 shrink-0 text-destructive" />
              )}
            </Marker>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="max-w-full min-w-0">
          <div className="mt-1 flex max-w-full min-w-0 flex-col gap-2 pl-6 text-xs">
            {(use.args || use.rawArgs) && (
              <pre className="w-full max-w-full min-w-0 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-muted-foreground">
                {use.args ? JSON.stringify(use.args, null, 2) : use.rawArgs}
              </pre>
            )}
            {use.result !== undefined && (
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
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

// Approval prompt for a gated tool action. Shows the action summary and why it
// was flagged, with Approve / Always-allow-in-workspace / Deny actions. Rendered
// above the composer (App.tsx) so it stays put while the transcript scrolls.
export function ApprovalCard({
  approval,
  onApproval,
}: {
  approval: NonNullable<ToolUse["approval"]>
  onApproval: ApprovalHandler
}) {
  const { requestId } = approval
  // Delegation (handing work to a background task) is asked every time — there's
  // no "always allow" for it, so hide that affordance for delegate approvals.
  const allowRemember = approval.kind !== "delegate"
  // Web access (web_fetch) is workspace-independent, so its "remember" is scoped
  // to the session ("this conversation") rather than the workspace folder. Every
  // other gated action remembers per workspace.
  const isWeb = approval.kind === "web"
  const diff = approvalDiff(approval.detail)
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
      <div className="flex items-center gap-2 font-medium text-destructive">
        <ShieldAlert className="size-3.5 shrink-0" />
        <span>Approval required — {approval.reason}</span>
      </div>
      <pre className="max-w-full overflow-hidden rounded-md bg-muted px-2 py-1.5 break-words whitespace-pre-wrap text-muted-foreground">
        {approval.summary}
      </pre>
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
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" onClick={() => onApproval(requestId, "approved")}>
          Approve once
          <Kbd className="ml-1.5">⏎</Kbd>
        </Button>
        {allowRemember &&
          (isWeb ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => onApproval(requestId, "approved", "conversation")}
            >
              Approve for this session
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
