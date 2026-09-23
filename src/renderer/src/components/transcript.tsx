import { memo } from "react"
import { Markdown } from "@/components/markdown"
import { MessageScrollerItem } from "@/components/ui/message-scroller"
import { Message, MessageContent } from "@/components/ui/message"
import { ConversationMessageMeta } from "@/components/conversation-message-meta"
import { ConversationFindText } from "@/components/conversation-find-text"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Marker, MarkerIcon, MarkerContent } from "@/components/ui/marker"
import { Spinner } from "@/components/ui/spinner"
import { ToolGroup } from "@/components/tool-group"
import { ChangedFilesBar } from "@/components/changed-files-bar"
import type { TimelineItem, ToolUse } from "@/lib/timeline"
import { cn } from "@/lib/utils"

// Transcript render boundaries (plan 097). The settled timeline and the live,
// in-flight turn are separate memoized subtrees so a streamed token only
// reconciles the live turn: settled rows skip rendering unless their own item,
// anchor, find query, or copy-visibility status changes. Every prop that crosses
// these boundaries must therefore be referentially stable across token updates
// (items come from `timeline` state; callbacks are stable wrappers in App).

// One ordered piece of an in-flight turn: a run of streamed assistant text, or a
// group of tool calls. Segments are appended in the order events arrive, so the
// live turn interleaves text and tools exactly as it happened (a preamble, its
// tools, the next preamble, its tools, …) — matching how buildTimeline lays out
// the settled transcript.
export type LiveSegment =
  | { kind: "text"; text: string }
  | { kind: "tools"; calls: ToolUse[] }

interface ChangedFilesCallbacks {
  workspace: string
  onOpenHtml: (relPath: string) => void
  onReviewFiles: () => void
}

interface SettledTranscriptProps extends ChangedFilesCallbacks {
  items: TimelineItem[]
  // Whether the final settled row is the scroll anchor (false while a live turn
  // owns the anchor or a reader's off-bottom position is being preserved).
  anchorLast: boolean
  findQuery: string
  latestAssistantKey: string | null
}

export const SettledTranscript = memo(function SettledTranscript({
  items,
  anchorLast,
  findQuery,
  latestAssistantKey,
  workspace,
  onOpenHtml,
  onReviewFiles,
}: SettledTranscriptProps) {
  return items.map((item, i) => (
    <SettledTranscriptRow
      key={item.key}
      item={item}
      scrollAnchor={anchorLast && i === items.length - 1}
      findQuery={findQuery}
      copyAlwaysVisible={
        item.kind === "text" &&
        item.role === "assistant" &&
        item.key === latestAssistantKey
      }
      workspace={workspace}
      onOpenHtml={onOpenHtml}
      onReviewFiles={onReviewFiles}
    />
  ))
})

interface SettledTranscriptRowProps extends ChangedFilesCallbacks {
  item: TimelineItem
  scrollAnchor: boolean
  findQuery: string
  copyAlwaysVisible: boolean
}

// One persisted row. Memoized separately from the list so a list-level change
// (the anchor moving to a new last row, the latest-assistant key changing)
// rerenders only the rows whose own props changed.
const SettledTranscriptRow = memo(function SettledTranscriptRow({
  item,
  scrollAnchor,
  findQuery,
  copyAlwaysVisible,
  workspace,
  onOpenHtml,
  onReviewFiles,
}: SettledTranscriptRowProps) {
  if (item.kind === "tools") {
    return (
      <MessageScrollerItem scrollAnchor={scrollAnchor}>
        <Message align="start">
          <MessageContent>
            <ToolGroup calls={item.calls} />
            <ChangedFilesBar
              calls={item.calls}
              workspace={workspace}
              onOpenHtml={onOpenHtml}
              onReviewAll={onReviewFiles}
            />
          </MessageContent>
        </Message>
      </MessageScrollerItem>
    )
  }
  const align = item.role === "user" ? "end" : "start"
  return (
    <MessageScrollerItem scrollAnchor={scrollAnchor}>
      <Message align={align} tabIndex={0}>
        <MessageContent>
          <Bubble
            align={align}
            variant={item.role === "user" ? "default" : "muted"}
          >
            <BubbleContent
              className={cn(
                item.role === "user"
                  ? "whitespace-pre-wrap"
                  : "overflow-visible"
              )}
            >
              {item.role === "assistant" ? (
                <Markdown content={item.content} findQuery={findQuery} />
              ) : (
                <ConversationFindText text={item.content} query={findQuery} />
              )}
            </BubbleContent>
          </Bubble>
          <ConversationMessageMeta
            content={item.content}
            createdAt={item.createdAt}
            align={align}
            copyAlwaysVisible={copyAlwaysVisible}
          />
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  )
})

