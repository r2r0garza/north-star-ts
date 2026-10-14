import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

// The spin runs on a wrapping <span>, not the <svg>: Chromium can hand an HTML
// element's transform animation to the compositor, but an animated <svg> needs
// a main-thread style + paint pass every frame (120/s on ProMotion displays)
// for as long as it's on screen — e.g. for the whole length of an agent turn.
function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="spinner"
      role="status"
      aria-label="Loading"
      className={cn("inline-flex size-4 shrink-0 animate-spin", className)}
      {...props}
    >
      <Loader2Icon aria-hidden="true" className="size-full" />
    </span>
  )
}

export { Spinner }
