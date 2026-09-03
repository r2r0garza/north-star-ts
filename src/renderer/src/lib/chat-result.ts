export const EMPTY_CHAT_SUCCESS_ERROR =
  "The model returned no usable answer. The turn ended before it could finish."

export interface ChatResultLike {
  content?: string
  error?: string
  stopped?: boolean
}

export type ChatResultNotification =
  | { kind: "turnError"; body: string }
  | { kind: "turnComplete"; body: string }
  | null

export function isUnexpectedEmptyChatSuccess(data: ChatResultLike): boolean {
  return (
    !data.error &&
    !data.stopped &&
    (typeof data.content !== "string" || data.content.trim().length === 0)
  )
}

export function chatResultNotification(
  data: ChatResultLike,
  snippet: (text: string) => string
): ChatResultNotification {
  if (data.error) return { kind: "turnError", body: snippet(data.error) }
  if (isUnexpectedEmptyChatSuccess(data)) {
    return { kind: "turnError", body: "The model returned no usable answer." }
  }
  if (data.stopped) return null
  return { kind: "turnComplete", body: "The agent finished its turn." }
}
