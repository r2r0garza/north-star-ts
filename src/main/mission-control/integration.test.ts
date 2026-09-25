import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import Database from "better-sqlite3"
import { execFileSync } from "child_process"
import { randomUUID } from "crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

// Mission integration end to end (plan 106.5): real SQLite, real temporary git
// repositories, and a fake agent loop whose builders write files into the
// workspace the Process engine hands them (a slice worktree).

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))
vi.mock("../conversations/lifecycle", () => ({
  cleanupConversationArtifacts: async () => {},
}))
const { SHUTDOWN_ABORT_REASON, PAUSE_ABORT_REASON } = vi.hoisted(() => ({
  SHUTDOWN_ABORT_REASON: Symbol("agent:shutdown"),
  PAUSE_ABORT_REASON: Symbol("task:pause"),
}))
vi.mock("../agent/abort", () => ({ SHUTDOWN_ABORT_REASON, PAUSE_ABORT_REASON }))

interface LoopCall {
  workspace: string
  userMessage: string
  agentName: string | null
}
const loopCalls: LoopCall[] = []
// What each slice's build step writes, by slice key: file → content.
const builds = new Map<string, Record<string, string>>()
// What the integrator writes into the conflicted files.
let resolution: Record<string, string> | null = null

vi.mock("../agent", () => ({
  SHUTDOWN_ABORT_REASON,
  generateTitle: async () => "Title",
  runAgentLoop: async (input: {
    conversationId: string
    workspace: string
    userMessage?: string
    processProofStep?: boolean
    processRunId?: string
    processPhaseRunId?: string
  }) => {
    const msg = input.userMessage ?? ""
    loopCalls.push({
      workspace: input.workspace,
      userMessage: msg,
      agentName: db
        .prepare("SELECT agent_name FROM conversations WHERE id = ?")
        .pluck()
        .get(input.conversationId) as string | null,
    })
    let content = "done"
    if (msg.startsWith("# Review the")) content = '{"approved": true}'
    else if (msg.includes("Build the slice")) {
      const key = /# Slice ([a-z0-9-]+):/.exec(msg)?.[1] ?? ""
      for (const [file, text] of Object.entries(builds.get(key) ?? {}))
        writeFileSync(path.join(input.workspace, file), text)
    } else if (msg.includes("Resolve the merge conflict") && resolution) {
      for (const [file, text] of Object.entries(resolution))
        writeFileSync(path.join(input.workspace, file), text)
    }
    if (input.processProofStep) {
      recordSliceProof({
        processRunId: input.processRunId!,
        processPhaseRunId: input.processPhaseRunId!,
        args: {
          verdict: "accepted",
          criteria: [{ id: "AC-1", status: "met", evidence: "Checked the file." }],
        },
      })
      content = "verified"
    }
    const seq =
      (db
        .prepare("SELECT MAX(seq) FROM messages WHERE conversation_id = ?")
        .pluck()
        .get(input.conversationId) as number | null) ?? 0
    db.prepare(
      "INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)"
    ).run(randomUUID(), input.conversationId, seq + 1, content, Date.now())
    return { content }
  },
}))
vi.mock("../agent/providers", () => {
  class NoActiveProviderError extends Error {}
  return {
    resolveLlm: () => ({ client: {}, model: "m", apiMode: "completions" }),
    createCompletion: async () => ({ choices: [{ message: { content: "" } }] }),
    NoActiveProviderError,
  }
})

const AGENTS = ["builder", "qa", "lead"].map((name) => ({
  name,
  refId: `agentref:v1:${name}`,
  label: `Agent ${name}`,
  description: `${name} agent`,
  tools: ["read", "edit", "execute"],
  body: `You are ${name}.`,
}))
vi.mock("../agent/agents/loader", () => ({
  loadAgent: async (name: string) =>
    AGENTS.find((a) => a.refId === name || a.name === name) ?? null,
}))

import * as processes from "../db/repositories/processes"
import * as rigs from "../db/repositories/rigs"
import * as initiatives from "../db/repositories/initiatives"
import * as mergeQueue from "../db/repositories/merge-queue"
import * as playbooks from "../db/repositories/playbooks"
import { listWorkspaces, upsertWorkspace } from "../db/repositories/workspaces"
import { ProcessService } from "../tasks/process/service"
import { SliceRunner, recordSliceProof } from "./slice-runner"
import { startConflictResolution } from "./hook-runner"
import { MissionIntegration } from "./integration"
import { createDefaultPlaybook } from "./playbook-defaults"
import type { AgentDefinition } from "../agent/agents/types"
import { listWorktrees } from "../agent/subagents/worktrees"

