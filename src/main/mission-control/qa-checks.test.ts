import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import { mkdirSync, writeFileSync } from "fs"
import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type {
  AppLaunch,
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
let appLaunch: AppLaunch = { services: [] }
vi.mock("../db/repositories/workspaces", () => ({
  getWorkspace: () => ({ missionControl: { checksDir: "e2e" }, appLaunch }),
}))

// Overrides for the test browser tests; the real modules otherwise.
const overrides = vi.hoisted(() => ({
  runPlaywrightCheck: null as null | ((input: unknown) => Promise<unknown>),
  waitForTestBrowser: null as
    | null
    | ((signal?: AbortSignal) => Promise<boolean>),
  events: [] as Array<{ type: string; refId?: string | null }>,
}))
vi.mock("./playwright-runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./playwright-runner")>()
  return {
    ...actual,
    runPlaywrightCheck: (
      input: Parameters<typeof actual.runPlaywrightCheck>[0]
    ) =>
      overrides.runPlaywrightCheck
        ? overrides.runPlaywrightCheck(input)
        : actual.runPlaywrightCheck(input),
  }
})
vi.mock("./playwright-install", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./playwright-install")>()
  return {
    ...actual,
    waitForTestBrowser: (signal?: AbortSignal) =>
      overrides.waitForTestBrowser
        ? overrides.waitForTestBrowser(signal)
        : actual.waitForTestBrowser(signal),
  }
})
vi.mock("../db/repositories/mc-events", () => ({
  recordEvent: (event: { type: string; refId?: string | null }) => {
    overrides.events.push(event)
    return true
  },
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
  appGuidance,
  authorStepNote,
  completeAuthorStep,
  exploreStepNote,
  qaStepKind,
  runQaChecks,
  smokeStepNote,
  storyChecks,
  summarizeCheckRun,
  unreachableReason,
} from "./qa-checks"
import { testAppServices } from "./app-launch"
import { setEvidenceRoot } from "./evidence"
import {
  appStartTool,
  appStatusTool,
  appStopTool,
} from "../agent/tools/app_launch_tools"
import type { ToolContext } from "../agent/tools/types"

const link: MissionControlRunLink = {
  featureId: "f1",
  milestoneId: "m1",
  userStoryId: "s1",
  playbookRunId: "p1",
  hook: "run",
}
// A merge conflict's resolution of the same story: its QA proof step is a
// smoke step that runs no checks (plan 110.05).
const smokeLink: MissionControlRunLink = {
  ...link,
  hook: "after_each_user_story",
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
  overrides.runPlaywrightCheck = null
  overrides.waitForTestBrowser = null
  overrides.events = []
  appLaunch = { services: [] }
  await testAppServices.clear()
  await rm(root, { recursive: true, force: true })
})

const NODE = JSON.stringify(process.execPath)
const webService: AppLaunch["services"][number] = {
  key: "web",
  label: "Web",
  command: `${NODE} -e "require('http').createServer((q,s)=>s.end('hello')).listen(Number(process.env.PORT),'127.0.0.1')"`,
  cwd: "",
  port: "auto",
  ready: { http: "/" },
  readyTimeoutMs: 15_000,
  source: "user",
}

describe("qaStepKind", () => {
  it("is explore for a story's QA proof step, author for its other QA steps (plan 110.04)", () => {
    expect(qaStepKind({ role: "qa", proofStep: false, link })).toBe("author")
    expect(qaStepKind({ role: "qa", proofStep: true, link })).toBe("explore")
    expect(qaStepKind({ role: "builder", proofStep: false, link })).toBeNull()
    expect(
      qaStepKind({
        role: "qa",
        proofStep: true,
        link: { ...link, userStoryId: null },
      })
    ).toBeNull()
  })

  it("is smoke for a merge conflict's resolution (plan 110.05)", () => {
    expect(qaStepKind({ role: "qa", proofStep: true, link: smokeLink })).toBe(
      "smoke"
    )
  })

  it("is gate for a QA proof step in a milestone's wave gate (plan 110.02)", () => {
    const gate = {
      ...link,
      userStoryId: null,
      hook: "after_each_wave" as const,
    }
    expect(qaStepKind({ role: "qa", proofStep: true, link: gate })).toBe("gate")
    expect(qaStepKind({ role: "qa", proofStep: false, link: gate })).toBeNull()
    expect(
      qaStepKind({ role: "builder", proofStep: true, link: gate })
    ).toBeNull()
  })
})

describe("the checks step (a playbook from before plan 110.04)", () => {
  it("does not complete without a valid manifest", async () => {
    const missing = await completeAuthorStep({ link, workspace: root })
    expect(missing).toMatchObject({ ok: false })
    if (!missing.ok)
      expect(missing.message).toMatch(/e2e\/stories\/billing\.m1\.login\.json/)

    write("e2e/stories/billing.m1.login.json", '{"criteria":{"AC-1":[]}}')
    const invalid = await completeAuthorStep({ link, workspace: root })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) {
      expect(invalid.message).toMatch(/AC-1 needs a non-empty list/)
      expect(invalid.message).toMatch(/missing: AC-2\./)
    }
  })

  it("completes with a valid manifest and freezes nothing", async () => {
    write(
      "e2e/specs/login.spec.ts",
      "test('redirects @billing.m1.login @AC-1')\n"
    )
    write("e2e/stories/billing.m1.login.json", manifest({ ac1: "true" }))
    const done = await completeAuthorStep({ link, workspace: root })
    expect(done).toEqual({
      ok: true,
      warnings: [expect.stringMatching(/"ac1"/)],
    })
    expect(phaseRuns.get("author")!.qaChecks).toBeNull()
  })

  it("says the gate runs the checks, not that they're frozen", () => {
    const note = authorStepNote(storyChecks(link)!)
    expect(note).toMatch(/acceptance gate runs these checks/)
    expect(note).not.toMatch(/frozen/)
  })
})

