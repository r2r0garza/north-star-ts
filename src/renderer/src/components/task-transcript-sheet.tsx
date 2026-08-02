import * as React from "react"
import { CheckCircle2, Ban, Circle, CircleDot } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Message, MessageContent } from "@/components/ui/message"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Markdown } from "@/components/markdown"
import { ToolGroup } from "@/components/tool-group"
import { buildTimeline } from "@/lib/timeline"
import { cn } from "@/lib/utils"
import type { Task, TodoStatus } from "@/types"

// A recorded inline-todo snapshot (input.kind === "inline_todos"). Stored on the
// task at the moment its finished list cleared (see runAgentLoop), so History can
// render the completed checklist without a chat transcript.
interface InlineTodosInput {
  kind: "inline_todos"
  todos: Array<{ itemId: string; content: string; status: TodoStatus }>
}

function asInlineTodos(input: unknown): InlineTodosInput | null {
  if (
    input &&
    typeof input === "object" &&
    (input as { kind?: unknown }).kind === "inline_todos" &&
    Array.isArray((input as { todos?: unknown }).todos)
  ) {
    return input as InlineTodosInput
  }
  return null
}

// Icon + tint per todo status, mirroring the status vocabulary used elsewhere in
// the activity panel.
const TODO_ICON: Record<
  TodoStatus,
  { Icon: typeof CheckCircle2; className: string }
> = {
  completed: { Icon: CheckCircle2, className: "text-primary" },
  cancelled: { Icon: Ban, className: "text-muted-foreground line-through" },
  in_progress: { Icon: CircleDot, className: "text-foreground" },
  pending: { Icon: Circle, className: "text-muted-foreground" },
}

// A read-only viewer for a background task's PRIVATE transcript — the complete
// audit trail (model messages, tool calls, command output, final result) that
// lives in the task's own conversation, isolated from the live chat. Opened from
// a task row in the Workspace Activity panel. Reuses the same timeline + bubble
// + tool-group rendering the live chat uses, minus any input/approval controls
// (gates are resolved from the panel row, not here).
export function TaskTranscriptSheet({
  task,
  open,
  onOpenChange,
}: {
  task: Task | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [items, setItems] = React.useState<ReturnType<typeof buildTimeline>>([])

  // A recorded inline-todo snapshot renders its checklist directly (no transcript
  // to load); everything else loads the task's conversation messages.
  const inlineTodos = task ? asInlineTodos(task.input) : null

  React.useEffect(() => {
    let cancelled = false
    if (!open || !task || inlineTodos) {
      setItems([])
      return
    }
    window.cowork.db.messages.list(task.conversationId).then((rows) => {
      if (!cancelled) setItems(buildTimeline(rows))
    })
    return () => {
      cancelled = true
    }
  }, [open, task, inlineTodos])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-[min(90vw,40rem)] flex-col gap-0 p-0 sm:max-w-none"
      >
        <SheetHeader className="border-b">
          <SheetTitle className="truncate">
            {task?.title ?? "Task transcript"}
          </SheetTitle>
          <SheetDescription>
            {inlineTodos
              ? "Completed task list from this conversation."
              : `Read-only transcript of this background task${
                  task ? ` — ${task.status}` : ""
                }.`}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-4">
          {inlineTodos ? (
            <ul className="flex flex-col gap-1.5">
              {inlineTodos.todos.map((todo) => {
                const meta = TODO_ICON[todo.status] ?? TODO_ICON.pending
                const Icon = meta.Icon
                return (
                  <li key={todo.itemId} className="flex items-start gap-2">
                    <Icon
                      className={cn("mt-0.5 size-4 shrink-0", meta.className)}
                    />
                    <span
                      className={cn(
                        "text-sm text-foreground",
                        todo.status === "cancelled" &&
                          "text-muted-foreground line-through"
                      )}
                    >
                      {todo.content}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages yet.</p>
          ) : (
            items.map((item) => {
              if (item.kind === "tools") {
                return (
                  <Message key={item.key} align="start">
                    <MessageContent>
                      <ToolGroup calls={item.calls} />
                    </MessageContent>
                  </Message>
                )
              }
              const align = item.role === "user" ? "end" : "start"
              return (
                <Message key={item.key} align={align}>
                  <MessageContent>
                    <Bubble
                      align={align}
                      variant={item.role === "user" ? "default" : "muted"}
                    >
                      <BubbleContent
                        className={cn(
                          item.role === "user" && "whitespace-pre-wrap"
                        )}
                      >
                        {item.role === "assistant" ? (
                          <Markdown content={item.content} />
                        ) : (
                          item.content
                        )}
                      </BubbleContent>
                    </Bubble>
                  </MessageContent>
                </Message>
              )
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
