import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import path from "path"

let home = ""
vi.mock("electron", () => ({ app: { getPath: () => home } }))
vi.mock("../../config/system-name", () => ({ dataDirName: () => ".cowork" }))

import {
  deletePlanFile,
  deletePlanFiles,
  PLAN_TTL_MS,
  planFilePath,
  pruneExpiredPlanFiles,
  runPlanMaintenance,
  startPlanMaintenance,
  stopPlanMaintenance,
} from "./plan-file"

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "plan-file-"))
})

afterEach(async () => {
  stopPlanMaintenance()
  await import("fs/promises").then(({ rm }) =>
    rm(home, { recursive: true, force: true })
  )
  vi.restoreAllMocks()
})

function writePlan(id: string, mtimeMs?: number): string {
  const file = planFilePath(id)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, id)
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
  return file
}

describe("plan file lifecycle", () => {
  it("deletes an existing plan and tolerates missing files and directories", async () => {
    const file = writePlan("delete-me")
    await deletePlanFile("delete-me")
    expect(existsSync(file)).toBe(false)
    await expect(deletePlanFile("delete-me")).resolves.toBe(false)

    home = mkdtempSync(path.join(tmpdir(), "plan-file-missing-"))
    await expect(deletePlanFile("never-created")).resolves.toBe(false)
  })

  it("continues batch deletion after a per-file failure", async () => {
    const blocked = planFilePath("blocked")
    mkdirSync(blocked, { recursive: true })
    const removable = writePlan("removable")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const result = await deletePlanFiles(["blocked", "removable"])

    expect(result).toEqual({ removed: 1, failed: 1 })
    expect(existsSync(removable)).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })

  it("prunes only regular Markdown files strictly older than 30 days", async () => {
    const now = Math.floor(Date.now() / 1_000) * 1_000
    const expired = writePlan("expired", now - PLAN_TTL_MS - 1_000)
    const cutoff = writePlan("cutoff", now - PLAN_TTL_MS)
    const current = writePlan("current", now - PLAN_TTL_MS + 1_000)
    const plansDir = path.dirname(expired)
    const unrelated = path.join(plansDir, "old.txt")
    writeFileSync(unrelated, "old")
    utimesSync(unrelated, 1, 1)
    mkdirSync(path.join(plansDir, "nested.md"))
    symlinkSync(expired, path.join(plansDir, "link.md"))

    const result = await pruneExpiredPlanFiles(now)

    expect(result).toEqual({ inspected: 3, removed: 1, failed: 0 })
    expect(existsSync(expired)).toBe(false)
    expect(existsSync(cutoff)).toBe(true)
    expect(existsSync(current)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
    expect(existsSync(path.join(plansDir, "nested.md"))).toBe(true)
    expect(lstatSync(path.join(plansDir, "link.md")).isSymbolicLink()).toBe(
      true
    )
  })

  it("does not create a missing plans directory while pruning", async () => {
    await expect(pruneExpiredPlanFiles()).resolves.toEqual({
      inspected: 0,
      removed: 0,
      failed: 0,
    })
    expect(existsSync(path.dirname(planFilePath("unused")))).toBe(false)
  })

  it("retains a rewritten file for a fresh retention window", async () => {
    const now = Date.now()
    const file = writePlan("rewritten", now - PLAN_TTL_MS - 1_000)
    writeFileSync(file, "fresh")

    const result = await pruneExpiredPlanFiles(now)

    expect(result.removed).toBe(0)
    expect(existsSync(file)).toBe(true)
  })

  it("runs maintenance at startup and daily until stopped", async () => {
    vi.useFakeTimers({ now: Date.now() })
    try {
      const first = writePlan("startup", Date.now() - PLAN_TTL_MS - 1_000)
      await startPlanMaintenance()
      expect(existsSync(first)).toBe(false)

      const daily = writePlan("daily", Date.now() - PLAN_TTL_MS + 1_000)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(existsSync(daily)).toBe(true)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000)
      await runPlanMaintenance()
      expect(existsSync(daily)).toBe(false)

      stopPlanMaintenance()
      const stopped = writePlan("stopped", Date.now() - PLAN_TTL_MS - 1_000)
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000)
      expect(existsSync(stopped)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
