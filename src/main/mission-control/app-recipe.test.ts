import Database from "better-sqlite3"
import { execFileSync } from "child_process"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import * as features from "../db/repositories/features"
import * as recipeStates from "../db/repositories/app-recipe-states"
import { listEvents } from "../db/repositories/mc-events"
import { updateWorkspace, upsertWorkspace } from "../db/repositories/workspaces"
import type { AppLaunch } from "../../shared/mission-control/app-launch"
import type { AppRecipeQuestion } from "../../shared/mission-control/app-recipe"
import type { UserStoryProof } from "../db/types"
import { testAppServices } from "./app-launch"
import {
  AppRecipeService,
  type RepairTurnInput,
  type VerifyTarget,
} from "./app-recipe"
import { UserStoryRunner } from "./user-story-runner"

// Plan 112.3, parts 3–6: recipe state, the bounded repair loop with a fake
// repair seat, plain-language escalation, the user's choices applied without
// a command, and the unverified outcome. Real processes run the scenario 3
// fixture (a server that needs a migrated data file and DATA_FILE).

const NODE = JSON.stringify(process.execPath)
const FIXTURE = path.join(
  __dirname,
  "scenarios",
  "03-app-needing-setup",
  "project"
)

// Scenario 3 without its database: setup migrates, DATA_FILE comes from
// .env.local, and the server's database check is satisfied by db.js.
function recipe(env: Record<string, string>): AppLaunch {
  return {
    services: [
      {
        key: "db",
        label: "Database",
        command: `${NODE} db.js`,
        cwd: "",
        port: "auto",
        ready: { log: "db ready" },
        source: "detector",
      },
      {
        key: "web",
        label: "Web",
        command: `${NODE} server.js`,
        cwd: "",
        port: "auto",
        ready: { http: "/" },
        readyTimeoutMs: 5000,
        env: { DB_PORT: "{port:db}", ...env },
        source: "detector",
      },
    ],
    setup: [
      {
        label: "Migrate",
        command: `${NODE} migrate.js`,
        cwd: "",
        service: "web",
      },
    ],
  }
}
const BROKEN = recipe({ DATA_FILE: "{env:DATA_FILE}" })
const FIXED = recipe({ DATA_FILE: "data/app.json" })

let dirs: string[] = []
let root = ""
let featureId = ""
let workspaceId = ""

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: root, stdio: "pipe" })
    .toString()
    .trim()
}

function setupWorkspace() {
  root = mkdtempSync(path.join(tmpdir(), "app-recipe-"))
  dirs.push(root)
  cpSync(FIXTURE, root, { recursive: true })
  // The key lives only where the user has to add it.
  rmSync(path.join(root, ".env.local"))
  writeFileSync(path.join(root, ".gitignore"), "data/\n.env.local\n")
  git("init", "-q", "-b", "main")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  git("add", ".")
  git("commit", "-q", "-m", "init")
  const workspace = upsertWorkspace(root)
  workspaceId = workspace.id
  const graph = features.createFeature({
    key: "items",
    name: "Items",
    intent: "Count items.",
    definitionOfDone: "Shown.",
    workspaceId,
  })
  featureId = graph.feature.id
  return graph
}

const target = (): VerifyTarget => ({
  featureId,
  workspaceId,
  root,
  mainRoot: root,
})

function service(repair: (input: RepairTurnInput, attempt: number) => void) {
  const repairs: RepairTurnInput[] = []
  const escalated: string[] = []
  const acknowledged: string[] = []
  const skipped: AppRecipeQuestion[] = []
  const instance = new AppRecipeService({
    repairTurn: async (input) => {
      repairs.push(input)
      repair(input, repairs.length)
    },
    escalate: (input) => {
      escalated.push(input.body)
      return `msg-${escalated.length}`
    },
    acknowledge: (id) => acknowledged.push(id),
    onSkipped: (question) => skipped.push(question),
  })
  return { instance, repairs, escalated, acknowledged, skipped }
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  dirs = []
})

