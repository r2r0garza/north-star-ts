export type ConversationFindSegment = {
  text: string
  match: boolean
}

export function splitConversationFindText(
  text: string,
  query: string
): ConversationFindSegment[] {
  if (!query) return [{ text, match: false }]

  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const matches = text.matchAll(new RegExp(escapedQuery, "giu"))
  const segments: ConversationFindSegment[] = []
  let offset = 0

  for (const match of matches) {
    const matchAt = match.index
    if (matchAt > offset) {
      segments.push({ text: text.slice(offset, matchAt), match: false })
    }
    const end = matchAt + match[0].length
    segments.push({ text: text.slice(matchAt, end), match: true })
    offset = end
  }

  if (offset < text.length) {
    segments.push({ text: text.slice(offset), match: false })
  }

  return segments.length ? segments : [{ text, match: false }]
}
