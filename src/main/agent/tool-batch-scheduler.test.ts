import { afterEach, describe, expect, it, vi } from "vitest"
import {
  runToolCallBatches,
  ToolLifecycleError,
  testExports,
  type ScheduledToolCall,
} from "./tool-batch-scheduler"
import type { ToolEffects } from "./tools/types"

const readEffects: ToolEffects = {
  readOnly: true,
  parallelSafe: true,
  idempotent: true,
  destructive: false,
  openWorld: false,
}

const writeEffects: ToolEffects = {
  readOnly: false,
  parallelSafe: false,
  idempotent: false,
  destructive: false,
  openWorld: false,
}

function call(id: string, name: string): ScheduledToolCall {
  return { id, name, arguments: "{}" }
}

afterEach(() => vi.useRealTimers())

describe("tool batch scheduler", () => {
  it("partitions consecutive parallel reads around mutation barriers", () => {
    const batches = testExports.partitionToolCalls(
      [
        call("1", "read"),
        call("2", "read"),
        call("3", "write"),
        call("4", "read"),
      ],
      (name) => (name === "read" ? readEffects : writeEffects)
    )

    expect(batches.map((batch) => batch.map((c) => c.id))).toEqual([
      ["1", "2"],
      ["3"],
      ["4"],
    ])
  })

  it("overlaps delayed reads but returns results in call order", async () => {
    const starts: string[] = []
    const done: string[] = []
    const results = await runToolCallBatches(
      [call("slow", "read"), call("fast", "read")],
      {
        effectsFor: () => readEffects,
        onStart: (c) => starts.push(c.id),
        onDone: (c) => done.push(c.id),
        execute: async (c) => {
          await new Promise((resolve) =>
            setTimeout(resolve, c.id === "slow" ? 20 : 1)
          )
          return { result: c.id }
        },
      }
    )

    expect(starts).toEqual(["slow", "fast"])
    expect(done).toEqual(["fast", "slow"])
    expect(results.map((r) => r.result)).toEqual(["slow", "fast"])
  })

  it("does not let a failed read cancel sibling reads", async () => {
    const results = await runToolCallBatches(
      [call("bad", "read"), call("good", "read")],
      {
        effectsFor: () => readEffects,
        execute: async (c) => {
          if (c.id === "bad") throw new Error("boom")
          return { result: "ok" }
        },
      }
    )

    expect(results.map((r) => r.result)).toEqual([
      "Error running read: boom",
      "ok",
    ])
  })

  it("settles a read batch before starting the next barrier", async () => {
    const events: string[] = []
    await runToolCallBatches([call("1", "read"), call("2", "write")], {
      effectsFor: (name) => (name === "read" ? readEffects : writeEffects),
      onStart: (c) => events.push(`start:${c.id}`),
      onBatchSettled: (results) => {
        events.push(`settled:${results.map((r) => r.call.id).join(",")}`)
      },
      execute: async (c) => ({ result: c.id }),
    })

    expect(events).toEqual(["start:1", "settled:1", "start:2", "settled:2"])
  })

  it("does not start the next barrier when batch persistence fails", async () => {
    const starts: string[] = []
    const settled: string[] = []

    await expect(
      runToolCallBatches([call("1", "write"), call("2", "write")], {
        effectsFor: () => writeEffects,
        onStart: (c) => starts.push(c.id),
        onBatchSettled: (results) => {
          settled.push(results.map((r) => r.call.id).join(","))
          throw new Error("persist failed")
        },
        execute: async (c) => ({ result: c.id }),
      })
    ).rejects.toMatchObject({
      stage: "result_persistence",
      cause: new Error("persist failed"),
    })

    expect(starts).toEqual(["1"])
    expect(settled).toEqual(["1"])
  })

  it("caps parallel read concurrency", async () => {
    let active = 0
    let maxActive = 0
    await runToolCallBatches(
      [call("1", "read"), call("2", "read"), call("3", "read")],
      {
        effectsFor: () => readEffects,
        concurrency: 2,
        execute: async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active -= 1
          return { result: "ok" }
        },
      }
    )

    expect(maxActive).toBe(2)
  })

  it("stops starting calls after cancellation and reports never-started calls", async () => {
    const abort = new AbortController()
    const starts: string[] = []
    const results = await runToolCallBatches(
      [call("1", "read"), call("2", "read"), call("3", "read")],
      {
        effectsFor: () => readEffects,
        concurrency: 1,
        signal: abort.signal,
        onStart: (c) => starts.push(c.id),
        execute: async (c) => {
          abort.abort()
          return { result: c.id }
        },
      }
    )

    expect(starts).toEqual(["1"])
    expect(results.map((r) => r.outcome)).toEqual([
      "error",
      "not_started",
      "not_started",
    ])
  })

  it("does not start later batches after cancellation", async () => {
    const abort = new AbortController()
    const starts: string[] = []
    const settled: string[] = []
    const results = await runToolCallBatches(
      [call("1", "write"), call("2", "write")],
      {
        effectsFor: () => writeEffects,
        signal: abort.signal,
        onStart: (c) => starts.push(c.id),
        onBatchSettled: (batch) => {
          settled.push(batch.map((r) => `${r.call.id}:${r.outcome}`).join(","))
        },
        execute: async (c) => {
          abort.abort()
          return { result: c.id }
        },
      }
    )

    expect(starts).toEqual(["1"])
    expect(results.map((r) => r.outcome)).toEqual(["unknown", "not_started"])
    expect(settled).toEqual(["1:unknown", "2:not_started"])
  })

  it("records an aborted in-flight side-effecting call as unknown", async () => {
    const abort = new AbortController()
    const results = await runToolCallBatches([call("1", "write")], {
      effectsFor: () => writeEffects,
      signal: abort.signal,
      execute: async () => {
        abort.abort()
        throw new Error("aborted")
      },
    })

    expect(results[0].outcome).toBe("unknown")
    expect(results[0].result).toContain("result unknown")
  })
})

