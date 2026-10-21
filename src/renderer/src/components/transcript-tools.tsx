import { Fragment, memo } from "react"
import { ToolGroup } from "@/components/tool-group"
import { ConversationArtifact } from "@/components/conversation-artifact"
import type { ToolUse } from "@/lib/timeline"

export function artifactToolSegments(calls: ToolUse[]) {
  const segments: Array<{
    key: string
    calls: ToolUse[]
    artifactCall?: ToolUse
  }> = []
  let pending: ToolUse[] = []
  const seen = new Set<string>()
  for (const call of calls) {
    if (seen.has(call.id)) continue
    seen.add(call.id)
    pending.push(call)
    if (["present_chart", "present_table"].includes(call.name)) {
      segments.push({ key: pending[0].id, calls: pending, artifactCall: call })
      pending = []
    }
  }
  if (pending.length) segments.push({ key: pending[0].id, calls: pending })
  return segments
}

// Both transcript paths use tool-call order, never completion order. The trace
// remains inspectable, but only this sibling surface renders saved artifacts.
export const TranscriptTools = memo(function TranscriptTools({
  calls,
  conversationId,
}: {
  calls: ToolUse[]
  conversationId?: string
}) {
  return artifactToolSegments(calls).map((segment) => {
    const call = segment.artifactCall
    return (
      <Fragment key={segment.key}>
        <ToolGroup calls={segment.calls} />
        {call?.status === "done" &&
          (call.artifact ? (
            <ConversationArtifact
              key={`${call.id}:${call.artifact.artifactId}:${call.artifact.revision}`}
              reference={call.artifact}
              conversationId={call.conversationId ?? conversationId}
            />
          ) : (
            <p role="status" className="my-2 text-sm text-muted-foreground">
              {call.name === "present_table" ? "Table" : "Chart"} unavailable:
              no supported saved reference.
            </p>
          ))}
      </Fragment>
    )
  })
})
