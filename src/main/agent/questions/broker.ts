import { randomUUID } from "crypto"
import { SHUTDOWN_ABORT_REASON } from "../abort"
import type { AskResult, Question, QuestionAnswer } from "../tools/types"

// The `question` ChatEvent, structurally. Declared here rather than imported
// from `../index` so the broker stays free of the agent module (which imports
// it) — the shapes are checked structurally at every call site.
export interface QuestionEvent {
  type: "question"
  id: string
  requestId: string
  questions: Question[]
}

interface PendingQuestion {
  conversationId: string
  resolve: (result: AskResult) => void
  // Cleared when the request settles, so an abort listener or expiry timer that
  // fires afterwards can't resolve a second time.
  dispose: () => void
}

// Every in-flight ask_user_question round trip in this process, keyed by a
// process-unique requestId so an answer can't resolve another turn's question.
// The internal agent loop and the CLI MCP bridge share this one registry: the
// renderer answers both through the same `chat:answer` IPC.
const pending = new Map<string, PendingQuestion>()

// Called from the renderer over IPC ("chat:answer") to deliver the user's
// answers. No-op if the request is gone (already answered, cancelled, or the
// turn was stopped).
export function resolveQuestion(
  requestId: string,
  answers: QuestionAnswer[]
): void {
  const entry = pending.get(requestId)
  if (!entry) return
  pending.delete(requestId)
  entry.dispose()
  entry.resolve({ status: "answered", answers })
}

// Cancel every question still waiting for `conversationId`. Used when a CLI
// turn settles (or its MCP grant is revoked) so a bridge call can never outlive
// the turn that authorized it. Returns how many were released.
export function cancelConversationQuestions(conversationId: string): number {
  let cancelled = 0
  for (const [requestId, entry] of [...pending]) {
    if (entry.conversationId !== conversationId) continue
    pending.delete(requestId)
    entry.dispose()
    entry.resolve({ status: "cancelled" })
    cancelled += 1
  }
  return cancelled
}

// Release everything on app teardown so no promise is left dangling.
export function cancelAllQuestions(): void {
  for (const [requestId, entry] of [...pending]) {
    pending.delete(requestId)
    entry.dispose()
    entry.resolve({ status: "cancelled" })
  }
}

// Test seam: pending questions are process-global runtime state.
export function pendingQuestionCount(): number {
  return pending.size
}

export interface AskUserInput {
  // The conversation this question belongs to. Scopes bulk cancellation.
  conversationId: string
  // The tool-call id the renderer pairs the panel with. For the internal loop
  // this is the model's tool_use id; for an MCP call it's the bridge's own id.
  toolCallId: string
  questions: Question[]
  // Surfaces the question to whoever is watching this turn (renderer panel or
  // activity feed). A swallowed onEvent means nobody can answer — callers that
  // run headless must not offer the tool at all.
  emit: (event: QuestionEvent) => void
  // Aborting this releases the question as cancelled, except on app shutdown,
  // where it is left unresolved so no synthetic answer is persisted and a
  // durable task reconciles to interrupted.
  signal: AbortSignal
  // Final bounded expiry, in ms. Absent means "wait as long as the turn does" —
  // the internal loop's own turn bound applies. The MCP bridge sets one so a
  // CLI can never hang on a question the user has walked away from.
  timeoutMs?: number
}

// Pause the caller until the user answers in the UI (chat:answer →
// resolveQuestion), the turn is stopped, the conversation's questions are
// cancelled, or the optional expiry elapses.
export function askUser(input: AskUserInput): Promise<AskResult> {
  const { signal } = input
  if (signal.aborted) return Promise.resolve({ status: "cancelled" })

  const requestId = randomUUID()
  return new Promise<AskResult>((resolve) => {
    let timer: NodeJS.Timeout | undefined
    const onAbort = () => {
      // Shutdown: leave unresolved so no synthetic answer is persisted and the
      // task reconciles to interrupted (mirrors the approval gate).
      if (signal.reason === SHUTDOWN_ABORT_REASON) return
      const entry = pending.get(requestId)
      if (!entry) return
      pending.delete(requestId)
      entry.dispose()
      resolve({ status: "cancelled" })
    }
    const dispose = () => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }

    pending.set(requestId, {
      conversationId: input.conversationId,
      resolve,
      dispose,
    })
    signal.addEventListener("abort", onAbort, { once: true })
    if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
      timer = setTimeout(() => {
        const entry = pending.get(requestId)
        if (!entry) return
        pending.delete(requestId)
        entry.dispose()
        resolve({ status: "cancelled" })
      }, input.timeoutMs)
      timer.unref?.()
    }

    // Emitted only after the request is registered, so an answer that races
    // back in the same tick still finds it.
    input.emit({
      type: "question",
      id: input.toolCallId,
      requestId,
      questions: input.questions,
    })
  })
}
