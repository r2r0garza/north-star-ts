import { tmpdir } from "os"
import Database from "better-sqlite3"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

// Follow-up proposals (plan 106.7): an out-of-scope idea is recorded and
// anchored without touching the current scope, and applying it lands it in a
// later milestone unless the user explicitly picks the one in flight.

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import * as rigs from "../db/repositories/rigs"
import * as features from "../db/repositories/features"
import * as proposalsRepo from "../db/repositories/proposals"
import { upsertWorkspace } from "../db/repositories/workspaces"
import {
  applyFollowup,
  defaultFollowupTarget,
  proposeFollowup,
  renderFollowupsForReview,
} from "./followups"
import { proposeFollowupTool } from "../agent/tools/propose_followup"
import type { SeatTurnIdentity } from "./seat-turns"

function fixture() {
  const rig = rigs.createRig({ name: "Team" })
  const pod = rigs.createPod({
    rigId: rig.id,
    key: "implementation",
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
    key: "doghouse",
    name: "Doghouse",
    intent: "The dog has shelter.",
    definitionOfDone: "",
    rigId: rig.id,
    workspaceId: upsertWorkspace(tmpdir()).id,
  })
  const m1 = graph.milestones[0]
  features.updateMilestone(
    m1.id,
    { name: "Walls", outcome: "Walls stand." },
    "user",
    "setup"
  )
  const withStory = features.createUserStory({
    milestoneId: m1.id,
    key: "walls",
    title: "Build the walls",
    spec: { goal: "Four walls.", acceptance: ["Walls stand"] },
  })
  const withNext = features.createMilestone({
    featureId: graph.feature.id,
    key: "m2",
    name: "Roof",
    outcome: "A roof.",
  })
  features.startFeature(graph.feature.id)
  const userStory = withStory.userStories.find((s) => s.key === "walls")!
  const turn: SeatTurnIdentity = {
    featureId: graph.feature.id,
    address: "builder@implementation",
    profile: "work",
    anchor: { kind: "user_story", id: userStory.id },
    wakeHop: null,
  }
  return {
    featureId: graph.feature.id,
    m1: features.getMilestone(m1.id)!,
    m2: withNext.milestones.find((m) => m.key === "m2")!,
    userStory,
    turn,
  }
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("follow-up proposals", () => {
  it("records an out-of-scope idea anchored to the user story, leaving the plan alone", async () => {
    const { featureId, m1, userStory, turn } = fixture()
    const before = features.getFeatureGraph(featureId)!
    const output = await proposeFollowupTool.execute(
      {
        title: "Add a light to the doghouse",
        rationale: "The dog would like to read at night.",
        suggested_altitude: "user_story",
      },
      { missionControlSeat: turn } as never
    )
    const parsed = JSON.parse(output as string)
    expect(parsed.status).toBe("recorded")
    expect(parsed.message).toMatch(/Continue with your current work/)

    const proposal = proposalsRepo.getProposal(parsed.followup_id)!
    expect(proposal).toMatchObject({
      kind: "followup",
      milestoneId: m1.id,
      proposer: "builder@implementation",
      changes: [],
      followup: {
        title: "Add a light to the doghouse",
        altitude: "user_story",
        anchor: { kind: "user_story", id: userStory.id, key: "walls" },
      },
    })
    const after = features.getFeatureGraph(featureId)!
    expect(after.userStories.map((s) => s.key)).toEqual(
      before.userStories.map((s) => s.key)
    )
    expect(features.getUserStory(userStory.id)!.spec).toEqual(userStory.spec)

    // The same idea twice is one follow-up.
    const again = proposeFollowup(turn, {
      title: "Add a light to the doghouse",
      rationale: "Still dark.",
    })
    expect(again.ok && again.proposal.id).toBe(proposal.id)
    expect(renderFollowupsForReview(featureId, m1.id)).toContain(
      '"Add a light to the doghouse"'
    )
  })

  it("lands in a later milestone by default, and in the one in flight only when chosen", () => {
    const { featureId, m1, m2, turn } = fixture()
    const result = proposeFollowup(turn, {
      title: "Add a light",
      rationale: "Night reading.",
    })
    if (!result.ok) throw new Error(result.message)
    expect(defaultFollowupTarget(result.proposal)).toEqual({
      kind: "user_story",
      milestone: "m2",
    })

    expect(() =>
      applyFollowup(result.proposal.id, {
        kind: "user_story",
        milestone: m1.key,
      })
    ).toThrow(/in flight/)
    expect(proposalsRepo.getProposal(result.proposal.id)!.status).toBe(
      "pending"
    )

    const applied = applyFollowup(result.proposal.id, null)
    expect(applied.status).toBe("applied")
    expect(applied.changes[0]).toMatchObject({
      op: "add_user_story",
      milestone: "m2",
    })
    const graph = features.getFeatureGraph(featureId)!
    expect(
      graph.userStories
        .filter((s) => s.milestoneId === m2.id)
        .map((s) => s.title)
    ).toEqual(["Add a light"])
    expect(
      graph.userStories.filter((s) => s.milestoneId === m1.id)
    ).toHaveLength(1)

    const second = proposeFollowup(turn, {
      title: "Paint it red",
      rationale: "Looks.",
    })
    if (!second.ok) throw new Error(second.message)
    applyFollowup(
      second.proposal.id,
      { kind: "user_story", milestone: m1.key },
      { allowCurrent: true }
    )
    expect(
      features
        .getFeatureGraph(featureId)!
        .userStories.filter((s) => s.milestoneId === m1.id)
    ).toHaveLength(2)
  })

  it("refuses without a seat turn", async () => {
    const output = await proposeFollowupTool.execute(
      { title: "x", rationale: "y" },
      {} as never
    )
    expect(String(output)).toMatch(/only available to Mission Control seats/)
  })
})
