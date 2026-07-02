import * as React from "react"
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
import type { Task } from "@/types"

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

  React.useEffect(() => {
    let cancelled = false
    if (!open || !task) {
      setItems([])
      return
    }
    window.cowork.db.messages.list(task.conversationId).then((rows) => {
      if (!cancelled) setItems(buildTimeline(rows))
    })
    return () => {
      cancelled = true
    }
  }, [open, task])

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
            Read-only transcript of this background task
            {task ? ` — ${task.status}` : ""}.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-4">
          {items.length === 0 ? (
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