const fakeRunner = {
  enqueueKind: () => {
    const conversationId = randomUUID()
    const taskId = randomUUID()
    const now = Date.now()
    db.prepare(
      "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
    ).run(conversationId, now, now)
    db.prepare(
      "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, NULL, 'queued', NULL, NULL, NULL, ?, ?)"
    ).run(taskId, conversationId, conversationId, now, now)
    return { id: taskId }
  },
} as never

const dirs: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mc-int-"))
  dirs.push(root)
  git(root, "init", "-b", "main")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  writeFileSync(path.join(root, "README.md"), "base\n")
  writeFileSync(path.join(root, "shared.txt"), "one\ntwo\nthree\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "base")
  return root
}

let service: ProcessService
let runner: SliceRunner
let integration: MissionIntegration
let worktreeRoot: string
const notices: string[] = []

function setup(options: { resolve?: boolean } = {}) {
  worktreeRoot = mkdtempSync(path.join(tmpdir(), "mc-worktrees-"))
  dirs.push(worktreeRoot)
  service = new ProcessService(fakeRunner)
  integration = new MissionIntegration({
    worktreeRoot: () => worktreeRoot,
    startResolution:
      options.resolve === false
        ? undefined
        : (input) => startConflictResolution(runner, input),
    notifyUser: (title, body) => notices.push(`${title}: ${body}`),
    leaseRetryMs: 10,
  })
  runner = new SliceRunner({
    startProcessRun: (input) => service.startRun(input),
    cancelTask: () => {},
    loadAgents: async () => AGENTS as unknown as AgentDefinition[],
    integration,
  })
  service.onRunSettled((id) => runner.settle(id))
}

function rig() {
  const created = rigs.createRig({ name: "Team" })
  const lead = rigs.createPod({ rigId: created.id, key: "orchestration", name: "Orchestration" })
  const pod = rigs.createPod({ rigId: created.id, key: "implementation", name: "Implementation" })
  rigs.createSeat({ podId: lead.id, key: "lead", role: "lead", agentRefId: "agentref:v1:lead", agentLabel: "lead" })
  rigs.createSeat({ podId: pod.id, key: "builder", role: "builder", agentRefId: "agentref:v1:builder", agentLabel: "builder" })
  rigs.createSeat({ podId: pod.id, key: "qa", role: "qa", agentRefId: "agentref:v1:qa", agentLabel: "qa" })
  rigs.setOversight(created.id, [{ overseerPodId: lead.id, overseenPodId: pod.id }])
  return created
}

function initiativeIn(workspace: string, keys: string[]) {
  const graph = initiatives.createInitiative({
    key: "billing",
    name: "Billing",
    intent: "Invoices.",
    definitionOfDone: "Done.",
    rigId: rig().id,
    workspaceId: upsertWorkspace(workspace).id,
  })
  const mission = graph.missions[0]
  for (const key of keys)
    initiatives.createSlice({
      missionId: mission.id,
      key,
      title: key,
      spec: { goal: key, acceptance: ["The file exists"] },
    })
  initiatives.startInitiative(graph.initiative.id)
  const slices = initiatives.listSlices(mission.id)
  return {
    initiative: initiatives.getInitiative(graph.initiative.id)!,
    mission,
    slice: (key: string) => slices.find((s) => s.key === key)!,
  }
}

async function drive(processRunId: string) {
  const run = processes.getProcessRun(processRunId)!
  await service.execute({
    task: { id: run.taskId!, input: { processRunId } } as never,
    signal: new AbortController().signal,
    emit: () => {},
    workspace: undefined,
  } as never)
}

// Drive every Mission Control run that is still running (resolution hooks
// appear only after a conflict), then wait for the merge queue.
async function settleAll() {
  for (let round = 0; round < 5; round++) {
    await integration.idle()
    const running = playbooks
      .listPlaybookRuns({ status: "running" })
      .filter((r) => r.processRunId)
    if (!running.length) break
    for (const run of running) await drive(run.processRunId!)
  }
  await integration.idle()
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  loopCalls.length = 0
  builds.clear()
  resolution = null
  notices.length = 0
})

