import { useConversationTodos } from "@/hooks/use-conversation-todos"

// The in-progress todo, shown beside the live response timer. todo_write only
// asks for one in_progress item, so if several exist the first (highest
// priority) wins. The Todos panel still holds the full list.
export function ActiveTodoIndicator({
  conversationId,
}: {
  conversationId: string
}) {
  const { todos } = useConversationTodos(conversationId)
  const active = todos.find((todo) => todo.status === "in_progress")
  if (!active) return null
  return (
    <span
      title={active.content}
      className="trace-shimmer min-w-0 truncate motion-reduce:trace-shimmer-none"
    >
      {active.content}
    </span>
  )
}
