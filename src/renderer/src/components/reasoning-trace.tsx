import { memo, useEffect, useState } from "react"
import { Brain } from "lucide-react"
import { Markdown } from "@/components/markdown"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"

// A model's reasoning for one round. `live` while it is still the streaming
// tail of the turn: it streams open, then collapses once the round moves on
// (settled rows start collapsed). The body mounts only when open, so a
// collapsed thought costs no Markdown parse.
export const ReasoningTrace = memo(function ReasoningTrace({
  text,
  live = false,
  conversationId,
}: {
  text: string
  live?: boolean
  conversationId?: string
}) {
  const [open, setOpen] = useState(live)
  useEffect(() => {
    if (!live) setOpen(false)
  }, [live])
  return (
    <Trace>
      <TraceCollapsible open={open} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={live ? "running" : undefined}>
            <TraceIcon>
              <Brain />
            </TraceIcon>
            <TraceTitle>{live ? "Thinking…" : "Thought"}</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {open && (
            <Markdown
              content={text}
              mode={live ? "streaming" : "settled"}
              conversationId={conversationId}
            />
          )}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
})
