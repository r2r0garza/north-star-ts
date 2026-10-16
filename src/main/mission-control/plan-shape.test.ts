import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

// Plan rules the plan-edit engine applies (plan 112.5): the runnable
// skeleton for a greenfield workspace, and explained edges between new
// stories whose touch hints overlap.

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import * as rigs from "../db/repositories/rigs"
import * as features from "../db/repositories/features"
import { saveRecipeState } from "../db/repositories/app-recipe-states"
import { upsertWorkspace } from "../db/repositories/workspaces"
import { applyPlanChanges } from "./plan-edits"
import { SKELETON_KEY } from "./plan-shape"
import type { UserStoryDraft } from "../../shared/mission-control/plan-changes"

const dirs: string[] = []

function fixture(files: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mc-shape-"))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files))
    writeFileSync(path.join(dir, name), text)
  const rig = rigs.createRig({ name: "Team" })
  const pod = rigs.createPod({ rigId: rig.id, key: "impl", name: "Impl" })
  rigs.createSeat({
    podId: pod.id,
    key: "builder",
    role: "builder",
    agentRefId: "agentref:v1:builder",
    agentLabel: "Builder",
  })
  const workspace = upsertWorkspace(dir)
  const graph = features.createFeature({
    key: "list",
    name: "List",
    intent: "A list app.",
    definitionOfDone: "",
    rigId: rig.id,
    workspaceId: workspace.id,
  })
  const milestone = graph.milestones[0]
  const add = (stories: UserStoryDraft[]) =>
    applyPlanChanges({
      featureId: graph.feature.id,
      milestoneId: milestone.id,
      changes: stories.map((userStory) => ({
        op: "add_user_story",
        userStory,
      })),
      actor: "user",
      reason: "plan",
      origin: "user",
    })
  const stories = () => features.listUserStories(milestone.id)
  const keyOf = (id: string) => stories().find((s) => s.id === id)?.key
  const edges = () =>
    features
      .listEdges(milestone.id)
      .map((e) => `${keyOf(e.fromUserStoryId)}→${keyOf(e.toUserStoryId)}`)
      .sort()
  return { workspace, milestone, add, stories, edges }
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
})

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!sqliteLoads)("the runnable skeleton", () => {
  it("puts a skeleton first in a greenfield milestone, and every story waits for it", () => {
    const f = fixture({ "README.md": "# List\n" })
    f.add([{ title: "Add items" }, { title: "Delete items" }])
    const [first] = f.stories()
    expect(first.key).toBe(SKELETON_KEY)
    expect(first.spec.acceptance[0]).toMatch(/recipe verifies/)
    expect(f.edges()).toEqual([
      `${SKELETON_KEY}→add-items`,
      `${SKELETON_KEY}→delete-items`,
    ])
    // A later plan edit adds no second skeleton, and the new story waits too.
    f.add([{ title: "Rename items" }])
    expect(f.stories().filter((s) => s.key === SKELETON_KEY)).toHaveLength(1)
    expect(f.edges()).toContain(`${SKELETON_KEY}→rename-items`)
  })

  it("keeps a skeleton the planner wrote, adding only the edges", () => {
    const f = fixture()
    f.add([
      { key: SKELETON_KEY, title: "Runnable skeleton" },
      { key: "crud", title: "CRUD", dependsOn: [SKELETON_KEY] },
      { key: "style", title: "Style" },
    ])
    expect(f.stories().map((s) => s.key)).toEqual([
      SKELETON_KEY,
      "crud",
      "style",
    ])
    expect(f.edges()).toEqual([`${SKELETON_KEY}→crud`, `${SKELETON_KEY}→style`])
  })

  it("adds none once a project exists or the recipe verified", () => {
    const code = fixture({ "package.json": "{}" })
    code.add([{ title: "Add items" }])
    expect(code.stories().map((s) => s.key)).toEqual(["add-items"])
    const verified = fixture()
    saveRecipeState({
      workspaceId: verified.workspace.id,
      branch: "main",
      state: "verified",
      commit: "abc",
      failure: null,
      repairAttempts: 0,
      question: null,
    } as never)
    verified.add([{ title: "Add items" }])
    expect(verified.stories().map((s) => s.key)).toEqual(["add-items"])
  })
})

describe.skipIf(!sqliteLoads)("overlapping stories", () => {
  it("serializes new stories whose touch hints overlap, earlier first, with a reason", () => {
    const f = fixture({ "package.json": "{}" })
    // Revisions are recorded once the feature runs.
    features.startFeature(f.milestone.featureId)
    f.add([
      { key: "toggle", title: "Toggle", touchHints: ["src/ui/"] },
      { key: "rename", title: "Rename", touchHints: ["src/ui/list.tsx"] },
      { key: "api", title: "API", touchHints: ["src/api/"] },
    ])
    expect(f.edges()).toEqual(["toggle→rename"])
    const revision = features
      .getFeatureGraph(f.milestone.featureId)!
      .revisions.find((r) => r.reason?.startsWith("Automatic:"))
    expect(revision?.reason).toContain("rename after toggle")
  })

  it("adds no edge when a path already orders them, and none for old pairs", () => {
    const f = fixture({ "package.json": "{}" })
    f.add([
      { key: "a", title: "A", touchHints: ["src/"] },
      { key: "b", title: "B", touchHints: ["src/x.ts"], dependsOn: ["a"] },
    ])
    expect(f.edges()).toEqual(["a→b"])
    // The user removes it; an unrelated plan edit doesn't put it back.
    features.setUserStoryEdges(f.milestone.id, [])
    f.add([{ key: "c", title: "C", touchHints: ["docs/"] }])
    expect(f.edges()).toEqual([])
  })
})
