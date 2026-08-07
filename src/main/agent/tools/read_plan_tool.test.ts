import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"

// read_plan resolves the same fixed path as write_plan (home + dataDirName +
// plans/<id>.md). Mock home to a throwaway dir and pin the data-dir name so the
// two tools agree on the location within the test.
let home = ""
vi.mock("electron", () => ({ app: { getPath: () => home } }))
vi.mock("../../config/system-name", () => ({ dataDirName: () => ".cowork" }))

import { readPlanTool } from "./read_plan_tool"
import { writePlanTool } from "./write_plan_tool"

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "read-plan-tool-"))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("read_plan_tool", () => {
  it("reads back what write_plan saved for the same conversation", async () => {
    const ctx = { workspace: "", conversationId: "conv-1" }
    await writePlanTool.execute({ content: "# Plan\n\nStep 1." }, ctx)
    const res = await readPlanTool.execute({}, ctx)
    expect(res).toContain("# Plan")
    expect(res).toContain("Step 1.")
  })

  it("reports no_plan when nothing has been written yet", async () => {
    const res = await readPlanTool.execute(
      {},
      { workspace: "", conversationId: "conv-missing" }
    )
    expect(res).toContain("ERROR[no_plan]")
  })

  it("reports unavailable without a conversationId", async () => {
    const res = await readPlanTool.execute({}, { workspace: "" })
    expect(res).toContain("ERROR[unavailable]")
  })
})
