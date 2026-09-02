import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, writeFile, symlink, rm, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { ProcessRun } from "../../db/types"
import { parseCompletionContract } from "../../process/completion-contract"
import {
  checkPhaseOutcome,
  completionInstruction,
  parsePhaseOutcome,
  runCompletionContract,
} from "./completion"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))
  )
})
const outcome = {
  version: 1 as const,
  attemptId: "current",
  status: "completed" as const,
  output: "Report ready",
  evidence: "Read the report",
}
const contract = {
  policy: "validated" as const,
  version: 1 as const,
  requiredArtifacts: ["report.txt"],
}

describe("phase completion boundary", () => {
  it("fails closed for a phase absent from a run snapshot", () => {
    expect(() =>
      runCompletionContract(
        { completionContracts: {} } as ProcessRun,
        "new-phase"
      )
    ).toThrow("no recorded completion contract")
  })
  it.each([
    undefined,
    "done",
    "{}",
    "[]",
    JSON.stringify({ ...outcome, attemptId: "old" }),
    JSON.stringify({ ...outcome, evidence: "" }),
    JSON.stringify({ ...outcome, status: "blocked" }),
  ])("rejects missing, malformed or stale outcomes: %s", (content) => {
    expect(() => parsePhaseOutcome(content, "current")).toThrow()
  })
  it("accepts a recovered outcome without scanning failure phrases", () => {
    const value = {
      ...outcome,
      evidence:
        "I couldn't write initially, then recovered and verified the file",
    }
    expect(parsePhaseOutcome(JSON.stringify(value), "current")).toEqual(value)
    expect(completionInstruction({ policy: "legacy" }, "id")).toBe("")
  })
  it.each([
    null,
    {},
    { policy: "validated", version: 2, requiredArtifacts: [] },
    ...["../outside", "/outside", "C:\\outside", "dir/../../outside"].map(
      (p) => ({ ...contract, requiredArtifacts: [p] })
    ),
  ])("rejects invalid contract %j", (value) => {
    expect(() => parseCompletionContract(value)).toThrow()
  })
  it("checks regular files and rejects missing files, directories and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "completion-"))
    dirs.push(root)
    const workspace = join(root, "workspace")
    await mkdir(workspace)
    await expect(
      checkPhaseOutcome({ contract, outcome, workspace })
    ).rejects.toThrow("Required file")
    await writeFile(join(workspace, "report.txt"), "report")
    expect(
      (await checkPhaseOutcome({ contract, outcome, workspace }))
        .checkedArtifacts
    ).toEqual(["report.txt"])
    await expect(checkPhaseOutcome({ contract, outcome })).rejects.toThrow(
      "no workspace"
    )
    await writeFile(join(root, "outside"), "private")
    await symlink(join(root, "outside"), join(workspace, "link"))
    await expect(
      checkPhaseOutcome({
        contract: { ...contract, requiredArtifacts: ["link"] },
        outcome,
        workspace,
      })
    ).rejects.toThrow("outside")
    await mkdir(join(workspace, "folder"))
    await expect(
      checkPhaseOutcome({
        contract: { ...contract, requiredArtifacts: ["folder"] },
        outcome,
        workspace,
      })
    ).rejects.toThrow("regular file")
  })
})