interface LiveTranscriptTurnProps extends ChangedFilesCallbacks {
  segments: LiveSegment[]
  // The aggregated visible text across all live text segments (copy source).
  content: string
  firstTextAt: number | null
  commandWait: boolean
  streamRetrying: boolean
  findQuery: string
}

// The in-flight assistant turn: text and tool activity rendered in the order
// they streamed (interleaved via segments), so it reads the same live as it does
// once settled. "Thinking…" fills the gap before the first event. This subtree
// rerenders on every delta by design; its segments are memoized so only the
// segment that actually changed (normally the trailing text) reconciles.
export function LiveTranscriptTurn({
  segments,
  content,
  firstTextAt,
  commandWait,
  streamRetrying,
  findQuery,
  workspace,
  onOpenHtml,
  onReviewFiles,
}: LiveTranscriptTurnProps) {
  const hasText = content.trim().length > 0
  return (
    <MessageScrollerItem scrollAnchor>
      <Message align="start" tabIndex={hasText ? 0 : undefined}>
        <MessageContent>
          {segments.map((segment, index) => (
            <LiveTranscriptSegment
              // Segments only append or update in place, so position is a
              // stable identity for the turn's lifetime.
              key={`s${index}`}
              segment={segment}
              findQuery={findQuery}
              workspace={workspace}
              onOpenHtml={onOpenHtml}
              onReviewFiles={onReviewFiles}
            />
          ))}
          {segments.length === 0 && (
            <Marker>
              <MarkerIcon>
                <Spinner />
              </MarkerIcon>
              <MarkerContent>
                {commandWait
                  ? "Waiting for background command…"
                  : streamRetrying
                    ? "Connection interrupted — retrying…"
                    : "Thinking…"}
              </MarkerContent>
            </Marker>
          )}
          {hasText && firstTextAt !== null && (
            <ConversationMessageMeta
              content={content}
              createdAt={firstTextAt}
              align="start"
              copyAlwaysVisible
            />
          )}
          {segments.length > 0 && commandWait && (
            <Marker>
              <MarkerIcon>
                <Spinner />
              </MarkerIcon>
              <MarkerContent>Waiting for background command…</MarkerContent>
            </Marker>
          )}
        </MessageContent>
      </Message>
    </MessageScrollerItem>
  )
}

interface LiveTranscriptSegmentProps extends ChangedFilesCallbacks {
  segment: LiveSegment
  findQuery: string
}

const LiveTranscriptSegment = memo(function LiveTranscriptSegment({
  segment,
  findQuery,
  workspace,
  onOpenHtml,
  onReviewFiles,
}: LiveTranscriptSegmentProps) {
  if (segment.kind === "tools") {
    return (
      <div>
        <ToolGroup calls={segment.calls} />
        <ChangedFilesBar
          calls={segment.calls}
          workspace={workspace}
          onOpenHtml={onOpenHtml}
          onReviewAll={onReviewFiles}
        />
      </div>
    )
  }
  if (!segment.text) return null
  return (
    <Bubble align="start" variant="muted">
      <BubbleContent className="overflow-visible">
        <Markdown
          content={segment.text}
          mode="streaming"
          findQuery={findQuery}
        />
      </BubbleContent>
    </Bubble>
  )
})
