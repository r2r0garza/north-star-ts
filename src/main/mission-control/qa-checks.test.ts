import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import { mkdirSync, writeFileSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type {
  MissionControlRunLink,
  ProcessPhaseRun,
  ProcessRun,
} from "../db/types"

// In-memory stand-ins for the run, its phase runs, and the plan.
const phaseRuns = new Map<string, ProcessPhaseRun>()
const phases = new Map<string, { id: string; proofStep: boolean }>()
let run: ProcessRun

vi.mock("../db/repositories/processes", () => ({
  getProcessRun: (id: string) => (id === run.id ? run : undefined),
  getPhaseRun: (id: string) => phaseRuns.get(id),
  getPhase: (id: string) => phases.get(id),
  listPhaseRuns: ({ runId }: { runId: string }) =>
    [...phaseRuns.values()].filter((pr) => pr.runId === runId),
  getProcessRunByParentPhaseRunId: () => undefined,
  updatePhaseRun: (id: string, patch: Partial<ProcessPhaseRun>) => {
    const next = { ...phaseRuns.get(id)!, ...patch }
    phaseRuns.set(id, next)
    return next
  },
}))
vi.mock("../db/repositories/features", () => ({
  getFeature: (id: string) =>
    id === "f1" ? { id, key: "billing", workspaceId: "w1" } : null,
  getUserStory: (id: string) => stories.find((s) => s.id === id) ?? null,
  getMilestone: (id: string) => (id === "m1" ? { id, key: "m1" } : null),
  listUserStories: () => stories,
}))
vi.mock("../db/repositories/workspaces", () => ({
  getWorkspace: () => ({ missionControl: { checksDir: "e2e" } }),
}))

const stories = [
  {
    id: "s1",
    key: "login",
    milestoneId: "m1",
    spec: { acceptance: ["Redirects after login", "Shows the copy"] },
  },
  {
    id: "s2",
    key: "logout",
    milestoneId: "m1",
    spec: { acceptance: ["Logs out"] },
  },
]

import {
  checksDriftBlock,
  completeAuthorStep,
  qaStepKind,
  refreezeQaChecks,
  runQaChecks,
  startVerifyStep,
  summarizeCheckRun,
} from "./qa-checks"

const link: MissionControlRunLink = {
  featureId: "f1",
  milestoneId: "m1",
  userStoryId: "s1",
  playbookRunId: "p1",
  hook: "run",
}

let root: string
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" })
const write = (path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true })
  writeFileSync(join(root, path), text)
}

function phaseRun(id: string, phaseId: string, seat: string): ProcessPhaseRun {
  return {
    id,
    runId: "r1",
    phaseId,
    parentId: null,
    status: "running",
    taskId: null,
    agentName: null,
    title: null,
    iteration: 0,
    error: null,
    failure: null,
    startedAt: 1,
    finishedAt: null,
    reworkNote: null,
    reworkRound: 0,
    validatorRound: 0,
    resultContent: null,
    reviewStartedAt: null,
    outputIdentity: null,
    sourceChildRunId: null,
    seatAddress: seat,
    qaChecks: null,
  }
}

const manifest = (commands: { ac1: string; ac2?: string }) =>
  JSON.stringify({
    criteria: {
      "AC-1": [
        {
          id: "ac1",
          kind: "automated",
          command: commands.ac1,
          timeoutMs: 1500,
        },
      ],
      "AC-2": commands.ac2
        ? [{ id: "ac2", kind: "automated", command: commands.ac2 }]
        : [{ id: "ac2-copy", kind: "exploratory", note: "Check the copy" }],
    },
  })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "qa-checks-"))
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  write("src/app.ts", "export const app = 1\n")
  write("e2e/pages/login.ts", "export const loginButton = '#login'\n")
  git("add", "-A")
  git("commit", "-qm", "init")
  phaseRuns.clear()
  phases.clear()
  phases.set("checks", { id: "checks", proofStep: false })
  phases.set("test", { id: "test", proofStep: true })
  phaseRuns.set("author", phaseRun("author", "checks", "qa@pod"))
  phaseRuns.set("verify", phaseRun("verify", "test", "qa@pod"))
  run = {
    id: "r1",
    parentPhaseRunId: null,
    missionControl: link,
    seatBindings: {
      seats: { "qa@pod": { address: "qa@pod", role: "qa" } },
    },
  } as unknown as ProcessRun
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("qaStepKind", () => {
  it("is author for a QA step, verify for a QA proof step, else none", () => {
    expect(qaStepKind({ role: "qa", proofStep: false, link })).toBe("author")
    expect(qaStepKind({ role: "qa", proofStep: true, link })).toBe("verify")
    expect(qaStepKind({ role: "builder", proofStep: false, link })).toBeNull()
    expect(
      qaStepKind({
        role: "qa",
        proofStep: true,
        link: { ...link, userStoryId: null },
      })
    ).toBeNull()
  })
})

