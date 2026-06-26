import {
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  FilePlus,
  FileText,
  FolderOpen,
  Pencil,
  Search,
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
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { isErrorResult, type ToolUse } from "@/lib/timeline"

// Icon per tool name; falls back to a generic wrench for anything unmapped.
const ICONS: Record<string, LucideIcon> = {
  read_file_tool: FileText,
  edit_file_tool: Pencil,
  write_file_tool: FilePlus,
  search_tool: Search,
  list_files_tool: FolderOpen,
  read_skill: BookOpen,
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

// A collapsible group of tool calls for one assistant turn. Collapsed by
// default; summary shows the count (and a spinner while any call is running).
export function ToolGroup({ calls }: { calls: ToolUse[] }) {
  const anyRunning = calls.some((c) => c.status === "running")
  const n = calls.length
  return (
    <Collapsible className="w-full">
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
      <CollapsibleContent>
        <div className="mt-1 flex flex-col gap-1 pl-2">
          {calls.map((c) => (
            <ToolUseRow key={c.id} use={c} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// One tool call: a collapsible row whose trigger is the labeled marker and whose
// content reveals the arguments and the result/output.
function ToolUseRow({ use }: { use: ToolUse }) {
  const Icon = iconFor(use.name)
  const error = use.status === "error"
  return (
    <Collapsible className="w-full">
      <CollapsibleTrigger asChild>
        <button type="button" className="group/row w-full text-left">
          <Marker className={cn(error && "text-destructive")}>
            <MarkerIcon>
              {use.status === "running" ? <Spinner /> : <Icon />}
            </MarkerIcon>
            <MarkerContent>{use.label}</MarkerContent>
            {use.status === "done" && (
              <Check className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {error && <CircleAlert className="size-3.5 shrink-0 text-destructive" />}
          </Marker>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 flex flex-col gap-2 pl-6 text-xs">
          {(use.args || use.rawArgs) && (
            <pre className="overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-muted-foreground">
              {use.args ? JSON.stringify(use.args, null, 2) : use.rawArgs}
            </pre>
          )}
          {use.result !== undefined && (
            <Bubble align="start" variant={isErrorResult(use.result) ? "destructive" : "muted"}>
              <BubbleContent>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                  {clip(use.result)}
                </pre>
              </BubbleContent>
            </Bubble>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
