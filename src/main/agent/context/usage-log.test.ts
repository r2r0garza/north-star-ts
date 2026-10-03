import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() } }))

import {
  CONTEXT_USAGE_LOG_FILE,
  CONTEXT_USAGE_LOG_ROTATED_FILE,
  createContextUsageLog,
  formatContextUsageLine,
  type ContextUsageEntry,
} from "./usage-log"

function entry(overrides: Partial<ContextUsageEntry> = {}): ContextUsageEntry {
  return {
    at: "2026-10-02T18:04:11.201Z",
    conversationId: "conv-1",
    taskId: null,
    agentDepth: 0,
    turnStartSeq: 412,
    round: 17,
    roundId: "after-seq:440",
    attempt: 1,
    provider: "openai_compatible",
    accountId: "acct-1",
    model: "copilot/gpt-5",
    mode: "north_star",
    seat: null,
    request: {
      reported: 48211,
      estimated: 46030,
      estimator: "o200k",
      ratio: 1.047,
      usageRequested: true,
      byRole: { system: 6120, user: 310, assistant: 4402, tool: 34198 },
      toolDefs: 1000,
      messageCount: 39,
      largest: { role: "tool", toolName: "read_file", tokens: 9120 },
    },
    response: { reported: 812, estimated: 790, finishReason: "tool_calls" },
    outcome: "ok",
    ...overrides,
  }
}

const quiet = { info: () => {}, warn: () => {} }

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ctx-usage-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("context usage log", () => {
  it("writes one valid JSON line per entry", async () => {
    const log = createContextUsageLog({
      dir: () => join(dir, "logs"),
      console: quiet,
    })
    await log.append(entry({ round: 1 }))
    await log.append(entry({ round: 2, outcome: "retry" }))

    const lines = (
      await readFile(join(dir, "logs", CONTEXT_USAGE_LOG_FILE), "utf-8")
    )
      .trim()
      .split("\n")
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => JSON.parse(line).round)).toEqual([1, 2])
    expect(JSON.parse(lines[1]).outcome).toBe("retry")
  })

  it("rotates at the size cap and keeps one old file", async () => {
    const line = JSON.stringify(entry()) + "\n"
    const log = createContextUsageLog({
      dir: () => dir,
      maxBytes: Buffer.byteLength(line) * 2,
      console: quiet,
    })
    for (let round = 1; round <= 5; round++) {
      await log.append(entry({ round }))
    }

    const current = (await readFile(join(dir, CONTEXT_USAGE_LOG_FILE), "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).round)
    const rotated = (
      await readFile(join(dir, CONTEXT_USAGE_LOG_ROTATED_FILE), "utf-8")
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).round)
    expect(current).toEqual([5])
    expect(rotated).toEqual([3, 4])
    expect((await stat(join(dir, CONTEXT_USAGE_LOG_FILE))).size).toBeLessThan(
      Buffer.byteLength(line) * 2
    )
  })

  it("swallows write failures and warns once", async () => {
    // A file where the log directory should be.
    const blocked = join(dir, "not-a-dir")
    await writeFile(blocked, "x")
    const warn = vi.fn()
    const log = createContextUsageLog({
      dir: () => blocked,
      console: { info: () => {}, warn },
    })
    await expect(log.append(entry())).resolves.toBeUndefined()
    await expect(log.append(entry())).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it("formats a short console line", () => {
    expect(formatContextUsageLine(entry())).toBe(
      "[ctx] round 17 · 48.2k in (reported) · 0.8k out"
    )
    expect(
      formatContextUsageLine(
        entry({
          outcome: "stalled",
          request: { ...entry().request, reported: null },
          response: { reported: null, estimated: null, finishReason: null },
        })
      )
    ).toBe("[ctx] round 17 · 46.0k in (est) · stalled")
  })
})
