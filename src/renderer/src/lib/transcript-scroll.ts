export const TRANSCRIPT_END_THRESHOLD = 8
const TRANSCRIPT_SCROLL_DIRECTION_TOLERANCE = 0.5

export interface TranscriptScrollPolicy {
  awayFromEnd: Set<string>
  suppressSettledAnchor: Set<string>
}

export const INITIAL_TRANSCRIPT_SCROLL_POLICY: TranscriptScrollPolicy = {
  awayFromEnd: new Set(),
  suppressSettledAnchor: new Set(),
}

type TranscriptScrollMetrics = Pick<
  HTMLElement,
  "scrollHeight" | "scrollTop" | "clientHeight"
>

export function isTranscriptAtEnd(
  metrics: TranscriptScrollMetrics,
  threshold = TRANSCRIPT_END_THRESHOLD
): boolean {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
  )
}

export function transcriptRestorePosition(
  metrics: TranscriptScrollMetrics
): number | null {
  return isTranscriptAtEnd(metrics) ? null : metrics.scrollTop
}

export function recordTranscriptScroll(
  policy: TranscriptScrollPolicy,
  conversationId: string,
  atEnd: boolean
): TranscriptScrollPolicy {
  const wasAway = policy.awayFromEnd.has(conversationId)
  if (wasAway === !atEnd) return policy

  const awayFromEnd = new Set(policy.awayFromEnd)
  if (atEnd) awayFromEnd.delete(conversationId)
  else awayFromEnd.add(conversationId)
  return { ...policy, awayFromEnd }
}

export function transcriptShouldFollow(
  following: boolean,
  previousScrollTop: number,
  metrics: TranscriptScrollMetrics,
  userInitiated = true
): boolean {
  if (isTranscriptAtEnd(metrics)) return true
  if (
    userInitiated &&
    metrics.scrollTop <
      previousScrollTop - TRANSCRIPT_SCROLL_DIRECTION_TOLERANCE
  ) {
    return false
  }
  return following
}

export function recordTranscriptScrollIntent(
  policy: TranscriptScrollPolicy,
  conversationId: string,
  previousScrollTop: number,
  metrics: TranscriptScrollMetrics,
  userInitiated = true
): TranscriptScrollPolicy {
  const following = transcriptShouldFollow(
    !policy.awayFromEnd.has(conversationId),
    previousScrollTop,
    metrics,
    userInitiated
  )
  return recordTranscriptScroll(policy, conversationId, following)
}

export function resetTranscriptScroll(
  policy: TranscriptScrollPolicy,
  conversationId: string
): TranscriptScrollPolicy {
  if (
    !policy.awayFromEnd.has(conversationId) &&
    !policy.suppressSettledAnchor.has(conversationId)
  ) {
    return policy
  }

  const awayFromEnd = new Set(policy.awayFromEnd)
  const suppressSettledAnchor = new Set(policy.suppressSettledAnchor)
  awayFromEnd.delete(conversationId)
  suppressSettledAnchor.delete(conversationId)
  return { awayFromEnd, suppressSettledAnchor }
}

export function settleTranscriptTurn(
  policy: TranscriptScrollPolicy,
  conversationId: string,
  visible: boolean
): TranscriptScrollPolicy {
  const suppress = visible && policy.awayFromEnd.has(conversationId)
  const alreadySuppressed = policy.suppressSettledAnchor.has(conversationId)
  if (
    !policy.awayFromEnd.has(conversationId) &&
    suppress === alreadySuppressed
  ) {
    return policy
  }

  const awayFromEnd = new Set(policy.awayFromEnd)
  const suppressSettledAnchor = new Set(policy.suppressSettledAnchor)
  awayFromEnd.delete(conversationId)
  if (suppress) suppressSettledAnchor.add(conversationId)
  else suppressSettledAnchor.delete(conversationId)
  return { awayFromEnd, suppressSettledAnchor }
}
