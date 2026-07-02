import * as React from "react"
import { toast } from "sonner"
import type { TaskStatus } from "@/types"

// Terminal statuses worth acknowledging. Cancellations are intentionally NOT
// toasted — the user cancelled them, so they don't need to be told.
const TERMINAL: TaskStatus[] = ["completed", "failed"]

// A single, fixed toast id. Every toast we raise reuses it, so Sonner updates
// the one toast in place instead of stacking — no matter how many tasks finish,
// there is never more than one completion toast on screen.
const TOAST_ID = "task-completion"
const DURATION = 5000

// Headless: replaces the per-task "Background task completed" cards with a single
// toast pointing the user to the History section of the activity panel. On
// opening a session with terminal history → one aggregate toast; when tasks
// finish live → one coalesced toast. `onReveal` opens the panel + expands History.
export function TaskCompletionToasts({
  conversationId,
  onReveal,
}: {
  conversationId: string | null
  onReveal: () => void
}) {
  // Task ids already surfaced this session — kept out of future toasts so
  // flipping between conversations doesn't re-toast the same tasks.
  const seen = React.useRef<Set<string>>(new Set())

  const onRevealRef = React.useRef(onReveal)
  onRevealRef.current = onReveal

  // Raise (or update) the single toast. message varies by how many are new.
  const fire = React.useCallback((message: string) => {
    toast(message, {
      id: TOAST_ID,
      duration: DURATION,
      action: { label: "View history", onClick: () => onRevealRef.current() },
    })
  }, [])

  // On opening a session: one aggregate toast if it has unseen terminal history.
  React.useEffect(() => {
    if (!conversationId) return
    let cancelled = false
    void window.cowork.db.tasks
      .list({ sourceConversationId: conversationId })
      .then((rows) => {
        if (cancelled) return
        const unseen = rows.filter(
          (t) => TERMINAL.includes(t.status) && !seen.current.has(t.id)
        )
        if (unseen.length === 0) return
        for (const t of unseen) seen.current.add(t.id)
        fire(
          "You have completed background tasks — open the panel (⌘J) to view history."
        )
      })
    return () => {
      cancelled = true
    }
  }, [conversationId, fire])

  // Live: when tasks finish, coalesce any newly-unseen ones into the single toast.
  React.useEffect(() => {
    if (!conversationId) return
    const unsubscribe = window.cowork.tasks.onEvent((payload) => {
      const t = payload.event.type
      if (t !== "task_completed" && t !== "task_failed") return
      void window.cowork.db.tasks
        .list({ sourceConversationId: conversationId })
        .then((rows) => {
          const fresh = rows.filter(
            (r) => TERMINAL.includes(r.status) && !seen.current.has(r.id)
          )
          if (fresh.length === 0) return
          for (const r of fresh) seen.current.add(r.id)
          fire(
            fresh.length === 1
              ? fresh[0].status === "failed"
                ? "Background task failed — view it in the activity panel."
                : "Background task completed — view it in the activity panel."
              : "Background tasks finished — view them in the activity panel."
          )
        })
    })
    return unsubscribe
  }, [conversationId, fire])

  return null
}
