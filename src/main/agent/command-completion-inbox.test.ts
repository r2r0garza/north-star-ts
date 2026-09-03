import { describe, expect, it, vi } from "vitest"
import {
  CommandCompletionInbox,
  type CommandCompletionOwner,
} from "./command-completion-inbox"

const owner: CommandCompletionOwner = {
  conversationId: "c1",
  workspace: "/workspace",
  runId: "run-1",
}

function completion(sessionId = "s1") {
  return {
    sessionId,
    command: "pnpm test",
    cwd: "/workspace",
    status: "completed",
    exitCode: 0,
    signal: null,
    durationMs: 123,
    cursor: 4,
    nextCursor: 4,
    totalBytes: 4,
    droppedBytes: 0,
    omittedBytes: 0,
    modelTruncated: false,
    truncated: false,
    cleanupError: null,
    output: "ok\n",
  }
}

describe("CommandCompletionInbox", () => {
  it("does not drain a completed event until the initial exec result is persisted", () => {
    const inbox = new CommandCompletionInbox()
    inbox.register("s1", owner)
    inbox.enqueue({ sessionId: "s1", owner, event: completion() })

    expect(inbox.drain(owner)).toEqual([])
    expect(inbox.hasPending(owner)).toBe(true)

    inbox.markInitialResultPersisted(owner, "s1")
    const drained = inbox.drain(owner)

    expect(drained).toHaveLength(1)
    expect(drained[0]).toMatchObject({
      sessionId: "s1",
      command: "pnpm test",
      status: "completed",
      output: "ok\n",
    })
  })

  it("moves drained events out of the queue so retries reuse the persisted message", () => {
    const inbox = new CommandCompletionInbox()
    inbox.register("s1", owner)
    inbox.markInitialResultPersisted(owner, "s1")
    inbox.enqueue({ sessionId: "s1", owner, event: completion() })

    const first = inbox.drain(owner)
    const second = inbox.drain(owner)

    expect(first).toHaveLength(1)
    expect(second).toEqual([])
  })

  it("releases retained output only after consumed delivery or owner cancellation", () => {
    const inbox = new CommandCompletionInbox()
    const release = vi.fn()
    inbox.register("s1", owner, { releaseRetainedOutput: release })
    inbox.markInitialResultPersisted(owner, "s1")
    inbox.enqueue({ sessionId: "s1", owner, event: completion() })

    const [event] = inbox.drain(owner)
    expect(release).not.toHaveBeenCalled()

    inbox.markConsumed([event.id])
    expect(release).toHaveBeenCalledTimes(1)

    const cancelRelease = vi.fn()
    inbox.register("s2", owner, { releaseRetainedOutput: cancelRelease })
    inbox.cancelRun(owner)
    expect(cancelRelease).toHaveBeenCalledTimes(1)
  })
})