afterEach(() => {
  integration?.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!sqliteLoads)("mission integration", () => {
  it("runs independent slices in parallel worktrees, merges them in order, and starts the dependent slice on both", async () => {
    setup()
    const root = repo()
    const userHead = git(root, "rev-parse", "HEAD")
    const { mission, slice } = initiativeIn(root, ["invoice-api", "invoice-pdf", "invoice-ui"])
    initiatives.setSliceEdges(mission.id, [
      { fromSliceId: slice("invoice-api").id, toSliceId: slice("invoice-ui").id },
      { fromSliceId: slice("invoice-pdf").id, toSliceId: slice("invoice-ui").id },
    ])
    builds.set("invoice-api", { "api.txt": "api\n" })
    builds.set("invoice-pdf", { "pdf.txt": "pdf\n" })
    builds.set("invoice-ui", { "ui.txt": "ui\n" })

    // Both start before either runs: two isolated runs at once.
    const api = await runner.startSlice(slice("invoice-api").id)
    const pdf = await runner.startSlice(slice("invoice-pdf").id)
    expect(api.worktreePath).not.toBe(pdf.worktreePath)
    const started = initiatives.getMission(mission.id)!
    expect(started).toMatchObject({
      integrationBranch: "mc/billing/mission-1/integration",
      baseRef: "main",
      baseOid: userHead,
    })
    // The dependent slice waits for merges, not just proofs.
    await expect(runner.startSlice(slice("invoice-ui").id)).rejects.toThrow(/unmerged slices/)
    // Worktrees stay out of the user's workspace lists.
    expect(listWorkspaces().map((w) => w.path)).toEqual([root])

    // Drive the second one first: merge order is dependency level, then the
    // time each proof was accepted.
    await drive(pdf.processRunId!)
    await drive(api.processRunId!)
    await integration.idle()
    // Every worker of each slice ran in that slice's own worktree.
    const workspaces = new Set(loopCalls.map((c) => c.workspace))
    expect([...workspaces].sort()).toEqual([api.worktreePath, pdf.worktreePath].sort())
    expect(initiatives.getSlice(slice("invoice-api").id)!.status).toBe("done")
    expect(initiatives.getSlice(slice("invoice-pdf").id)!.status).toBe("done")
    const subjects = git(root, "log", "--first-parent", "--format=%s", started.integrationBranch!)
      .split("\n")
      .slice(0, 2)
    expect(subjects).toEqual(["slice invoice-api: invoice-api", "slice invoice-pdf: invoice-pdf"])
    // Merged worktrees are removed.
    expect(existsSync(api.worktreePath!)).toBe(false)
    expect(existsSync(pdf.worktreePath!)).toBe(false)

    const ui = await runner.startSlice(slice("invoice-ui").id)
    const uiSlice = initiatives.getSlice(slice("invoice-ui").id)!
    expect(existsSync(path.join(ui.worktreePath!, "api.txt"))).toBe(true)
    expect(existsSync(path.join(ui.worktreePath!, "pdf.txt"))).toBe(true)
    expect(uiSlice.baseOid).toBe(git(root, "rev-parse", started.integrationBranch!))
    await drive(ui.processRunId!)
    await integration.idle()
    expect(initiatives.getMission(mission.id)!.status).toBe("review")

    // The merge commit carries the proof and the trailers.
    const body = git(root, "log", "-1", "--format=%B", started.integrationBranch!)
    expect(body).toContain(`Mission-Control-Slice: ${uiSlice.id}`)
    expect(body).toContain(`Mission-Control-Proof: ${ui.id}`)
    expect(body).toContain("AC-1 met")

    // The user's checkout and base branch were never touched.
    expect(git(root, "rev-parse", "main")).toBe(userHead)
    expect(git(root, "status", "--porcelain")).toBe("")
    expect(git(root, "branch", "--show-current")).toBe("main")
  })

  it("hands a conflict to the integrator (falling back to the lead), re-verifies, and merges", async () => {
    setup()
    const root = repo()
    const { mission, slice } = initiativeIn(root, ["a", "b"])
    builds.set("a", { "shared.txt": "one\nTWO from a\nthree\n" })
    builds.set("b", { "shared.txt": "one\nTWO from b\nthree\n" })
    resolution = { "shared.txt": "one\nTWO from a and b\nthree\n" }
    const a = await runner.startSlice(slice("a").id)
    const b = await runner.startSlice(slice("b").id)
    await drive(a.processRunId!)
    await drive(b.processRunId!)
    await integration.idle()

    const entry = mergeQueue.listMergeEntries({ sliceId: slice("b").id })[0]
    expect(entry).toMatchObject({ status: "resolving", conflictFiles: ["shared.txt"] })
    expect(initiatives.getSlice(slice("b").id)!.status).toBe("integrating")
    const resolutionRun = playbooks.getPlaybookRun(entry.resolutionRunId!)!
    expect(resolutionRun).toMatchObject({ hook: "after_each_slice", sliceId: slice("b").id })

    await settleAll()
    const integrator = loopCalls.find((c) => c.userMessage.includes("Resolve the merge conflict"))!
    // No integrator seat in this rig: the lead stands in.
    expect(integrator.agentName).toBe("agentref:v1:lead")
    expect(integrator.userMessage).toContain("shared.txt")
    expect(mergeQueue.getMergeEntry(entry.id)!.status).toBe("merged")
    expect(initiatives.getSlice(slice("b").id)!.status).toBe("done")
    const integrationBranch = initiatives.getMission(mission.id)!.integrationBranch!
    expect(git(root, "show", `${integrationBranch}:shared.txt`)).toContain("a and b")
    expect(git(root, "log", "-1", "--format=%B", integrationBranch)).toContain(
      "Mission-Control-Resolved-By:"
    )
    expect(git(root, "status", "--porcelain")).toBe("")
    expect((await listWorktrees(root)).length).toBe(1)
  })

  it("escalates a conflict with no way to resolve it and leaves the repository clean", async () => {
    setup({ resolve: false })
    const root = repo()
    const { mission, slice } = initiativeIn(root, ["a", "b"])
    builds.set("a", { "shared.txt": "a\n" })
    builds.set("b", { "shared.txt": "b\n" })
    const a = await runner.startSlice(slice("a").id)
    const b = await runner.startSlice(slice("b").id)
    await drive(a.processRunId!)
    await drive(b.processRunId!)
    await integration.idle()

    const entry = mergeQueue.listMergeEntries({ sliceId: slice("b").id })[0]
    expect(entry).toMatchObject({ status: "conflict", escalated: true })
    expect(notices.join("\n")).toMatch(/slice b needs you/)
    expect(git(root, "status", "--porcelain")).toBe("")
    expect(initiatives.getMission(mission.id)!.status).toBe("integrating")

    // Abandoning fails the slice (its branch kept) and reopens the mission.
    await integration.abandon(entry.id)
    const failed = initiatives.getSlice(slice("b").id)!
    expect(failed.status).toBe("failed")
    expect(git(root, "branch", "--list", failed.branch!)).toContain(failed.branch!)
    expect(initiatives.getMission(mission.id)!.status).toBe("active")
    // A retry starts from the integration head, which now has slice a.
    builds.set("b", { "b.txt": "b\n" })
    const retry = await runner.startSlice(slice("b").id)
    expect(readFileSync(path.join(retry.worktreePath!, "shared.txt"), "utf8")).toBe("a\n")
  })

  it("escalates when the mission playbook has no after-each-slice hook", async () => {
    setup()
    const root = repo()
    const { mission, slice } = initiativeIn(root, ["a", "b"])
    const playbook = createDefaultPlaybook("mission")
    playbooks.removeHook(playbook.id, "after_each_slice")
    initiatives.updateMission(mission.id, { playbookId: playbook.id })
    builds.set("a", { "shared.txt": "a\n" })
    builds.set("b", { "shared.txt": "b\n" })
    const a = await runner.startSlice(slice("a").id)
    const b = await runner.startSlice(slice("b").id)
    await drive(a.processRunId!)
    await drive(b.processRunId!)
    await integration.idle()
    const entry = mergeQueue.listMergeEntries({ sliceId: slice("b").id })[0]
    expect(entry).toMatchObject({ status: "conflict", escalated: true })
    expect(entry.note).toMatch(/no after each slice hook/)
    expect((await listWorktrees(root)).length).toBe(2)
  })

  it("finishes the bookkeeping for a merge interrupted after the branch moved", async () => {
    setup()
    const root = repo()
    const { mission, slice } = initiativeIn(root, ["a", "b"])
    builds.set("a", { "a.txt": "a\n" })
    builds.set("b", { "b.txt": "b\n" })
    const a = await runner.startSlice(slice("a").id)
    const b = await runner.startSlice(slice("b").id)
    // Settle both runs without letting the queue drain yet.
    integration.stop()
    await drive(a.processRunId!)
    await drive(b.processRunId!)
    const entryA = mergeQueue.listMergeEntries({ sliceId: slice("a").id })[0]
    const entryB = mergeQueue.listMergeEntries({ sliceId: slice("b").id })[0]
    expect([entryA.status, entryB.status]).toEqual(["queued", "queued"])

    // Simulate a crash mid-merge for a: its merge landed on the integration
    // branch, but the row still says merging. b crashed before merging.
    const mc = initiatives.getMission(mission.id)!
    const sliceA = initiatives.getSlice(slice("a").id)!
    git(sliceA.worktreePath!, "add", "-A")
    git(sliceA.worktreePath!, "commit", "-m", "a work")
    const headA = git(root, "rev-parse", sliceA.branch!)
    const scratch = path.join(worktreeRoot, "crash-merge")
    git(root, "worktree", "add", "--detach", scratch, mc.integrationBranch!)
    git(scratch, "merge", "--no-ff", "-m", `slice a\n\nMission-Control-Slice: ${sliceA.id}`, headA)
    git(root, "update-ref", `refs/heads/${mc.integrationBranch}`, git(scratch, "rev-parse", "HEAD"))
    mergeQueue.updateMergeEntry(entryA.id, { status: "merging", sliceHead: headA })
    mergeQueue.updateMergeEntry(entryB.id, { status: "merging", sliceHead: null })

    // Restart: a fresh service sweeps the stray worktree and resumes.
    setupRestart()
    await integration.reconcile()
    await integration.idle()
    expect(existsSync(scratch)).toBe(false)
    expect(mergeQueue.getMergeEntry(entryA.id)).toMatchObject({
      status: "merged",
      mergeCommit: git(root, "log", "-1", "--format=%H", "--grep", sliceA.id, mc.integrationBranch!),
    })
    expect(mergeQueue.getMergeEntry(entryB.id)!.status).toBe("merged")
    expect(initiatives.getMission(mission.id)!.status).toBe("review")
    // Each slice merged exactly once.
    expect(
      git(root, "log", "--merges", "--format=%s", mc.integrationBranch!).split("\n")
    ).toHaveLength(2)
  })

  it("lands a local-merge mission only with an approval for what the user reviewed", async () => {
    setup()
    const root = repo()
    const { mission, slice } = initiativeIn(root, ["a"])
    initiatives.setMissionMergePolicy(mission.id, "local_merge")
    builds.set("a", { "a.txt": "a\n" })
    const a = await runner.startSlice(slice("a").id)
    // Locked once started, except back to manual.
    expect(() => initiatives.setMissionMergePolicy(mission.id, "open_pr")).toThrow(/locked/)
    await drive(a.processRunId!)
    await integration.idle()

    const status = await integration.status(mission.id)
    expect(status).toMatchObject({
      policy: "local_merge",
      workspace: { mode: "git" },
      summary: { fastForward: true, merged: false },
    })
    expect(status.queue.map((e) => e.status)).toEqual(["merged"])
    expect(git(root, "rev-parse", "main")).toBe(status.baseOid)
    await expect(
      integration.land(mission.id, { baseOid: status.summary!.baseOid!, headOid: "stale" })
    ).rejects.toThrow(/moved since you reviewed/)
    const landing = await integration.land(mission.id, {
      baseOid: status.summary!.baseOid!,
      headOid: status.summary!.headOid!,
    })
    expect(landing).toMatchObject({ mode: "local_merge", fastForward: true, completedBy: "user" })
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n")
    const done = initiatives.getMission(mission.id)!
    expect(done.status).toBe("completed")
    // Slice and integration branches are cleaned up once reachable from main.
    expect(git(root, "branch", "--list", "mc/*")).toBe("")
  })

  it("reaches review when the last unfinished slice is deleted", async () => {
    setup()
    const root = repo()
    const { mission, slice } = initiativeIn(root, ["a", "b"])
    builds.set("a", { "a.txt": "a\n" })
    const a = await runner.startSlice(slice("a").id)
    await drive(a.processRunId!)
    await integration.idle()
    expect(initiatives.getMission(mission.id)!.status).toBe("active")
    initiatives.deleteSlice(slice("b").id)
    // Nothing merged since; the status read catches up, and stays quiet after.
    const changes: string[] = []
    const quiet = new MissionIntegration({
      worktreeRoot: () => worktreeRoot,
      onChanged: (id) => changes.push(id),
    })
    await quiet.status(mission.id)
    expect(initiatives.getMission(mission.id)!.status).toBe("review")
    await quiet.status(mission.id)
    expect(changes).toHaveLength(1)
  })

  it("detects a manual merge and completes the mission", async () => {
    setup()
    const root = repo()
    const { mission, slice } = initiativeIn(root, ["a"])
    builds.set("a", { "a.txt": "a\n" })
    const a = await runner.startSlice(slice("a").id)
    await drive(a.processRunId!)
    await integration.idle()
    git(root, "merge", "--no-ff", "-m", "my merge", "mc/billing/mission-1/integration")
    const status = await integration.status(mission.id)
    expect(status.landing).toMatchObject({ completedBy: "detected", mode: "manual" })
    expect(initiatives.getMission(mission.id)!.status).toBe("completed")
  })

  it("serializes slices with overlapping touch hints unless told otherwise", async () => {
    setup()
    const root = repo()
    const { slice } = initiativeIn(root, ["a", "b"])
    initiatives.updateSlice(slice("a").id, {
      spec: { ...slice("a").spec, touchHints: ["src/billing/**"] },
    })
    initiatives.updateSlice(slice("b").id, {
      spec: { ...slice("b").spec, touchHints: ["src/billing/invoice.ts"] },
    })
    await runner.startSlice(slice("a").id)
    await expect(runner.startSlice(slice("b").id)).rejects.toThrow(/touch_overlap/)
    await expect(
      runner.startSlice(slice("b").id, { allowTouchOverlap: true })
    ).resolves.toMatchObject({ status: "running" })
  })

  it("caps concurrent slices at the initiative budget", async () => {
    setup()
    const root = repo()
    const { initiative, slice } = initiativeIn(root, ["a", "b"])
    db.prepare("UPDATE initiatives SET budgets = ? WHERE id = ?").run(
      JSON.stringify({ maxConcurrentSlices: 1 }),
      initiative.id
    )
    await runner.startSlice(slice("a").id)
    await expect(runner.startSlice(slice("b").id)).rejects.toThrow(/1 slice\(s\) running at once/)
    // The refused attempt left no worktree behind.
    expect((await listWorktrees(root)).length).toBe(2)
  })

  it("keeps single-flight behavior with an explanation outside git", async () => {
    setup()
    const folder = mkdtempSync(path.join(tmpdir(), "mc-plain-"))
    dirs.push(folder)
    const { mission, slice } = initiativeIn(folder, ["a", "b"])
    const a = await runner.startSlice(slice("a").id)
    expect(a.worktreePath).toBeNull()
    await expect(runner.startSlice(slice("b").id)).rejects.toThrow(
      /one playbook run can use this workspace at a time.*git workspace/
    )
    const status = await integration.status(mission.id)
    expect(status.workspace).toMatchObject({
      mode: "single_flight",
      reason: expect.stringContaining("isn't a git repository"),
    })
    expect(status.policies.local_merge.available).toBe(false)
    await drive(a.processRunId!)
    expect(initiatives.getSlice(slice("a").id)!.status).toBe("done")
  })

  it("removes worktrees and merged mc branches when the initiative is deleted", async () => {
    setup()
    const root = repo()
    const { initiative, slice } = initiativeIn(root, ["a", "b"])
    builds.set("a", { "a.txt": "a\n" })
    const a = await runner.startSlice(slice("a").id)
    await drive(a.processRunId!)
    await integration.idle()
    const b = await runner.startSlice(slice("b").id)
    runner.cancelPlaybookRun(b.id)
    const { keptBranches } = await integration.cleanupInitiative(initiative.id)
    // The integration branch holds merged work that never reached main.
    expect(keptBranches).toEqual(["mc/billing/mission-1/integration"])
    expect(git(root, "branch", "--list", "mc/billing/mission-1/slices/*")).toBe("")
    expect((await listWorktrees(root)).length).toBe(1)
    expect(existsSync(path.join(worktreeRoot, initiative.id))).toBe(false)
  })
})

// A second service over the same database and worktree root, as after a
// restart.
function setupRestart() {
  const root = worktreeRoot
  integration.stop()
  integration = new MissionIntegration({
    worktreeRoot: () => root,
    startResolution: (input) => startConflictResolution(runner, input),
    notifyUser: (title, body) => notices.push(`${title}: ${body}`),
    leaseRetryMs: 10,
  })
  runner = new SliceRunner({
    startProcessRun: (input) => service.startRun(input),
    cancelTask: () => {},
    loadAgents: async () => AGENTS as unknown as AgentDefinition[],
    integration,
  })
}
