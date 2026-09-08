import { describe, expect, it, vi } from "vitest"
import { SHUTDOWN_ABORT_REASON } from "../abort"
import {
  askUser,
  cancelAllQuestions,
  cancelConversationQuestions,
  pendingQuestionCount,
  resolveQuestion,
  type QuestionEvent,
} from "./broker"

const QUESTIONS = [
  { question: "Which database?", header: "DB", options: [{ label: "SQLite" }] },
]

function capture() {
  const events: QuestionEvent[] = []
  return { events, emit: (event: QuestionEvent) => events.push(event) }
}

describe("question broker", () => {
  it("emits a question and resolves it with the renderer's answers", async () => {
    const { events, emit } = capture()
    const pending = askUser({
      conversationId: "c1",
      toolCallId: "call-1",
      questions: QUESTIONS,
      emit,
      signal: new AbortController().signal,
    })
    expect(events).toHaveLength(1)
    expect(events[0].id).toBe("call-1")

    resolveQuestion(events[0].requestId, [{ selected: ["SQLite"] }])
    await expect(pending).resolves.toEqual({
      status: "answered",
      answers: [{ selected: ["SQLite"] }],
    })
    expect(pendingQuestionCount()).toBe(0)
  })

  it("ignores an answer for an unknown or already-settled request", async () => {
    const { events, emit } = capture()
    const pending = askUser({
      conversationId: "c1",
      toolCallId: "call-1",
      questions: QUESTIONS,
      emit,
      signal: new AbortController().signal,
    })
    resolveQuestion(events[0].requestId, [{ selected: ["a"] }])
    await pending
    // Second delivery is a no-op rather than resolving something else.
    expect(() =>
      resolveQuestion(events[0].requestId, [{ selected: ["b"] }])
    ).not.toThrow()
    resolveQuestion("never-issued", [{ selected: ["b"] }])
    expect(pendingQuestionCount()).toBe(0)
  })

  it("cancels on abort, but stays pending on app shutdown", async () => {
    const stopped = new AbortController()
    const { emit } = capture()
    const cancelled = askUser({
      conversationId: "c1",
      toolCallId: "call-1",
      questions: QUESTIONS,
      emit,
      signal: stopped.signal,
    })
    stopped.abort()
    await expect(cancelled).resolves.toEqual({ status: "cancelled" })

    const shutdown = new AbortController()
    let settled = false
    void askUser({
      conversationId: "c2",
      toolCallId: "call-2",
      questions: QUESTIONS,
      emit,
      signal: shutdown.signal,
    }).then(() => {
      settled = true
    })
    shutdown.abort(SHUTDOWN_ABORT_REASON)
    await Promise.resolve()
    expect(settled).toBe(false)
    cancelAllQuestions()
  })

  it("returns cancelled immediately for an already-aborted turn", async () => {
    const controller = new AbortController()
    controller.abort()
    const { events, emit } = capture()
    await expect(
      askUser({
        conversationId: "c1",
        toolCallId: "call-1",
        questions: QUESTIONS,
        emit,
        signal: controller.signal,
      })
    ).resolves.toEqual({ status: "cancelled" })
    expect(events).toHaveLength(0)
  })

  it("cancels only the named conversation's questions", async () => {
    const { emit } = capture()
    const mine = askUser({
      conversationId: "c1",
      toolCallId: "a",
      questions: QUESTIONS,
      emit,
      signal: new AbortController().signal,
    })
    const theirs = askUser({
      conversationId: "c2",
      toolCallId: "b",
      questions: QUESTIONS,
      emit,
      signal: new AbortController().signal,
    })
    expect(cancelConversationQuestions("c1")).toBe(1)
    await expect(mine).resolves.toEqual({ status: "cancelled" })
    expect(pendingQuestionCount()).toBe(1)
    cancelAllQuestions()
    await expect(theirs).resolves.toEqual({ status: "cancelled" })
  })

  it("cancels a question that outlives its bounded expiry", async () => {
    vi.useFakeTimers()
    try {
      const { emit } = capture()
      const pending = askUser({
        conversationId: "c1",
        toolCallId: "a",
        questions: QUESTIONS,
        emit,
        signal: new AbortController().signal,
        timeoutMs: 1000,
      })
      vi.advanceTimersByTime(1001)
      await expect(pending).resolves.toEqual({ status: "cancelled" })
      expect(pendingQuestionCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
