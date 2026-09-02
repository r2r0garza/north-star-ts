import { describe, expect, it } from "vitest"
import {
  runToolCallBatches,
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
    ).rejects.toThrow("persist failed")

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
      "success",
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
    expect(results.map((r) => r.outcome)).toEqual(["success", "not_started"])
    expect(settled).toEqual(["1:success", "2:not_started"])
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
