import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, writeFile, symlink, rm, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type { ProcessRun } from "../../db/types"
import { parseCompletionContract } from "../../process/completion-contract"
import {
  checkPhaseOutcome,
  completionInstruction,
  mergeOutcomeReply,
  parseOutcomeObject,
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
  it.each([
    ["done", "not a single JSON object"],
    [
      JSON.stringify({ ...outcome, attemptId: "old" }),
      '`attemptId` is stale or missing (expected "current")',
    ],
    [
      JSON.stringify({ ...outcome, evidence: "" }),
      "`evidence` is missing or empty",
    ],
    [
      JSON.stringify({ ...outcome, status: "blocked" }),
      "`status: blocked` also needs `reason` and `nextAction`",
    ],
    [
      JSON.stringify({ ...outcome, status: "done" }),
      "`status` must be completed, blocked, or failed",
    ],
  ])("names the problem in %s", (content, problem) => {
    expect(() => parsePhaseOutcome(content, "current")).toThrow(problem)
  })
  it("lists every problem at once", () => {
    const content = JSON.stringify({
      version: 1,
      attemptId: "current",
      status: "blocked",
      output: "x",
    })
    expect(() => parsePhaseOutcome(content, "current")).toThrow(
      "Invalid phase outcome: `evidence` is missing or empty; `status: blocked` also needs `reason` and `nextAction`"
    )
  })
  it("repairs an object closed early and carried on", () => {
    // The real slip: `}` after output, then `,"evidence":…}`.
    const { evidence, ...head } = outcome
    const content = `${JSON.stringify(head)},"evidence":${JSON.stringify(evidence)}}`
    expect(parsePhaseOutcome(content, "current")).toEqual(outcome)
  })
  it("reads an outcome wrapped in a json code fence", () => {
    const content = "```json\n" + JSON.stringify(outcome) + "\n```"
    expect(parsePhaseOutcome(content, "current")).toEqual(outcome)
  })
  it("names where the JSON broke", () => {
    expect(() =>
      parsePhaseOutcome(
        '{"version":1,"status":"completed" "output":"x"}',
        "current"
      )
    ).toThrow(
      /not a single JSON object \(invalid JSON at character \d+: .* near "/
    )
    expect(parseOutcomeObject("")).toEqual({ error: "the reply is empty" })
    expect(parseOutcomeObject("[1]")).toEqual({
      error: "the reply is JSON but not an object",
    })
  })
  it("merges a correction into earlier fields without erasing them", () => {
    const first = mergeOutcomeReply(
      undefined,
      JSON.stringify({ ...outcome, status: "blocked" })
    )
    const merged = mergeOutcomeReply(
      first,
      JSON.stringify({ reason: "r", nextAction: "n", evidence: "" })
    )
    expect(merged).toMatchObject({
      evidence: "Read the report",
      reason: "r",
      nextAction: "n",
    })
    expect(mergeOutcomeReply(merged, "not json")).toBe(merged)
    expect(mergeOutcomeReply(undefined, "[]")).toBeUndefined()
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
    await mkdir(join(root, "outside"))
    await writeFile(join(root, "outside", "private.txt"), "private")
    await symlink(
      join(root, "outside"),
      join(workspace, "link"),
      process.platform === "win32" ? "junction" : "dir"
    )
    await expect(
      checkPhaseOutcome({
        contract: { ...contract, requiredArtifacts: ["link/private.txt"] },
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