describe("the checks step", () => {
  it("does not complete without a valid manifest", async () => {
    const before = { ok: false }
    const missing = await completeAuthorStep({
      phaseRunId: "author",
      link,
      runId: "r1",
      workspace: root,
      before: null,
    })
    expect(missing).toMatchObject(before)
    if (!missing.ok)
      expect(missing.message).toMatch(/e2e\/stories\/billing\.m1\.login\.json/)

    write("e2e/stories/billing.m1.login.json", '{"criteria":{"AC-1":[]}}')
    const invalid = await completeAuthorStep({
      phaseRunId: "author",
      link,
      runId: "r1",
      workspace: root,
      before: null,
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) {
      expect(invalid.message).toMatch(/AC-1 needs a non-empty list/)
      expect(invalid.message).toMatch(/missing: AC-2\./)
    }
    expect(phaseRuns.get("author")!.qaChecks).toBeNull()
  })

  it("freezes the whole checks directory and records writes outside it", async () => {
    const { worktreeChanges } = await import("./qa-checks")
    const before = await worktreeChanges(root)
    write(
      "e2e/specs/login.spec.ts",
      "test('redirects @billing.m1.login @AC-1')\n"
    )
    write("e2e/stories/billing.m1.login.json", manifest({ ac1: "true" }))
    write("src/app.ts", "export const app = 2\n") // a shell write by QA
    const done = await completeAuthorStep({
      phaseRunId: "author",
      link,
      runId: "r1",
      workspace: root,
      before,
    })
    expect(done).toEqual({
      ok: true,
      warnings: [expect.stringMatching(/"ac1"/)],
    })
    const state = phaseRuns.get("author")!.qaChecks!
    expect(Object.keys(state.freeze!.files)).toEqual([
      "e2e/pages/login.ts",
      "e2e/specs/login.spec.ts",
      "e2e/stories/billing.m1.login.json",
    ])
    expect(state.outsideWrites).toEqual(["src/app.ts"])
  })
})

describe("drift between the checks and test steps", () => {
  async function author() {
    write(
      "e2e/specs/login.spec.ts",
      "test('redirects @billing.m1.login @AC-1')\n"
    )
    write("e2e/stories/billing.m1.login.json", manifest({ ac1: "true" }))
    const done = await completeAuthorStep({
      phaseRunId: "author",
      link,
      runId: "r1",
      workspace: root,
      before: null,
    })
    expect(done.ok).toBe(true)
  }

  it("adds no note when the checks are unchanged", async () => {
    await author()
    const note = await startVerifyStep({
      run,
      phaseRunId: "verify",
      workspace: root,
      resuming: false,
    })
    expect(note).toMatch(/Start by calling `run_checks`/)
    expect(note).not.toMatch(/changed after they were frozen/)
    expect(checksDriftBlock(phaseRuns.get("verify")!)).toBeNull()
  })

  it("lists a builder's edit to a story check and blocks acceptance until re-frozen", async () => {
    await author()
    write(
      "e2e/specs/login.spec.ts",
      "test.skip('redirects @billing.m1.login @AC-1')\nexport {}\n"
    )
    const note = await startVerifyStep({
      run,
      phaseRunId: "verify",
      workspace: root,
      resuming: false,
    })
    expect(note).toMatch(/This story's checks and manifest:/)
    expect(note).toMatch(/`e2e\/specs\/login\.spec\.ts`: modified \(\+2 −1\)/)
    expect(checksDriftBlock(phaseRuns.get("verify")!)).toMatch(
      /e2e\/specs\/login\.spec\.ts/
    )

    const refrozen = await refreezeQaChecks({
      processRunId: "r1",
      phaseRunId: "verify",
      workspace: root,
      reason: "I fixed my own check's selector",
    })
    expect(refrozen).toEqual({ ok: true, files: 3, changed: 1 })
    expect(checksDriftBlock(phaseRuns.get("verify")!)).toBeNull()
  })

  it("marks an edit to only a shared page object as shared", async () => {
    await author()
    write("e2e/pages/login.ts", "export const loginButton = 'button'\n")
    const note = await startVerifyStep({
      run,
      phaseRunId: "verify",
      workspace: root,
      resuming: false,
    })
    expect(note).toMatch(/Shared files \(page objects/)
    expect(note).not.toMatch(/This story's checks and manifest:/)
    const drift = phaseRuns.get("verify")!.qaChecks!.drift!
    expect(drift.changed).toEqual([
      expect.objectContaining({
        path: "e2e/pages/login.ts",
        change: "modified",
        shared: true,
      }),
    ])
    expect(checksDriftBlock(phaseRuns.get("verify")!)).not.toBeNull()
  })

  it("only the test step re-freezes", async () => {
    await author()
    expect(
      await refreezeQaChecks({
        processRunId: "r1",
        phaseRunId: "author",
        workspace: root,
        reason: "x",
      })
    ).toMatchObject({ ok: false, code: "not_test_step" })
  })
})

describe("run_checks", () => {
  const runAll = (checkIds?: string[]) =>
    runQaChecks({
      processRunId: "r1",
      phaseRunId: "verify",
      workspace: root,
      checkIds,
    })

  it("records a pass and a fail, retrying the failure once", async () => {
    write(
      "e2e/stories/billing.m1.login.json",
      manifest({ ac1: "echo ok", ac2: "echo broken >&2; exit 3" })
    )
    const outcome = await runAll()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(
      outcome.results.map((r) => [r.checkId, r.attempt, r.passed, r.exitCode])
    ).toEqual([
      ["ac1", 1, true, 0],
      ["ac2", 1, false, 3],
      ["ac2", 2, false, 3],
    ])
    expect(outcome.results[1].outputTail).toMatch(/broken/)
    expect(phaseRuns.get("verify")!.qaChecks!.results).toHaveLength(3)
    const summary = summarizeCheckRun(outcome)
    expect(summary).toMatch(/1 passed, 1 failed, 0 flaky/)
    expect(summary).toMatch(/broken/)
  })

  it("shows a flaky check: fails, then passes on the retry", async () => {
    write(
      "e2e/stories/billing.m1.login.json",
      manifest({
        ac1: "if [ -f .flake ]; then exit 0; else touch .flake; exit 1; fi",
      })
    )
    const outcome = await runAll()
    expect(outcome.ok && outcome.results.map((r) => r.passed)).toEqual([
      false,
      true,
    ])
    if (outcome.ok) {
      expect(summarizeCheckRun(outcome)).toMatch(/0 failed, 1 flaky/)
      expect(summarizeCheckRun(outcome)).toMatch(/ac2-copy .*Check the copy/)
    }
  })

  it("stops a check at its timeout", async () => {
    write("e2e/stories/billing.m1.login.json", manifest({ ac1: "sleep 5" }))
    const outcome = await runAll()
    expect(outcome.ok && outcome.results[0]).toMatchObject({
      passed: false,
      timedOut: true,
    })
  }, 10_000)

  it("runs only the named checks and refuses unknown ids", async () => {
    write(
      "e2e/stories/billing.m1.login.json",
      manifest({ ac1: "true", ac2: "true" })
    )
    const only = await runAll(["ac2"])
    expect(only.ok && only.results.map((r) => r.checkId)).toEqual(["ac2"])
    expect(await runAll(["nope"])).toMatchObject({
      ok: false,
      code: "unknown_check",
    })
  })

  it("refuses without a manifest, and for a builder seat", async () => {
    expect(await runAll()).toMatchObject({ ok: false, code: "no_manifest" })
    phaseRuns.set("build", phaseRun("build", "checks", "builder@pod"))
    ;(run.seatBindings!.seats as Record<string, unknown>)["builder@pod"] = {
      address: "builder@pod",
      role: "builder",
    }
    expect(
      await runQaChecks({
        processRunId: "r1",
        phaseRunId: "build",
        workspace: root,
      })
    ).toMatchObject({ ok: false, code: "unavailable" })
  })

  it("runs every merged story's checks on reverify", async () => {
    run.missionControl = { ...link, hook: "after_each_user_story" }
    write("e2e/stories/billing.m1.login.json", manifest({ ac1: "true" }))
    write(
      "e2e/stories/billing.m1.logout.json",
      JSON.stringify({
        criteria: {
          "AC-1": [{ id: "logout-1", kind: "automated", command: "exit 1" }],
        },
      })
    )
    // Another milestone's manifest is ignored.
    write("e2e/stories/billing.m2.other.json", "{}")
    const outcome = await runAll()
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results.map((r) => [r.storyRef, r.checkId])).toEqual([
      ["billing.m1.login", "ac1"],
      ["billing.m1.logout", "logout-1"],
      ["billing.m1.logout", "logout-1"],
    ])
    expect(outcome.problems).toEqual([])
  })
})
