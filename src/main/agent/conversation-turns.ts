const tails = new Map<string, Promise<unknown>>()

export function serializeConversationTurn<T>(
  conversationId: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = tails.get(conversationId) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(run)
  tails.set(conversationId, next)
  void next
    .finally(() => {
      if (tails.get(conversationId) === next) tails.delete(conversationId)
    })
    .catch(() => {})
  return next
}
