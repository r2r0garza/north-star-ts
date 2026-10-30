import { useEffect, useRef, useState } from "react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { MessageFooter } from "@/components/ui/message"
import { cn } from "@/lib/utils"

export function formatConversationTimestamp(
  createdAt: number,
  locales?: Intl.LocalesArgument
): string {
  return new Intl.DateTimeFormat(locales, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(createdAt)
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(seconds / 60)
  return m > 0
    ? `${m}m ${String(seconds % 60).padStart(2, "0")}s`
    : `${seconds}s`
}

// Ticking elapsed time for the in-flight turn. It sits where the settled row's
// timestamp and copy button appear, so settling swaps one for the other in place.
export function ElapsedTimer({ startedAt }: { startedAt: number | null }) {
  // Mount time stands in when this renderer didn't see the turn start.
  const [mountedAt] = useState(() => Date.now())
  const start = startedAt ?? mountedAt
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return (
    <MessageFooter className="h-6 justify-start px-0 font-normal tabular-nums">
      <span role="timer" aria-label="Elapsed time">
        {formatElapsed(now - start)}
      </span>
    </MessageFooter>
  )
}

type ConversationMessageMetaProps = {
  content: string
  createdAt: number
  align: "start" | "end"
  copyAlwaysVisible: boolean
}

export function ConversationMessageMeta({
  content,
  createdAt,
  align,
  copyAlwaysVisible,
}: ConversationMessageMetaProps) {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const instant = new Date(createdAt)

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    },
    []
  )

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      setCopied(false)
      toast.error("Could not copy message", {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  return (
    <MessageFooter
      className={cn(
        "h-6 gap-1 px-0 font-normal",
        align === "end" ? "justify-end" : "justify-start"
      )}
    >
      <time className="whitespace-nowrap" dateTime={instant.toISOString()}>
        {formatConversationTimestamp(createdAt)}
      </time>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={cn(
          "text-muted-foreground hover:text-foreground",
          copyAlwaysVisible
            ? "conversation-message-meta__always"
            : "conversation-message-meta__reveal"
        )}
        aria-label={copied ? "Message copied" : "Copy message"}
        onClick={() => void copyMessage()}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </MessageFooter>
  )
}
