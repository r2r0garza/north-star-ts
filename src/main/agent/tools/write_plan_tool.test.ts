import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import path from "path"

// The plan path is app.getPath("home") + dataDirName() + plans/<id>.md. Mock the
// home to a throwaway temp dir and pin the data-dir name so the test writes to a
// predictable, isolated location.
let home = ""
vi.mock("electron", () => ({ app: { getPath: () => home } }))
vi.mock("../../config/system-name", () => ({ dataDirName: () => ".cowork" }))

import { writePlanTool } from "./write_plan_tool"
import { planFilePath } from "./plan-file"

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "plan-tool-"))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("write_plan_tool", () => {
  it("writes to ~/.cowork/plans/<conversationId>.md, creating the dir", async () => {
    const res = await writePlanTool.execute(
      { content: "# Plan\n\nStep 1." },
      { workspace: "", conversationId: "conv-1" }
    )
    const file = planFilePath("conv-1")
    expect(file).toBe(path.join(home, ".cowork", "plans", "conv-1.md"))
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, "utf-8")).toBe("# Plan\n\nStep 1.")
    expect(res).toContain("Plan saved")
  })

  it("overwrites the whole file on a second call", async () => {
    const ctx = { workspace: "", conversationId: "conv-2" }
    await writePlanTool.execute({ content: "first" }, ctx)
    await writePlanTool.execute({ content: "second" }, ctx)
    expect(readFileSync(planFilePath("conv-2"), "utf-8")).toBe("second")
  })

  it("rejects empty content", async () => {
    const res = await writePlanTool.execute(
      { content: "   " },
      { workspace: "", conversationId: "conv-3" }
    )
    expect(res).toContain("ERROR[bad_args]")
    expect(existsSync(planFilePath("conv-3"))).toBe(false)
  })

  it("reports unavailable without a conversationId", async () => {
    const res = await writePlanTool.execute(
      { content: "x" },
      { workspace: "" }
    )
    expect(res).toContain("ERROR[unavailable]")
  })
})
