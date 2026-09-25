import { useState } from "react"
import { CircleHelp } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { PhaseContextScope } from "@/types"

// A playbook step's context scope: how long a seat's conversation for that
// step lives. The labels and one-line help are shared by the builder's
// dropdown, its tooltips, and the guidance dialog below.
export const CONTEXT_SCOPES: Record<
  PhaseContextScope,
  { label: string; badge: string; help: string }
> = {
  step: {
    label: "Fresh each step",
    badge: "fresh",
    help: "A new worker; nothing carries over.",
  },
  slice: {
    label: "One per slice",
    badge: "per slice",
    help: "The seat's steps in one slice share a conversation; it closes when the slice ends.",
  },
  initiative: {
    label: "Long-lived",
    badge: "long-lived",
    help: "One conversation across the initiative. Keeps context, and grows.",
  },
}

const RECOMMENDED: Array<{
  seat: string
  scope: PhaseContextScope
  why: string
}> = [
  {
    seat: "Builder",
    scope: "slice",
    why: "Spec and build share one mind, and replies to its questions land in the same conversation. Each new slice starts clean from its spec. A mistake stays in its slice, a retry doesn't repeat the failed approach, and slices can safely run side by side.",
  },
  {
    seat: "QA",
    scope: "slice",
    why: "Each verification is independent: QA judges this slice against its spec, not against what it remembers the builder saying last time. It still sees the whole slice, including the builder's questions. Context stays small no matter how many slices there are.",
  },
  {
    seat: "Lead",
    scope: "initiative",
    why: "The lead's job is continuity: the plan, what it told whom, and earlier escalations. It also runs rarely (planning and review steps, escalations, your Steers), so its context grows slowly.",
  },
]

export function ContextScopeHelpButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground"
        aria-label="Which context should this step use?"
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
      >
        <CircleHelp className="size-3.5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Choosing a context</DialogTitle>
            <DialogDescription>
              How long the seat&apos;s conversation for this step lasts, and so
              what it remembers.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 text-sm">
            <dl className="space-y-1.5">
              {(Object.keys(CONTEXT_SCOPES) as PhaseContextScope[]).map(
                (scope) => (
                  <div key={scope} className="flex gap-2">
                    <dt className="w-32 shrink-0 font-medium">
                      {CONTEXT_SCOPES[scope].label}
                    </dt>
                    <dd className="text-muted-foreground">
                      {CONTEXT_SCOPES[scope].help}
                    </dd>
                  </div>
                )
              )}
            </dl>

            <div>
              <h3 className="mb-2 font-medium">Recommended</h3>
              <table className="w-full border-collapse text-left">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="py-1.5 pr-3 font-medium">Seat</th>
                    <th className="py-1.5 pr-3 font-medium">Context</th>
                    <th className="py-1.5 font-medium">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {RECOMMENDED.map((row) => (
                    <tr key={row.seat} className="border-b align-top last:border-0">
                      <td className="py-2 pr-3 font-medium">{row.seat}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {CONTEXT_SCOPES[row.scope].label}
                      </td>
                      <td className="py-2 text-muted-foreground">{row.why}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div>
              <h3 className="mb-1 font-medium">When to choose something else</h3>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  <span className="text-foreground">Fresh each step</span> for a
                  step whose value comes from knowing nothing, such as a second
                  opinion or an adversarial review, or a step you want cheap and
                  repeatable.
                </li>
                <li>
                  <span className="text-foreground">Long-lived QA</span> only
                  when QA keeps rediscovering the same project conventions.
                  Expect its context to grow with every slice.
                </li>
              </ul>
            </div>

            <p className="rounded-md bg-muted/60 p-3 text-muted-foreground">
              <span className="font-medium text-foreground">
                Long-lived conversations keep growing.
              </span>{" "}
              On a long initiative, use <em>Rotate</em> in the Comms tab&apos;s
              Seats panel now and then (for example, between missions). The new
              conversation starts with a short handoff instead of the full
              history.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
