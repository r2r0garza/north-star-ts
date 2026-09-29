import { Compass } from "lucide-react"
import { parseRefocusEvent } from "../../../../shared/runtime-messages"

const TRIGGER_LABELS: Record<string, string> = {
  compaction: "after compaction",
  interval: "periodic check",
  drift: "drift signal",
}

// A Refocus reminder (plan 106.7) in a seat's transcript: collapsed to a chip,
// like other injected context, so the user can see what the agent was
// reminded of and when without it reading as the user's own words.
export function RefocusChip({ content }: { content: string }) {
  const parsed = parseRefocusEvent(content)
  if (!parsed) return null
  return (
    <details className="group rounded-md border border-dashed bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none">
        <Compass className="size-3.5" />
        <span className="font-medium">Refocus</span>
        <span>· {TRIGGER_LABELS[parsed.trigger] ?? parsed.trigger}</span>
        <span className="ml-auto group-open:hidden">Show</span>
        <span className="ml-auto hidden group-open:inline">Hide</span>
      </summary>
      <pre className="mt-2 font-sans text-xs whitespace-pre-wrap">
        {parsed.body}
      </pre>
    </details>
  )
}