afterEach(async () => {
  await testAppServices.clear()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!sqliteLoads || process.platform === "win32")(
  "recipe state, repair, and escalation",
  () => {
    it("moves through unverified → verified(commit) → re-verified on a new commit", async () => {
      setupWorkspace()
      const { instance } = service(() => {})
      expect(instance.state(workspaceId, "main").state).toBe("absent")
      updateWorkspace(workspaceId, { appLaunch: FIXED })
      expect(instance.state(workspaceId, "main").state).toBe("unverified")

      const first = await instance.verify(target())
      expect(first).toMatchObject({ ok: true, cached: false })
      const head = git("rev-parse", "HEAD")
      expect(first.state).toMatchObject({ state: "verified", commit: head })
      // Same commit: nothing runs again.
      expect(await instance.verify(target())).toMatchObject({
        ok: true,
        cached: true,
      })

      writeFileSync(path.join(root, "README.md"), "x\n")
      git("add", ".")
      git("commit", "-q", "-m", "readme")
      const again = await instance.verify(target())
      expect(again).toMatchObject({ ok: true, cached: false })
      expect(again.state.commit).toBe(git("rev-parse", "HEAD"))

      // Any recipe write makes every branch unverified.
      updateWorkspace(workspaceId, { appLaunch: BROKEN })
      expect(instance.state(workspaceId, "main")).toMatchObject({
        state: "unverified",
        commit: null,
      })
    }, 60_000)

    it("repairs the recipe on attempt 2 without touching the story's budget", async () => {
      const graph = setupWorkspace()
      const story = features.addUserStory({
        milestoneId: graph.milestones[0].id,
        key: "item-count",
        title: "Item count",
        spec: { goal: "Count.", acceptance: ["Shows 0 items"] },
      })
      updateWorkspace(workspaceId, { appLaunch: BROKEN })
      const { instance, repairs, escalated } = service((input, attempt) => {
        // The fake builder fixes the recipe on its second try.
        if (attempt === 2) updateWorkspace(workspaceId, { appLaunch: FIXED })
        expect(input.objective).toMatch(/Recipe repair/)
        expect(input.objective).toMatch(/DATA_FILE/)
      })
      const outcome = await instance.ensureRunnable({
        target: target(),
        userStoryId: story.id,
      })
      expect(outcome).toMatchObject({ ok: true, repairs: 2 })
      expect(repairs).toHaveLength(2)
      expect(escalated).toEqual([])
      const state = instance.state(workspaceId, "main")
      expect(state).toMatchObject({ state: "verified", repairAttempts: 2 })
      expect(listEvents(featureId, { types: ["recipe_repair"] })).toHaveLength(
        2
      )
      // Zero story attempts and no proof revisions burned.
      const after = features.getUserStory(story.id)!
      expect(after.attempts).toBe(0)
      expect(after.proof).toBeNull()
      expect(testAppServices.size).toBe(0)
    }, 60_000)

    it("asks in plain language after 3 attempts, and applies the user's choice", async () => {
      setupWorkspace()
      updateWorkspace(workspaceId, { appLaunch: BROKEN })
      const { instance, repairs, escalated, acknowledged } = service(() => {})
      const outcome = await instance.ensureRunnable({ target: target() })
      expect(outcome.ok).toBe(false)
      expect(repairs).toHaveLength(3)
      if (outcome.ok) return
      expect(outcome.failure).toMatchObject({
        class: "environment",
        reason: "missing_env",
        missingEnv: ["DATA_FILE"],
      })
      const question = outcome.question!
      expect(question.question).toBe(
        "The app needs a value for DATA_FILE, which isn't in the project's .env.local or .env. Add it there, then check again."
      )
      expect(question.choices.map((c) => c.label)).toEqual([
        "I added it, check again",
        "Skip running the app for now",
      ])
      expect(question.messageId).toBe("msg-1")
      expect(escalated[0]).toMatch(/^The app needs a value for DATA_FILE/)
      // No command anywhere in what the user is asked.
      expect(escalated[0]).not.toMatch(/node |npm |`/)
      expect(recipeStates.listRecipeQuestions(featureId)).toHaveLength(1)

      // The user adds the key and picks "check again": the harness checks
      // again; nobody typed a command.
      writeFileSync(path.join(root, ".env.local"), "DATA_FILE=data/app.json\n")
      const answered = await instance.answer(question.id, "retry")
      expect(answered).toMatchObject({ ok: true, repairs: 0 })
      expect(acknowledged).toContain("msg-1")
      expect(recipeStates.listRecipeQuestions(featureId)).toEqual([])
      expect(instance.state(workspaceId, "main").state).toBe("verified")
      await expect(instance.answer(question.id, "retry")).rejects.toThrow(
        /already answered/
      )
    }, 60_000)

    it("says whether an answer fixed the problem when it asks the next question", async () => {
      setupWorkspace()
      writeFileSync(path.join(root, ".env.local"), "DATA_FILE=data/app.json\n")
      const closed = 9
      updateWorkspace(workspaceId, {
        appLaunch: {
          ...BROKEN,
          services: BROKEN.services.map((s) => ({ ...s, source: "user" })),
          prerequisites: [
            {
              key: "postgres",
              label: "A Postgres database on port 9",
              check: { tcp: closed },
              hint: "",
            },
          ],
        },
      })
      const { instance } = service(() => {})
      const first = await instance.ensureRunnable({ target: target() })
      if (first.ok) throw new Error("expected a question")
      // Nothing changed: the same problem.
      const same = await instance.answer(first.question!.id, "self")
      if ("skipped" in same || same.ok) throw new Error("expected a question")
      expect(same.question?.question).toMatch(
        /^That didn't fix it\. The app needs a Postgres database on port 9/
      )
      // The database is "started" (the prerequisite dropped), and the next
      // problem is a different one.
      rmSync(path.join(root, ".env.local"))
      updateWorkspace(workspaceId, {
        appLaunch: {
          ...BROKEN,
          services: BROKEN.services.map((s) => ({ ...s, source: "user" })),
        },
      })
      const next = await instance.answer(same.question!.id, "self")
      if ("skipped" in next || next.ok) throw new Error("expected a question")
      expect(next.question?.question).toBe(
        "That's fixed. Now: The app needs a value for DATA_FILE, which isn't in the project's .env.local or .env. Add it there, then check again."
      )
    }, 60_000)

    it("waits for the milestone to land before checking the checkout", async () => {
      const graph = setupWorkspace()
      updateWorkspace(workspaceId, { appLaunch: BROKEN })
      // The milestone's integration branch has work the checkout doesn't.
      git("checkout", "-q", "-b", "mc/items/integration")
      writeFileSync(path.join(root, "feature.txt"), "x\n")
      git("add", ".")
      git("commit", "-q", "-m", "story")
      git("checkout", "-q", "main")
      db.prepare(
        "UPDATE milestones SET integration_branch = ? WHERE id = ?"
      ).run("mc/items/integration", graph.milestones[0].id)
      const { instance, repairs } = service(() => {})
      expect(await instance.checkFeature(featureId)).toEqual({
        notInCheckout: "mc/items/integration",
      })
      expect(repairs).toEqual([])
      expect(instance.state(workspaceId, "main").state).toBe("unverified")
      expect((await instance.checkoutState(featureId))?.notInCheckout).toBe(
        "mc/items/integration"
      )
      // Landed: the checkout has it, so it's checked (and repaired).
      git("merge", "-q", "--ff-only", "mc/items/integration")
      const landed = await instance.checkFeature(featureId)
      expect("notInCheckout" in landed).toBe(false)
      expect(repairs.length).toBe(3)
      expect(
        (await instance.checkoutState(featureId))?.notInCheckout
      ).toBeNull()
    }, 60_000)

    it("app check before QA: passes, repairs, waits for the answer, or ends unverified", async () => {
      const graph = setupWorkspace()
      const story = features.addUserStory({
        milestoneId: graph.milestones[0].id,
        key: "item-count",
        title: "Item count",
        spec: { goal: "Count.", acceptance: ["Shows 0 items"] },
      })
      const check = (
        instance: AppRecipeService,
        signal = new AbortController().signal
      ) =>
        instance.appCheck({
          featureId,
          userStoryId: story.id,
          root,
          signal,
        })

      // No recipe: QA proves by commands.
      expect(await check(service(() => {}).instance)).toMatchObject({
        result: "pass",
        report: expect.stringMatching(/no services/),
      })

      // Broken, repaired on the first attempt: QA starts.
      updateWorkspace(workspaceId, { appLaunch: BROKEN })
      const repairing = service(() =>
        updateWorkspace(workspaceId, { appLaunch: FIXED })
      )
      const repaired = await check(repairing.instance)
      expect(repaired).toMatchObject({ result: "pass" })
      // Its receipt: each verification's stages, and the repair.
      expect(repaired.report).toMatch(/Failed at .*missing_env/)
      expect(repaired.report).toMatch(/Stages: .*start/)
      expect(repaired.report).toMatch(/Recipe repair: 1 attempt\./)
      expect(repairing.repairs).toHaveLength(1)
      // Recorded for the scorecard, with the class of what was repaired.
      expect(
        listEvents(featureId, { types: ["app_check"] }).at(-1)?.detail
      ).toMatchObject({
        result: "pass",
        repairs: 1,
        class: "environment",
        reason: "missing_env",
        source: "detector",
      })

      // Unfixable: it waits for the user's answer, then goes on.
      updateWorkspace(workspaceId, { appLaunch: BROKEN })
      const asking = service(() => {})
      const waiting = check(asking.instance)
      let question: AppRecipeQuestion | undefined
      for (let i = 0; i < 200 && !question; i++) {
        await new Promise((r) => setTimeout(r, 25))
        question = recipeStates.listRecipeQuestions(featureId)[0]
      }
      expect(question?.userStoryId).toBe(story.id)
      writeFileSync(path.join(root, ".env.local"), "DATA_FILE=data/app.json\n")
      await asking.instance.answer(question!.id, "retry")
      expect(await waiting).toMatchObject({ result: "pass" })

      // The user skips: unverified, with why.
      rmSync(path.join(root, ".env.local"))
      updateWorkspace(workspaceId, { appLaunch: BROKEN })
      const skipping = service(() => {})
      const skipped = check(skipping.instance)
      let next: AppRecipeQuestion | undefined
      for (let i = 0; i < 200 && !next; i++) {
        await new Promise((r) => setTimeout(r, 25))
        next = recipeStates.listRecipeQuestions(featureId)[0]
      }
      await skipping.instance.answer(next!.id, "skip")
      expect(await skipped).toMatchObject({
        result: "unverified",
        summary: expect.stringMatching(/DATA_FILE/),
      })
      // The waiting check ends the story itself, not onSkipped.
      expect(skipping.skipped).toEqual([])

      // Cancelled while waiting: stopped.
      updateWorkspace(workspaceId, { appLaunch: BROKEN })
      const abort = new AbortController()
      const stopping = check(service(() => {}).instance, abort.signal)
      for (
        let i = 0;
        i < 200 && !recipeStates.listRecipeQuestions(featureId).length;
        i++
      )
        await new Promise((r) => setTimeout(r, 25))
      abort.abort()
      expect(await stopping).toMatchObject({ result: "stopped" })
      // No story attempt was spent on any of it.
      expect(features.getUserStory(story.id)!.attempts).toBe(0)
    }, 120_000)

    it("offers Docker for a database prerequisite and carries the agreement into repair", async () => {
      setupWorkspace()
      updateWorkspace(workspaceId, {
        appLaunch: {
          ...FIXED,
          prerequisites: [
            {
              key: "postgres",
              label: "A Postgres database on port 9",
              check: { tcp: 9 },
              hint: "Start Postgres.",
            },
          ],
        },
      })
      const { instance, repairs } = service(() => {})
      const outcome = await instance.ensureRunnable({
        target: target(),
        attempts: 1,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.question?.question).toBe(
        "The app needs a Postgres database on port 9, and it isn't running. Start one with Docker?"
      )
      expect(outcome.question?.choices.map((c) => c.label)).toEqual([
        "Start one with Docker",
        "I'll start it myself",
        "Skip running the app for now",
      ])
      await instance.answer(outcome.question!.id, "docker")
      // A fresh bounded loop, told what the user agreed to.
      expect(repairs.length).toBe(1 + 3)
      expect(repairs[1].objective).toMatch(
        /The user agreed to run a Postgres database on port 9 with Docker/
      )
    }, 60_000)

    it("doesn't spend attempts when repair can't run or can't change the recipe", async () => {
      setupWorkspace()
      updateWorkspace(workspaceId, { appLaunch: BROKEN })
      // No builder seat to run the turn: no attempt counted, straight to
      // the question.
      const failing = new AppRecipeService({
        repairTurn: async () => {
          throw new Error("The feature has no rig to repair the recipe with.")
        },
        // Comms can't carry it either (a draft feature): the question is
        // kept anyway, answerable on the analysis item.
        escalate: () => {
          throw new Error("no rig")
        },
      })
      const first = await failing.ensureRunnable({ target: target() })
      expect(first).toMatchObject({ ok: false, repairs: 0 })
      expect(failing.state(workspaceId, "main").repairAttempts).toBe(0)
      expect(first.ok || first.question).toBeTruthy()
      expect(recipeStates.listRecipeQuestions(featureId)).toHaveLength(1)

      // A recipe the user wrote: repair can't replace it, so it isn't tried
      // and no choice that needs it is offered.
      updateWorkspace(workspaceId, {
        appLaunch: {
          ...FIXED,
          services: FIXED.services.map((s) => ({ ...s, source: "user" })),
          prerequisites: [
            {
              key: "postgres",
              label: "A Postgres database on port 9",
              check: { tcp: 9 },
              hint: "Start Postgres.",
            },
          ],
        },
      })
      const { instance, repairs } = service(() => {})
      const outcome = await instance.ensureRunnable({ target: target() })
      expect(repairs).toEqual([])
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.question?.question).toBe(
        "The app needs a Postgres database on port 9, and it isn't running."
      )
      expect(outcome.question?.choices.map((c) => c.id)).toEqual([
        "self",
        "skip",
      ])
    }, 60_000)

    it("ends a waiting story unverified when the user skips, and accepts it only with a note", async () => {
      const graph = setupWorkspace()
      const story = features.addUserStory({
        milestoneId: graph.milestones[0].id,
        key: "item-count",
        title: "Item count",
        spec: {
          goal: "Count.",
          acceptance: ["Shows 0 items", "Shows 1 items after one is added"],
        },
      })
      features.setUserStoryExecution(
        story.id,
        { status: "running", attempts: 1 },
        "started"
      )
      updateWorkspace(workspaceId, { appLaunch: BROKEN })
      const runner = new UserStoryRunner({
        startProcessRun: async () => {
          throw new Error("not in this test")
        },
        cancelTask: () => {},
        loadAgents: async () => [],
      })
      const { instance, skipped } = service(() => {})
      const outcome = await instance.ensureRunnable({
        target: target(),
        userStoryId: story.id,
        attempts: 1,
      })
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      await instance.answer(outcome.question!.id, "skip")
      expect(skipped).toHaveLength(1)
      expect(skipped[0].userStoryId).toBe(story.id)
      runner.markUnverified(story.id, outcome.failure!.summary)

      const unverified = features.getUserStory(story.id)!
      expect(unverified.status).toBe("unverified")
      expect(unverified.attempts).toBe(1)
      const proof = unverified.proof as UserStoryProof
      expect(proof.verdict).toBe("unverified")
      expect(proof.verifiedBy).toEqual({ kind: "harness" })
      expect(proof.criteria.map((c) => [c.id, c.status])).toEqual([
        ["AC-1", "not_verifiable"],
        ["AC-2", "not_verifiable"],
      ])
      expect(proof.criteria[0].reason).toMatch(/^the app couldn't be run: /)

      // Accepting it needs a note, and keeps the proof honest.
      await expect(runner.acceptUnverified(story.id, " ")).rejects.toThrow(
        /Say why/
      )
      await runner.acceptUnverified(story.id, "Checked by hand.")
      const accepted = features.getUserStory(story.id)!
      expect(accepted.status).toBe("done")
      expect((accepted.proof as UserStoryProof).verdict).toBe("unverified")
      expect((accepted.proof as UserStoryProof).acceptedUnverified?.note).toBe(
        "Checked by hand."
      )
    }, 60_000)
  }
)
