import { tmpdir } from "os"
import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

// Fix stories and the fix-round cap (plan 110.03): a gate's app bugs become
// fix stories (proposed in Manual), a criterion past the cap goes to the
// user, and each of the three decisions does what it says.

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import * as rigs from "../db/repositories/rigs"
import * as features from "../db/repositories/features"
import * as playbooks from "../db/repositories/playbooks"
import * as proposalsRepo from "../db/repositories/proposals"
import * as waveGates from "../db/repositories/wave-gates"
import { upsertWorkspace } from "../db/repositories/workspaces"
import type {
  DriveMode,
  GateCriterionResult,
  UserStory,
  WaveGateReport,
} from "../db/types"
import { ensureDefaultPlaybook } from "./playbook-defaults"
import { concludeWaveGate } from "./wave-gate"
import {
  gateWaivers,
  openEscalations,
  pendingFixProposal,
  resolveGateEscalation,
} from "./gate-fixes"
import { applyProposal } from "./map-tools"

function fixture(mode: DriveMode = "copilot", budgets = {}) {
  const rig = rigs.createRig({ name: "Team" })
  const pod = rigs.createPod({
    rigId: rig.id,
    key: "impl",
    name: "Implementation",
  })
  rigs.createSeat({
    podId: pod.id,
    key: "builder",
    role: "builder",
    agentRefId: "agentref:v1:builder",
    agentLabel: "Builder",
  })
  const graph = features.createFeature({
    key: "list",
    name: "List",
    intent: "A quick list.",
    definitionOfDone: "",
    rigId: rig.id,
    workspaceId: upsertWorkspace(tmpdir()).id,
  })
  const milestone = graph.milestones[0]
  for (const key of ["items", "layout"])
    features.createUserStory({
      milestoneId: milestone.id,
      key,
      title: key,
      spec: {
        goal: key,
        acceptance: [`${key} shows`, `${key} toggles`],
        touchHints: [`src/${key}.js`],
      },
    })
  features.setDriveMode(graph.feature.id, mode)
  features.startFeature(graph.feature.id)
  if (Object.keys(budgets).length)
    features.setFeatureBudgets(graph.feature.id, budgets)
  const story = (key: string) =>
    features.listUserStories(milestone.id).find((s) => s.key === key)!
  const merge = (key: string) =>
    features.setUserStoryExecution(story(key).id, { status: "merged" }, "test")
  return {
    feature: features.getFeature(graph.feature.id)!,
    milestone,
    story,
    merge,
  }
}

const passed = (id: string): GateCriterionResult => ({
  id,
  outcome: "passed",
  evidence: "green",
  checks: [{ checkId: id.toLowerCase(), status: "passed", attempts: 1 }],
})
const bug = (
  id: string,
  problem = "The toggle does nothing."
): GateCriterionResult => ({
  id,
  outcome: "app_bug",
  evidence: "clicked it twice",
  problem,
  checks: [
    { checkId: `chk-${id.toLowerCase()}`, status: "failed", attempts: 2 },
  ],
})

// Open a gate over the merged stories, record `stories`, and conclude it.
function gate(
  ctx: ReturnType<typeof fixture>,
  stories: Array<{
    story: UserStory
    batch?: boolean
    criteria: GateCriterionResult[]
  }>
) {
  const playbook = ensureDefaultPlaybook("milestone")
  const run = playbooks.createPlaybookRun({
    playbookId: playbook.id,
    hook: "after_each_wave",
    featureId: ctx.feature.id,
    milestoneId: ctx.milestone.id,
  })
  const merged = features
    .listUserStories(ctx.milestone.id)
    .filter((s) => s.status === "merged")
  const opened = waveGates.createWaveGate({
    milestoneId: ctx.milestone.id,
    storyIds: merged.map((s) => s.id),
    playbookRunId: run.id,
  })
  const report: WaveGateReport = {
    version: 1,
    stories: stories.map((s) => ({
      userStoryId: s.story.id,
      key: s.story.key,
      storyRef: `list.milestone-1.${s.story.key}`,
      batch: s.batch ?? true,
      criteria: s.criteria,
    })),
    checkChanges: [],
    suite: { checks: 4, passed: 2 },
    warnings: [],
    recordedBy: "impl.qa@rig",
    recordedAt: 1,
    processRunId: "p1",
  }
  waveGates.setRunningWaveGateReport(opened.id, report)
  return concludeWaveGate(run.id, { commit: "abc" })!
}

