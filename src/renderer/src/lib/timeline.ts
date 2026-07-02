import type { Message as DbMessage } from "@/types"

// The transcript is rendered from a timeline of items rather than a flat list of
// messages, so tool activity can be interleaved with text in the order it
// happened. Built from stored rows (buildTimeline) for reload, and assembled
// live from stream events during a turn — both produce the same shapes so they
// render identically.

// "interrupted" is reload-only: a persisted tool_call with no result message,
// meaning the turn was abandoned (app quit / live chat left parked on an
// approval gate) before the tool ran. The live stream never produces it — it
// distinguishes "this call was never finished and won't be" from a call that is
// actively "running" in an in-flight turn, so the UI shows a settled note rather
// than a perpetual spinner. Live chat is ephemeral: the user just retries.
export type ToolStatus = "running" | "done" | "error" | "interrupted"

// A pending/resolved human-approval request for a gated tool action. Live-only:
// it exists during a turn while the agent waits on a decision, and is never
// persisted — buildTimeline (reload) never reconstructs it.
export interface ToolApproval {
  requestId: string // process-unique token echoed back to resolve this request
  summary: string // e.g. "$ rm -rf build"
  reason: string // why it's flagged, e.g. "recursive delete"
  status: "pending" | "approved" | "denied"
  // The action kind, when known. "delegate" (handing work to the background) is
  // asked every time, so its card hides the "always allow" affordance.
  kind?: string
}

// A single tool call and (once it finishes) its result. `id` is the tool_call
// id — it's the React key and the join between a live "start" and "done" event,
// and matches the persisted toolCallId.
export interface ToolUse {
  id: string
  name: string // raw tool name, e.g. "read_file_tool"
  label: string // human label, e.g. "Read README.md"
  args: Record<string, unknown> | null // parsed arguments (null if unparseable)
  rawArgs: string // original JSON string (shown verbatim if parse failed)
  result?: string // tool output (undefined while running)
  status: ToolStatus
  approval?: ToolApproval // set while a gated action awaits a human decision
}

export type TimelineItem =
  | { kind: "text"; key: string; role: "user" | "assistant"; content: string }
  | { kind: "tools"; key: string; calls: ToolUse[] }

// Last path segment, e.g. "/Users/me/app/README.md" -> "README.md".
export function baseName(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/)
  return parts[parts.length - 1] || path
}

// Parse a tool-call arguments JSON string into an object, or null on failure.
export function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || "{}")
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// A human-readable label for a tool call, derived from its name + arguments.
export function deriveLabel(
  name: string,
  args: Record<string, unknown> | null
): string {
  const a = args ?? {}
  const path = typeof a.path === "string" ? a.path : ""
  switch (name) {
    case "read_file_tool":
      return path ? `Read ${baseName(path)}` : "Read file"
    case "edit_file_tool":
      return path ? `Edited ${baseName(path)}` : "Edited file"
    case "write_file_tool":
      return path ? `Wrote ${baseName(path)}` : "Wrote file"
    case "search_tool": {
      const pat = typeof a.pattern === "string" ? a.pattern : ""
      return pat ? `Searched "${pat}"` : "Searched"
    }
    case "list_files_tool":
      return `Listed ${path || "files"}`
    case "read_skill": {
      const skill = typeof a.name === "string" ? a.name : ""
      return skill ? `Read skill ${skill}` : "Read skill"
    }
    case "todo_write": {
      // No `todos` arg → a read. Otherwise summarize the write by status count.
      const todos = Array.isArray(a.todos) ? a.todos : null
      if (!todos) return "Read task list"
      if (todos.length === 0) return "Cleared task list"
      const count = (s: string) =>
        todos.filter(
          (t) => t && typeof t === "object" && (t as any).status === s
        ).length
      const parts: string[] = []
      const inProgress = count("in_progress")
      const done = count("completed")
      if (inProgress) parts.push(`${inProgress} in progress`)
      if (done) parts.push(`${done} done`)
      const suffix = parts.length ? ` — ${parts.join(", ")}` : ""
      return `Updated task list (${todos.length} item${todos.length === 1 ? "" : "s"})${suffix}`
    }
    case "run_todos_in_background":
      return "Run tasks in the background"
    default:
      return name
  }
}

// A tool result is an error if it starts with the structured ERROR[...] prefix
// emitted by toolError() in src/main/agent/tools/output.ts.
export function isErrorResult(result?: string): boolean {
  return !!result && result.startsWith("ERROR[")
}

// Build a ToolUse from a persisted/streamed tool call (without a result yet).
export function toToolUse(call: {
  id: string
  name: string
  arguments: string
}): ToolUse {
  const args = parseArgs(call.arguments)
  return {
    id: call.id,
    name: call.name,
    label: deriveLabel(call.name, args),
    args,
    rawArgs: call.arguments,
    status: "running",
  }
}

// Rebuild the render timeline from stored message rows (seq ASC). User/assistant
// rows with text become text items; assistant rows with tool_calls become a
// tools group; role:"tool" rows attach their result to the matching call by id.
// An assistant row with BOTH preamble text and tool calls emits both.
export function buildTimeline(rows: DbMessage[]): TimelineItem[] {
  const items: TimelineItem[] = []
  const callById = new Map<string, ToolUse>()

  for (const m of rows) {
    if (m.role === "user") {
      if (m.content?.trim()) {
        items.push({
          kind: "text",
          key: m.id,
          role: "user",
          content: m.content,
        })
      }
      continue
    }
    if (m.role === "assistant") {
      if (m.content?.trim()) {
        items.push({
          kind: "text",
          key: `${m.id}:text`,
          role: "assistant",
          content: m.content,
        })
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        const calls = m.toolCalls.map((tc) => {
          const use = toToolUse(tc)
          callById.set(tc.id, use)
          return use
        })
        items.push({ kind: "tools", key: `${m.id}:tools`, calls })
      }
      continue
    }
    if (m.role === "tool" && m.toolCallId) {
      const use = callById.get(m.toolCallId)
      if (use) {
        use.result = m.content ?? ""
        use.status = isErrorResult(use.result) ? "error" : "done"
      }
    }
    // role:"system" is never persisted; ignore if present.
  }

  // Any call still "running" after replaying all stored rows never got a result
  // message: the turn was abandoned mid-flight. Mark it "interrupted" so it
  // renders as a settled note instead of a forever-spinning row. (A genuinely
  // in-flight turn streams through liveTools, not buildTimeline, so this only
  // ever catches truly dangling calls.) The next user message repairs the
  // transcript main-side (repairDanglingToolCalls) so the conversation continues.
  for (const use of callById.values()) {
    if (use.status === "running") use.status = "interrupted"
  }

  return items
}