describe("bounded tool settlement", () => {
  it("persists completed siblings before the deadline and quarantines late results", async () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    const done = vi.fn()
    let finish!: (output: { result: string }) => void
    let pendingSignal!: AbortSignal
    const run = runToolCallBatches(
      [call("slow", "read"), call("bad", "read"), call("good", "read")],
      {
        effectsFor: () => readEffects,
        policyFor: () => ({ timeoutMs: 100 }),
        onSettled: settled,
        onDone: done,
        execute: async (c, _index, signal) => {
          if (c.id === "bad") throw new Error("boom")
          if (c.id === "good") return { result: "ok" }
          pendingSignal = signal
          return new Promise((resolve) => {
            finish = resolve
          })
        },
      }
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(settled.mock.calls.map(([r]) => r.call.id)).toEqual(["bad", "good"])
    expect(pendingSignal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    const results = await run
    expect(results.map((r) => r.call.id)).toEqual(["slow", "bad", "good"])
    expect(results[0]).toMatchObject({
      outcome: "error",
      result: expect.stringContaining("ERROR[tool_timeout]"),
    })
    expect(pendingSignal.aborted).toBe(true)
    finish({ result: "late success" })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toHaveBeenCalledTimes(3)
    expect(done).toHaveBeenCalledTimes(3)
    expect(results[0].result).not.toContain("late success")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("stops uncooperative execution and never dequeues queued reads or barriers after Stop", async () => {
    const abort = new AbortController()
    const started = vi.fn()
    let entered!: () => void
    const active = new Promise<void>((resolve) => {
      entered = resolve
    })
    let rejectLate!: (error: Error) => void
    const run = runToolCallBatches(
      [
        call("active", "read"),
        call("queued", "read"),
        call("barrier", "write"),
      ],
      {
        effectsFor: (name) => (name === "read" ? readEffects : writeEffects),
        signal: abort.signal,
        concurrency: 1,
        onStart: started,
        execute: () => {
          entered()
          return new Promise((_, reject) => {
            rejectLate = reject
          })
        },
      }
    )
    await active
    abort.abort()
    const results = await run
    expect(started).toHaveBeenCalledTimes(1)
    expect(results.map((r) => r.outcome)).toEqual([
      "error",
      "not_started",
      "not_started",
    ])
    rejectLate(new Error("late rejection"))
    await Promise.resolve()
  })

  it("blocks subsequent actions when a mutation deadline leaves unknown effects", async () => {
    vi.useFakeTimers()
    const execute = vi.fn(() => new Promise<{ result: string }>(() => {}))
    const run = runToolCallBatches(
      [call("mutation", "write"), call("later", "read")],
      {
        effectsFor: (name) => (name === "read" ? readEffects : writeEffects),
        policyFor: () => ({ timeoutMs: 50 }),
        execute,
      }
    )
    await vi.advanceTimersByTimeAsync(50)
    const results = await run
    expect(results.map((r) => r.outcome)).toEqual(["unknown", "not_started"])
    expect(results[0].result).toContain("cancellation does not undo effects")
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("aborts siblings on persistence failure and preserves the failure stage", async () => {
    const starts: string[] = []
    const done = vi.fn()
    let siblingSignal!: AbortSignal
    const run = runToolCallBatches(
      [
        call("bad", "read"),
        call("pending", "read"),
        call("queued", "read"),
        call("barrier", "write"),
      ],
      {
        effectsFor: (name) => (name === "read" ? readEffects : writeEffects),
        concurrency: 2,
        onStart: (c) => {
          starts.push(c.id)
        },
        onDone: done,
        onSettled: (r) => {
          if (r.call.id === "bad") throw new Error("disk failure")
        },
        execute: async (c, _i, signal) => {
          if (c.id === "bad") return { result: "ok" }
          siblingSignal = signal
          return new Promise(() => {})
        },
      }
    )
    await expect(run).rejects.toMatchObject({
      stage: "result_persistence",
      toolCallId: "bad",
    })
    expect(starts).toEqual(["bad", "pending"])
    expect(siblingSignal.aborted).toBe(true)
    expect(done.mock.calls.some(([c]) => c.id === "bad")).toBe(false)
  })

  it("does not turn dispatch callback failures into tool results", async () => {
    const execute = vi.fn()
    const settled = vi.fn()
    await expect(
      runToolCallBatches([call("1", "read")], {
        effectsFor: () => readEffects,
        execute,
        onSettled: settled,
        onStart: () => {
          throw new Error("dispatch failed")
        },
      })
    ).rejects.toBeInstanceOf(ToolLifecycleError)
    expect(execute).not.toHaveBeenCalled()
    expect(settled).not.toHaveBeenCalled()
  })
})

it("keeps Stop connected to resumable backends after their initial result", async () => {
  const abort = new AbortController()
  let sessionSignal!: AbortSignal
  const results = await runToolCallBatches([call("session", "command")], {
    effectsFor: () => writeEffects,
    signal: abort.signal,
    execute: async (_call, _index, signal) => {
      sessionSignal = signal
      return { result: "Session is running" }
    },
  })
  expect(results[0].outcome).toBe("success")
  expect(sessionSignal.aborted).toBe(false)
  abort.abort()
  expect(sessionSignal.aborted).toBe(true)
})
