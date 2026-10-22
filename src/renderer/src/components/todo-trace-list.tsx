import { Ban, CheckCircle2, Circle, CircleDot } from "lucide-react"
import {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
} from "@/components/ui/trace"
import { cn } from "@/lib/utils"
import type { TodoStatus } from "@/types"

const PRESENTATION = {
  pending: { Icon: Circle, label: "Pending", status: "pending" },
  in_progress: { Icon: CircleDot, label: "In progress", status: "running" },
  completed: { Icon: CheckCircle2, label: "Completed", status: undefined },
  cancelled: { Icon: Ban, label: "Cancelled", status: undefined },
} as const

export function TodoTraceList({
  todos,
  strikeCompleted = true,
  className,
}: {
  todos: Array<{ itemId: string; content: string; status: TodoStatus }>
  strikeCompleted?: boolean
  className?: string
}) {
  return (
    <ul className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      {todos.map((todo) => {
        const { Icon, label, status } = PRESENTATION[todo.status]
        return (
          <li key={todo.itemId}>
            <Trace>
              <TraceLine status={status} className="items-start text-inherit">
                <TraceIcon className="mt-0.5">
                  <Icon />
                </TraceIcon>
                <TraceTitle
                  className={cn(
                    "overflow-visible break-words text-clip whitespace-pre-wrap",
                    todo.status === "in_progress" &&
                      "trace-shimmer text-muted-foreground motion-reduce:trace-shimmer-none",
                    (todo.status === "cancelled" ||
                      (strikeCompleted && todo.status === "completed")) &&
                      "line-through",
                    todo.status === "cancelled" && "opacity-60"
                  )}
                >
                  {todo.content}
                </TraceTitle>
                <TraceDescription className="sr-only">{label}</TraceDescription>
              </TraceLine>
            </Trace>
          </li>
        )
      })}
    </ul>
  )
}