function fixStories(milestoneId: string) {
  return features
    .listUserStories(milestoneId)
    .filter((s) => s.origin === "gate")
}

// Merge the fix stories (they built and merged) for the next gate.
function mergeFixes(milestoneId: string) {
  for (const fix of fixStories(milestoneId))
    if (fix.status !== "merged" && fix.status !== "done")
      features.setUserStoryExecution(fix.id, { status: "merged" }, "test")
}

describe.skipIf(!sqliteLoads)(
  "acceptance gate fix stories (plan 110.03)",
  () => {
    beforeEach(() => {
      db = new Database(":memory:")
      db.pragma("foreign_keys = ON")
      runMigrations(db)
    })

    it("turns each app bug into a fix story in Copilot and Autopilot", () => {
      const ctx = fixture("autopilot")
      ctx.merge("items")
      ctx.merge("layout")
      const finished = gate(ctx, [
        { story: ctx.story("items"), criteria: [passed("AC-1"), bug("AC-2")] },
        {
          story: ctx.story("layout"),
          criteria: [passed("AC-1"), passed("AC-2")],
        },
      ])
      expect(finished.status).toBe("fixing")
      expect(ctx.story("layout").status).toBe("done")
      expect(ctx.story("items").status).toBe("merged")
      const [fix] = fixStories(ctx.milestone.id)
      expect(fix).toMatchObject({
        key: "fix-items-ac2",
        title: "Fix items AC-2: The toggle does nothing.",
        origin: "gate",
        gateId: finished.id,
        status: "draft",
        fixes: {
          userStoryId: ctx.story("items").id,
          criterionId: "AC-2",
          criterion: "items toggles",
        },
      })
      expect(fix.spec.acceptance).toEqual([
        "items toggles",
        "The acceptance gate's check `chk-ac-2` for items AC-2 passes on the integrated app.",
      ])
      expect(fix.spec.touchHints).toEqual(["src/items.js"])
      // No dependencies: everything before it merged.
      expect(features.listEdges(ctx.milestone.id)).toEqual([])
      const report = finished.report as WaveGateReport
      expect(report.fixes).toEqual([
        expect.objectContaining({
          fixRound: 1,
          fixStoryId: fix.id,
          fixStoryKey: "fix-items-ac2",
        }),
      ])
      expect(report.stories[0].criteria[1]).toMatchObject({
        text: "items toggles",
      })
      // The original's history says what happened.
      expect(
        features
          .listRevisions(ctx.feature.id)
          .some(
            (r) =>
              r.reason ===
              "AC-2 failed at acceptance gate round 1; fixed by fix-items-ac2"
          )
      ).toBe(true)
    })

    it("proposes the fix stories in Manual, and applying keeps the link", () => {
      const ctx = fixture("manual")
      ctx.merge("items")
      const finished = gate(ctx, [
        {
          story: ctx.story("items"),
          criteria: [bug("AC-1"), bug("AC-2", "Nothing flips.")],
        },
      ])
      expect(finished.status).toBe("fixing")
      expect(fixStories(ctx.milestone.id)).toEqual([])
      const proposalId = pendingFixProposal(finished)!
      const proposal = proposalsRepo.getProposal(proposalId)!
      expect(proposal).toMatchObject({
        kind: "user_story",
        proposer: "acceptance-gate",
      })
      expect(proposal.changes).toHaveLength(2)
      applyProposal(proposalId)
      const fixes = fixStories(ctx.milestone.id)
      expect(fixes.map((f) => [f.key, f.gateId, f.fixes?.criterionId])).toEqual(
        [
          ["fix-items-ac1", finished.id, "AC-1"],
          ["fix-items-ac2", finished.id, "AC-2"],
        ]
      )
      expect(pendingFixProposal(waveGates.getWaveGate(finished.id)!)).toBeNull()
    })

    it("counts a bug on a fix story against the original criterion, once", () => {
      const ctx = fixture("copilot")
      ctx.merge("items")
      gate(ctx, [
        { story: ctx.story("items"), criteria: [passed("AC-1"), bug("AC-2")] },
      ])
      mergeFixes(ctx.milestone.id)
      const [fix] = fixStories(ctx.milestone.id)
      const second = gate(ctx, [
        { story: ctx.story("items"), criteria: [passed("AC-1"), bug("AC-2")] },
        { story: fix, criteria: [bug("AC-1"), passed("AC-2")] },
      ])
      const report = second.report as WaveGateReport
      // One fix for the one root, in its second round.
      expect(report.fixes).toHaveLength(1)
      expect(report.fixes![0]).toMatchObject({
        fixRound: 2,
        root: { key: "items", criterionId: "AC-2" },
      })
      expect(fixStories(ctx.milestone.id).map((s) => s.key)).toEqual([
        "fix-items-ac2",
        "fix-items-ac2-2",
      ])
    })

    it("escalates instead of a third fix story once the cap is reached", () => {
      const ctx = fixture("autopilot")
      ctx.merge("items")
      for (let round = 0; round < 2; round++) {
        gate(ctx, [
          {
            story: ctx.story("items"),
            criteria: [passed("AC-1"), bug("AC-2")],
          },
        ])
        mergeFixes(ctx.milestone.id)
      }
      expect(fixStories(ctx.milestone.id)).toHaveLength(2)
      const third = gate(ctx, [
        {
          story: ctx.story("items"),
          criteria: [passed("AC-1"), bug("AC-2", "Still stuck.")],
        },
      ])
      expect(third.status).toBe("escalated")
      expect(fixStories(ctx.milestone.id)).toHaveLength(2)
      expect(openEscalations(third)).toEqual([
        expect.objectContaining({
          rounds: 2,
          problem: "Still stuck.",
          root: expect.objectContaining({ key: "items", criterionId: "AC-2" }),
        }),
      ])
    })

    it("honors a lower cap from the budgets", () => {
      const ctx = fixture("autopilot", { maxGateFixRounds: 0 })
      ctx.merge("items")
      const first = gate(ctx, [
        { story: ctx.story("items"), criteria: [bug("AC-1"), passed("AC-2")] },
      ])
      expect(first.status).toBe("escalated")
      expect(fixStories(ctx.milestone.id)).toEqual([])
    })

    it("leaves a setup problem to the user before any fix story", () => {
      const ctx = fixture("autopilot")
      ctx.merge("items")
      const finished = gate(ctx, [
        {
          story: ctx.story("items"),
          criteria: [
            bug("AC-1"),
            {
              id: "AC-2",
              outcome: "unreachable",
              evidence: "ERR_CONNECTION_REFUSED",
              reason: "The app didn't start.",
              checks: [],
            },
          ],
        },
      ])
      expect(finished.status).toBe("failed")
      expect(fixStories(ctx.milestone.id)).toEqual([])
      expect(playbooks.getPlaybookRun(finished.playbookRunId!)!.status).toBe(
        "failed"
      )
    })

    describe("the user's decision", () => {
      function escalated(ctx: ReturnType<typeof fixture>) {
        ctx.merge("items")
        return gate(ctx, [
          {
            story: ctx.story("items"),
            criteria: [passed("AC-1"), bug("AC-2")],
          },
        ])
      }

      it("Accept as is waives the criterion and finishes the story", () => {
        const ctx = fixture("autopilot", { maxGateFixRounds: 0 })
        const g = escalated(ctx)
        const [escalation] = openEscalations(g)
        const outcome = resolveGateEscalation({
          gateId: g.id,
          escalationId: escalation.id,
          action: "accept",
          note: "Good enough for now.",
        })
        expect(outcome.pause).toBeNull()
        expect(outcome.gate.status).toBe("passed")
        expect(ctx.story("items").status).toBe("done")
        expect(gateWaivers(ctx.feature.id)).toEqual([
          expect.objectContaining({
            criterion: "items toggles",
            note: "Good enough for now.",
          }),
        ])
        // Twice is refused.
        expect(() =>
          resolveGateEscalation({
            gateId: g.id,
            escalationId: escalation.id,
            action: "drop",
          })
        ).toThrow(/isn't waiting on a decision/)
      })

      it("a waived criterion counts as passed at the next gate", () => {
        const ctx = fixture("autopilot", { maxGateFixRounds: 0 })
        const g = escalated(ctx)
        resolveGateEscalation({
          gateId: g.id,
          escalationId: openEscalations(g)[0].id,
          action: "accept",
        })
        ctx.merge("layout")
        // items regressed on its waived criterion only: still a pass.
        const next = gate(ctx, [
          {
            story: ctx.story("layout"),
            criteria: [passed("AC-1"), passed("AC-2")],
          },
          { story: ctx.story("items"), batch: false, criteria: [bug("AC-2")] },
        ])
        expect(next.status).toBe("passed")
        expect(
          (next.report as WaveGateReport).stories[1].criteria[0]
        ).toMatchObject({
          waived: true,
        })
        expect(fixStories(ctx.milestone.id)).toEqual([])
      })

      it("I'll fix it asks to pause and re-runs the gate", () => {
        const ctx = fixture("autopilot", { maxGateFixRounds: 0 })
        const g = escalated(ctx)
        const outcome = resolveGateEscalation({
          gateId: g.id,
          escalationId: openEscalations(g)[0].id,
          action: "user_fix",
        })
        expect(outcome.pause).toMatch(/You're fixing items AC-2 yourself/)
        expect(outcome.gate.status).toBe("fixing")
        expect(ctx.story("items").status).toBe("merged")
      })

      it("Drop the criterion edits the story and re-runs the gate", () => {
        const ctx = fixture("autopilot", { maxGateFixRounds: 0 })
        const g = escalated(ctx)
        const outcome = resolveGateEscalation({
          gateId: g.id,
          escalationId: openEscalations(g)[0].id,
          action: "drop",
          note: "Out of scope.",
        })
        expect(outcome.gate.status).toBe("fixing")
        expect(ctx.story("items").spec.acceptance).toEqual(["items shows"])
        expect(ctx.story("items").status).toBe("merged")
        expect(
          features
            .listRevisions(ctx.feature.id)
            .some((r) =>
              r.reason?.startsWith(
                "Dropped items AC-2 at acceptance gate round 1"
              )
            )
        ).toBe(true)
      })

      it("accepting settles the fix stories that were chasing the criterion", () => {
        const ctx = fixture("autopilot", { maxGateFixRounds: 1 })
        ctx.merge("items")
        gate(ctx, [
          {
            story: ctx.story("items"),
            criteria: [passed("AC-1"), bug("AC-2")],
          },
        ])
        mergeFixes(ctx.milestone.id)
        const [fix] = fixStories(ctx.milestone.id)
        const second = gate(ctx, [
          {
            story: ctx.story("items"),
            criteria: [passed("AC-1"), bug("AC-2")],
          },
          {
            story: features.getUserStory(fix.id)!,
            criteria: [bug("AC-1"), passed("AC-2")],
          },
        ])
        expect(second.status).toBe("escalated")
        resolveGateEscalation({
          gateId: second.id,
          escalationId: openEscalations(second)[0].id,
          action: "accept",
        })
        expect(features.getUserStory(fix.id)!.status).toBe("done")
        expect(ctx.story("items").status).toBe("done")
        expect(waveGates.getWaveGate(second.id)!.status).toBe("passed")
      })
    })
  }
)