describe("checks that can't reach the app (plan 109.07)", () => {
  const playwrightManifest = JSON.stringify({
    criteria: {
      "AC-1": [
        {
          id: "ac1-add",
          kind: "automated",
          runner: "playwright",
          spec: "specs/list.spec.ts",
        },
      ],
      "AC-2": [{ id: "ac2-copy", kind: "exploratory", note: "Check the copy" }],
    },
  })
  const complete = () => completeAuthorStep({ link, workspace: root })

  it("won't finish the checks step with no recipe and nothing starting the app", async () => {
    write("e2e/stories/billing.m1.login.json", playwrightManifest)
    write(
      "e2e/specs/list.spec.ts",
      'import { test } from "@playwright/test"\ntest("adds @billing.m1.login @AC-1", async ({ page }) => { await page.goto("/") })\n'
    )
    const relative = await complete()
    expect(relative.ok).toBe(false)
    if (!relative.ok)
      expect(relative.message).toMatch(
        /"ac1-add" \(specs\/list\.spec\.ts\) navigates to a relative path/
      )

    write(
      "e2e/specs/list.spec.ts",
      'import { test } from "@playwright/test"\nconst url = process.env.BASE_URL ?? "http://127.0.0.1:3000"\ntest("adds @billing.m1.login @AC-1", async ({ page }) => { await page.goto(url) })\n'
    )
    const hardCoded = await complete()
    expect(!hardCoded.ok && hardCoded.message).toMatch(/uses 127\.0\.0\.1:3000/)
  })

  it("finishes when a fixture starts the app and provides baseURL, or a recipe does", async () => {
    write("e2e/stories/billing.m1.login.json", playwrightManifest)
    write(
      "e2e/fixtures/app.ts",
      'import { test as base } from "@playwright/test"\nexport const test = base.extend({ baseURL: async ({}, use) => use(await startApp()) })\n'
    )
    write(
      "e2e/specs/list.spec.ts",
      'import { test } from "../fixtures/app"\ntest("adds @billing.m1.login @AC-1", async ({ page }) => { await page.goto("/") })\n'
    )
    expect((await complete()).ok).toBe(true)

    write(
      "e2e/specs/list.spec.ts",
      'import { test } from "@playwright/test"\ntest("adds @billing.m1.login @AC-1", async ({ page }) => { await page.goto("/") })\n'
    )
    appLaunch = { services: [webService] }
    const withRecipe = JSON.parse(playwrightManifest)
    withRecipe.criteria["AC-1"][0].services = ["web"]
    write("e2e/stories/billing.m1.login.json", JSON.stringify(withRecipe))
    expect((await complete()).ok).toBe(true)
  })

  it("tells a check that never reached the app from one that failed", () => {
    const failed = {
      passed: false,
      outputTail:
        "Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3000/",
    }
    expect(unreachableReason(failed, { services: [] })).toMatch(
      /^Couldn't reach the app \(net::ERR_CONNECTION_REFUSED\).*no app launch recipe/
    )
    expect(
      unreachableReason(
        {
          passed: false,
          outputTail: "",
          playwright: {
            source: "bundled",
            version: "1",
            browser: "chrome",
            artifacts: [],
            tests: [
              {
                title: "t",
                file: "f",
                status: "failed",
                durationMs: 1,
                error:
                  "page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL",
              },
            ],
          },
        },
        { services: [webService] }
      )
    ).toMatch(/declares the services it needs/)
    expect(
      unreachableReason(
        { passed: false, outputTail: "Expected: visible\nReceived: hidden" },
        { services: [] }
      )
    ).toBeNull()
    expect(
      unreachableReason({ ...failed, passed: true }, { services: [] })
    ).toBeNull()

    const summary = summarizeCheckRun({
      ok: true,
      results: [
        {
          checkId: "ac1-add",
          criterionId: "AC-1",
          storyRef: "billing.m1.login",
          attempt: 1,
          ranAt: 0,
          passed: false,
          exitCode: 1,
          timedOut: false,
          durationMs: 900,
          outputTail: failed.outputTail,
          unreachable: unreachableReason(failed, { services: [] })!,
        },
      ],
      exploratory: [],
      problems: [],
    })
    expect(summary).toMatch(
      /0 passed, 0 failed, 0 flaky, 1 couldn't reach the app/
    )
    expect(summary).toMatch(/ac1-add .*: couldn't reach the app/)
  })
})

describe("starting Node scripts from checks (plan 110)", () => {
  it("tells QA to use process.execPath, with or without a recipe", () => {
    for (const services of [[], [webService]]) {
      const lines = appGuidance({ checksDir: "e2e", recipe: { services } })
      expect(lines.join("\n")).toMatch(
        /starts it with `process\.execPath`.*not `node`/
      )
    }
  })
})

describe("the no-recipe kickoff (plan 109.07)", () => {
  it("has QA start the app from a shared fixture instead of expecting a baseURL", () => {
    const note = authorStepNote(storyChecks(link)!)
    expect(note).toMatch(/no app launch recipe/)
    expect(note).toMatch(/e2e\/fixtures\//)
    expect(note).toMatch(/provides that URL as `baseURL`/)
    expect(note).toMatch(/node:http/)
    expect(note).toMatch(/couldn't reach the app" is not one of them/)
    expect(note).not.toMatch(/A Playwright check gets the first one/)
  })
})

describe("step kickoffs (plan 109.06)", () => {
  it("the checks step writes Playwright specs blind, with no browser", () => {
    appLaunch = { services: [webService] }
    const note = authorStepNote(storyChecks(link)!)
    expect(note).toMatch(/there's no browser in this step/)
    expect(note).toMatch(
      /write Playwright specs from the spec using role and text locators/
    )
    expect(note).toContain(
      `"runner": "playwright", "spec": "area/feature.spec.ts", "grep": "@AC-1", "services": ["web"]`
    )
    expect(note).toMatch(
      /don't add Playwright \(or anything else\) to the project/
    )
    expect(note).toMatch(/`getByRole`, `getByLabel`, and `getByText`/)
    expect(note).toMatch(/_electron\.launch/)
    expect(note).toMatch(
      /A Playwright check gets the first one as its `baseURL`/
    )
  })
})

describe("the merge smoke step (plan 110.05)", () => {
  it("starts the app, runs the project's tests, and spot-checks the story", () => {
    appLaunch = { services: [webService] }
    const note = smokeStepNote(storyChecks(smokeLink)!, ["src/app.ts"])
    expect(note).toMatch(/## Smoke-testing the merged result/)
    expect(note).toMatch(
      /\*\*The app starts\.\*\* Start it with `app_start`.*`web`/
    )
    expect(note).toMatch(/\*\*The project's own tests pass\.\*\*/)
    expect(note).toMatch(/conflicted files \(`src\/app\.ts`\) touch/)
    expect(note).toMatch(/accept the merge as is, fix it themselves, or drop/)
    expect(note).toMatch(/`app_exercised`/)
    expect(note).not.toMatch(/`qa_check`/)
    expect(note).not.toMatch(/run_checks`/)
  })

  it("without a recipe, has QA start the app itself", () => {
    const note = smokeStepNote(storyChecks(smokeLink)!)
    expect(note).toMatch(/no app launch recipe/)
    expect(note).not.toMatch(/app_start/)
  })

  it("refuses run_checks", async () => {
    run.missionControl = smokeLink
    write("e2e/stories/billing.m1.login.json", manifest({ ac1: "true" }))
    expect(
      await runQaChecks({
        processRunId: "r1",
        phaseRunId: "verify",
        workspace: root,
      })
    ).toMatchObject({ ok: false, code: "smoke_step" })
    expect(phaseRuns.get("verify")!.qaChecks).toBeNull()
  })
})

describe("the exploratory test step (plan 110.04)", () => {
  it("has QA verify in the running app with evidence, and run no checks", () => {
    appLaunch = { services: [webService] }
    const note = exploreStepNote(storyChecks(link)!)
    expect(note).toMatch(/## Verifying by exploration/)
    expect(note).toMatch(/no checks to write or run in this step/)
    expect(note).toMatch(/acceptance gate writes and runs the Playwright suite/)
    expect(note).toMatch(/Start the app with `app_start`.*`web`/)
    expect(note).toMatch(/`browser_screenshot`/)
    expect(note).toMatch(/Write nothing in the repository/)
    expect(note).toMatch(/`app_exercised`/)
    expect(note).not.toMatch(/`qa_check`/)
    expect(note).not.toMatch(/run_checks`/)
  })

  it("without a recipe, has QA start the app itself on a free port", () => {
    const note = exploreStepNote(storyChecks(link)!)
    expect(note).toMatch(/no app launch recipe/)
    expect(note).toMatch(/free port/)
    expect(note).not.toMatch(/app_start/)
  })

  it("refuses run_checks", async () => {
    run.missionControl = link
    write("e2e/stories/billing.m1.login.json", manifest({ ac1: "true" }))
    expect(
      await runQaChecks({
        processRunId: "r1",
        phaseRunId: "verify",
        workspace: root,
      })
    ).toMatchObject({ ok: false, code: "exploratory_step" })
    expect(phaseRuns.get("verify")!.qaChecks).toBeNull()
  })
})

describe("run_checks", () => {
  const runAll = (checkIds?: string[]) =>
    runQaChecks({
      processRunId: "r1",
      phaseRunId: "author",
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
    expect(phaseRuns.get("author")!.qaChecks!.results).toHaveLength(3)
    const summary = summarizeCheckRun(outcome)
    expect(summary).toMatch(/1 passed, 1 failed, 0 flaky/)
    expect(summary).toMatch(/broken/)
  })

  describe("without a test browser (plan 109.06)", () => {
    const playwrightRun = (browser: "missing" | "installed") => ({
      passed: browser === "installed",
      exitCode: browser === "installed" ? 0 : 1,
      timedOut: false,
      output: browser === "installed" ? "1 passed" : "Executable doesn't exist",
      tests: [],
      artifacts: [],
      notVerifiable:
        browser === "installed" ? null : "Browser not installed: …",
      runner: { source: "bundled", version: "1.63.0", browser },
    })
    beforeEach(() => {
      write("e2e/specs/ui.spec.ts", "// a browser test\n")
      write(
        "e2e/stories/billing.m1.login.json",
        JSON.stringify({
          criteria: {
            "AC-1": [
              {
                id: "ac1-ui",
                kind: "automated",
                runner: "playwright",
                spec: "specs/ui.spec.ts",
              },
            ],
            "AC-2": [{ id: "ac2", kind: "automated", command: "echo ok" }],
          },
        })
      )
    })

    it("waits for the browser, then runs only the checks that needed it again", async () => {
      let browser: "missing" | "installed" = "missing"
      const runs: string[] = []
      overrides.runPlaywrightCheck = async () => {
        runs.push(browser)
        return playwrightRun(browser)
      }
      overrides.waitForTestBrowser = async () => {
        browser = "installed"
        return true
      }
      const outcome = await runAll()
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(runs).toEqual(["missing", "installed"])
      // In manifest order, with only the second Playwright run recorded.
      expect(
        outcome.results.map((r) => [r.checkId, r.attempt, r.passed])
      ).toEqual([
        ["ac1-ui", 1, true],
        ["ac2", 1, true],
      ])
      expect(outcome.results[0].notVerifiable).toBeUndefined()
      expect(overrides.events).toEqual([
        expect.objectContaining({
          type: "test_browser_needed",
          refId: "author",
        }),
      ])
    })

    it("records the checks as not verifiable when stopped while waiting", async () => {
      overrides.runPlaywrightCheck = async () => playwrightRun("missing")
      overrides.waitForTestBrowser = async () => false
      const outcome = await runAll()
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(
        outcome.results.map((r) => [r.checkId, !!r.notVerifiable])
      ).toEqual([
        ["ac1-ui", true],
        ["ac2", false],
      ])
    })

    it("doesn't wait when the checks ran without a browser", async () => {
      overrides.runPlaywrightCheck = async () => playwrightRun("installed")
      overrides.waitForTestBrowser = async () => {
        throw new Error("should not wait")
      }
      const outcome = await runAll()
      expect(outcome.ok).toBe(true)
      expect(overrides.events).toEqual([])
    })
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
})

describe.skipIf(process.platform === "win32")("app services", () => {
  it("run_checks starts a check's services and gives it their URLs", async () => {
    appLaunch = { services: [webService] }
    const probe = `${NODE} -e "fetch(process.env.BASE_URL).then(r=>r.text()).then(t=>process.exit(t==='hello'&&process.env.APP_WEB_URL===process.env.BASE_URL?0:1))"`
    write(
      "e2e/stories/billing.m1.login.json",
      JSON.stringify({
        criteria: {
          "AC-1": [
            {
              id: "ac1",
              kind: "automated",
              command: probe,
              services: ["web"],
            },
          ],
          "AC-2": [
            {
              id: "ac2",
              kind: "automated",
              command: `${NODE} -e "process.exit(Number('{port:web}')>0?0:1)"`,
              services: ["web"],
            },
          ],
        },
      })
    )
    const outcome = await runQaChecks({
      processRunId: "r1",
      phaseRunId: "author",
      workspace: root,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results.map((r) => [r.checkId, r.passed])).toEqual([
      ["ac1", true],
      ["ac2", true],
    ])
    // One instance, reused by both checks, owned by the step.
    expect(testAppServices.size).toBe(1)
  })

  it("runs a Playwright check against the started app and records its tests", async () => {
    appLaunch = { services: [webService] }
    const evidence = await mkdtemp(join(tmpdir(), "qa-evidence-"))
    setEvidenceRoot(evidence)
    try {
      write(
        "e2e/auth/home.spec.ts",
        `import { test, expect } from "@playwright/test"
test("serves the page @billing.m1.login @AC-1", async ({ request }) => {
  expect(await (await request.get("/")).text()).toBe("hello")
})
test("shows the copy @billing.m1.login @AC-2", async ({ request }) => {
  expect(await (await request.get("/")).text()).toBe("Welcome")
})
test("another story @billing.m1.logout", async () => { expect(1).toBe(2) })
`
      )
      const check = (id: string, grep: string) => ({
        id,
        kind: "automated",
        runner: "playwright",
        spec: "auth/home.spec.ts",
        grep,
        services: ["web"],
        timeoutMs: 60_000,
      })
      write(
        "e2e/stories/billing.m1.login.json",
        JSON.stringify({
          criteria: {
            "AC-1": [check("ac1-home", "@AC-1")],
            "AC-2": [check("ac2-copy", "@AC-2")],
          },
        })
      )
      const outcome = await runQaChecks({
        processRunId: "r1",
        phaseRunId: "author",
        workspace: root,
      })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(
        outcome.results.map((r) => [r.checkId, r.attempt, r.passed])
      ).toEqual([
        ["ac1-home", 1, true],
        ["ac2-copy", 1, false],
        ["ac2-copy", 2, false],
      ])
      const [pass, fail] = outcome.results
      expect(pass.playwright).toMatchObject({
        source: "bundled",
        tests: [
          {
            title: "serves the page @billing.m1.login @AC-1",
            status: "passed",
          },
        ],
      })
      expect(fail.playwright!.tests).toEqual([
        expect.objectContaining({
          status: "failed",
          error: expect.stringMatching(/Welcome/),
        }),
      ])
      // Failure traces land in the step's evidence directory.
      expect(fail.playwright!.artifacts.length).toBeGreaterThan(0)
      for (const artifact of fail.playwright!.artifacts)
        expect(
          artifact.startsWith(
            join(evidence, "author", "playwright", "ac2-copy-1")
          )
        ).toBe(true)
      expect(phaseRuns.get("author")!.qaChecks!.results).toHaveLength(3)
      const summary = summarizeCheckRun(outcome)
      expect(summary).toMatch(/1 passed, 1 failed/)
      expect(summary).toMatch(
        /✗ shows the copy @billing.m1.login @AC-2 \(failed\)/
      )
    } finally {
      setEvidenceRoot(null)
      await rm(evidence, { recursive: true, force: true })
    }
  }, 60_000)

  it("fails a check whose services won't start, with their output", async () => {
    appLaunch = {
      services: [
        {
          ...webService,
          command: `${NODE} -e "console.error('no db'); process.exit(2)"`,
        },
      ],
    }
    write(
      "e2e/stories/billing.m1.login.json",
      manifest({ ac1: "true" }).replace(
        '"timeoutMs":1500',
        '"timeoutMs":1500,"services":["web"]'
      )
    )
    const outcome = await runQaChecks({
      processRunId: "r1",
      phaseRunId: "author",
      workspace: root,
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0]).toMatchObject({ checkId: "ac1", passed: false })
    expect(outcome.results[0].outputTail).toMatch(/didn't start[\s\S]*no db/)
  })

  it("refuses a manifest naming a service the recipe doesn't have", async () => {
    appLaunch = { services: [webService] }
    write(
      "e2e/stories/billing.m1.login.json",
      manifest({ ac1: "true" }).replace(
        '"timeoutMs":1500',
        '"timeoutMs":1500,"services":["api"]'
      )
    )
    const outcome = await runQaChecks({
      processRunId: "r1",
      phaseRunId: "author",
      workspace: root,
    })
    expect(outcome).toMatchObject({ ok: false, code: "no_manifest" })
    if (!outcome.ok)
      expect(outcome.message).toMatch(/aren't in the app launch recipe: api/)
  })

  it("app tools start, report, and stop the step's services", async () => {
    appLaunch = { services: [webService] }
    const ctx = {
      workspace: root,
      processRunId: "r1",
      processPhaseRunId: "verify",
    } as ToolContext
    const started = await appStartTool.execute({}, ctx)
    const port = Number(/"port": (\d+)/.exec(started)![1])
    expect(started).toMatch(/"status": "ready"/)
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(
      "hello"
    )
    expect(await appStatusTool.execute({ logs: "web" }, ctx)).toMatch(
      new RegExp(`web \\(Web\\): ready at http://localhost:${port}`)
    )
    expect(await appStopTool.execute({}, ctx)).toBe("Stopped 1 service.")
    expect(testAppServices.size).toBe(0)
  })

  it("app tools are refused to other roles and outside a run", async () => {
    appLaunch = { services: [webService] }
    run.seatBindings!.seats["qa@pod"].role = "reviewer"
    const refused = await appStartTool.execute({}, {
      workspace: root,
      processRunId: "r1",
      processPhaseRunId: "verify",
    } as ToolContext)
    expect(refused).toMatch(/only available to a builder or QA seat/)
    expect(
      await appStatusTool.execute({}, { workspace: root } as ToolContext)
    ).toMatch(/only available/)
    expect(testAppServices.size).toBe(0)
  })
})
