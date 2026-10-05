import { ArrowLeft, XIcon } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"

// Top title row shared by the Agents / Skills / MCP takeover screens. On the
// list view the title is the screen name and back closes the screen; inside a
// detail view the title becomes the item's name and back returns to the list
// (mirrors Mission Control's feature drill-in). The X always closes the screen.
export function ScreenHeader({
  title,
  onBack,
  backLabel,
  onClose,
}: {
  title: ReactNode
  onBack: () => void
  backLabel: string
  onClose: () => void
}) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-4">
      <button
        type="button"
        onClick={onBack}
        aria-label={backLabel}
        className="group/back flex min-w-0 items-center gap-2 rounded-md text-left"
      >
        <ArrowLeft className="size-4 shrink-0 text-muted-foreground transition-colors group-hover/back:text-foreground" />
        <h1 className="flex min-w-0 items-center gap-2 truncate font-heading text-base font-medium">
          {title}
        </h1>
      </button>
      <Button variant="ghost" size="icon-sm" onClick={onClose}>
        <XIcon />
        <span className="sr-only">Close</span>
      </Button>
    </div>
  )
}
