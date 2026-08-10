import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../migrations"

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

// better-sqlite3's native binary is built for the Electron ABI here; under
// plain-Node vitest it may not load (see native-module-rebuild note). SQLite-
// backed tests skip rather than fail when the ABI mismatches.
let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

import {
  createProcessDefinition,
  getProcessDefinition,
  listProcessDefinitions,
  updateProcessDefinition,
  deleteProcessDefinition,
  createPhase,
  listPhases,
  updatePhase,
  createPhaseAgent,
  listPhaseAgents,
  createEdge,
  listEdges,
  getProcessGraph,
  createProcessRun,
  getProcessRun,
  listProcessRuns,
  updateProcessRun,
  createPhaseRun,
  getPhaseRun,
  listPhaseRuns,
  updatePhaseRun,
} from "./processes"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("v15 migration", () => {
  it("creates the six process tables", () => {
    for (const name of [
      "process_definitions",
      "process_phases",
      "process_phase_agents",
      "process_edges",
      "process_runs",
      "process_phase_runs",
    ]) {
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(name)
      expect(row, name).toBeTruthy()
    }
  })

  it("reaches the latest user_version", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(20)
  })

  it("adds the v18 title column to process_runs", () => {
    const cols = (
      db.pragma("table_info(process_runs)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toContain("title")
  })

  it("adds the v16 workspace_id column to process_runs", () => {
    const cols = (
      db.pragma("table_info(process_runs)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toContain("workspace_id")
  })

  it("adds the v17 title column to process_phase_runs", () => {
    const cols = (
      db.pragma("table_info(process_phase_runs)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toContain("title")
  })
})

describe.skipIf(!sqliteLoads)("process definitions", () => {
  it("CRUD round-trips", () => {
    const def = createProcessDefinition({ name: "Build", description: "d" })
    expect(getProcessDefinition(def.id)!.name).toBe("Build")
    updateProcessDefinition(def.id, { name: "Ship" })
    expect(getProcessDefinition(def.id)!.name).toBe("Ship")
    expect(listProcessDefinitions().map((d) => d.id)).toContain(def.id)
    deleteProcessDefinition(def.id)
    expect(getProcessDefinition(def.id)).toBeUndefined()
  })

  it("cascades phases, agents, and edges on delete", () => {
    const def = createProcessDefinition({ name: "P" })
    const a = createPhase({ processId: def.id, key: "a", name: "A", position: 0 })
    const b = createPhase({ processId: def.id, key: "b", name: "B", position: 1 })
    createPhaseAgent({ phaseId: a.id, agentName: "coder", position: 0 })
    createEdge({ processId: def.id, fromPhaseId: a.id, toPhaseId: b.id })

    deleteProcessDefinition(def.id)
    expect(listPhases(def.id)).toHaveLength(0)
    expect(listPhaseAgents(a.id)).toHaveLength(0)
    expect(listEdges(def.id)).toHaveLength(0)
  })
})

describe.skipIf(!sqliteLoads)("phases + agents", () => {
  it("phases are ordered by position; defaults applied", () => {
    const def = createProcessDefinition({ name: "P" })
    createPhase({ processId: def.id, key: "b", name: "B", position: 1 })
    createPhase({ processId: def.id, key: "a", name: "A", position: 0 })
    const phases = listPhases(def.id)
    expect(phases.map((p) => p.key)).toEqual(["a", "b"])
    expect(phases[0].routing).toBe("single")
    expect(phases[0].gatePolicy).toBe("auto")
    expect(phases[0].fanOut).toBe(false)
  })

  it("updatePhase writes routing/gate/fanOut", () => {
    const def = createProcessDefinition({ name: "P" })
    const p = createPhase({ processId: def.id, key: "a", name: "A", position: 0 })
    updatePhase(p.id, {
      routing: "dispatch",
      gatePolicy: "approve",
      fanOut: true,
    })
    const phases = listPhases(def.id)
    expect(phases[0].routing).toBe("dispatch")
    expect(phases[0].gatePolicy).toBe("approve")
    expect(phases[0].fanOut).toBe(true)
  })

  it("agent skills/tools are tri-state: null vs [] vs [list]", () => {
    const def = createProcessDefinition({ name: "P" })
    const p = createPhase({ processId: def.id, key: "a", name: "A", position: 0 })
    createPhaseAgent({ phaseId: p.id, agentName: "own", position: 0 }) // null
    createPhaseAgent({
      phaseId: p.id,
      agentName: "none",
      skills: [],
      tools: [],
      position: 1,
    })
    createPhaseAgent({
      phaseId: p.id,
      agentName: "some",
      skills: ["x"],
      tools: ["read"],
      position: 2,
    })
    const agents = listPhaseAgents(p.id)
    expect(agents[0].skills).toBeNull()
    expect(agents[0].tools).toBeNull()
    expect(agents[1].skills).toEqual([])
    expect(agents[1].tools).toEqual([])
    expect(agents[2].skills).toEqual(["x"])
    expect(agents[2].tools).toEqual(["read"])
  })
})

describe.skipIf(!sqliteLoads)("edges + graph", () => {
  it("getProcessGraph assembles definition, phases, agents, edges", () => {
    const def = createProcessDefinition({ name: "P" })
    const a = createPhase({ processId: def.id, key: "a", name: "A", position: 0 })
    const b = createPhase({ processId: def.id, key: "b", name: "B", position: 1 })
    createPhaseAgent({ phaseId: a.id, agentName: "coder", position: 0 })
    const edge = createEdge({
      processId: def.id,
      fromPhaseId: a.id,
      toPhaseId: b.id,
      trigger: "on_each_subtask",
    })
    const graph = getProcessGraph(def.id)!
    expect(graph.definition.id).toBe(def.id)
    expect(graph.phases).toHaveLength(2)
    expect(graph.agents).toHaveLength(1)
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0].trigger).toBe("on_each_subtask")
    expect(edge.trigger).toBe("on_each_subtask")
  })

  it("edges default to on_complete", () => {
    const def = createProcessDefinition({ name: "P" })
    const a = createPhase({ processId: def.id, key: "a", name: "A", position: 0 })
    const b = createPhase({ processId: def.id, key: "b", name: "B", position: 1 })
    const edge = createEdge({ processId: def.id, fromPhaseId: a.id, toPhaseId: b.id })
    expect(edge.trigger).toBe("on_complete")
  })
})

describe.skipIf(!sqliteLoads)("runs + phase runs", () => {
  function freshConversation(): string {
    const id = randomUUID()
    const now = Date.now()
    db.prepare(
      "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
    ).run(id, now, now)
    return id
  }

  it("run lifecycle writes status/timestamps", () => {
    const def = createProcessDefinition({ name: "P" })
    const conv = freshConversation()
    const run = createProcessRun({
      processId: def.id,
      sourceConversationId: conv,
      objective: "do it",
    })
    expect(run.status).toBe("queued")
    expect(run.objective).toBe("do it")
    updateProcessRun(run.id, { status: "running", startedAt: 123 })
    expect(getProcessRun(run.id)!.status).toBe("running")
    expect(getProcessRun(run.id)!.startedAt).toBe(123)
    expect(listProcessRuns({ processId: def.id }).map((r) => r.id)).toContain(
      run.id
    )
    expect(listProcessRuns({ status: "running" }).map((r) => r.id)).toContain(
      run.id
    )
  })

  it("run title defaults null and round-trips through updateProcessRun", () => {
    const def = createProcessDefinition({ name: "P" })
    const run = createProcessRun({
      processId: def.id,
      sourceConversationId: null,
      objective: "refactor the auth module",
    })
    expect(run.title).toBeNull()
    updateProcessRun(run.id, { title: "Refactor auth module" })
    expect(getProcessRun(run.id)!.title).toBe("Refactor auth module")
  })

  it("phase runs write status and filter by parent (null vs set)", () => {
    const def = createProcessDefinition({ name: "P" })
    const phase = createPhase({
      processId: def.id,
      key: "a",
      name: "A",
      position: 0,
    })
    const run = createProcessRun({
      processId: def.id,
      sourceConversationId: null,
    })
    const parent = createPhaseRun({ runId: run.id, phaseId: phase.id })
    const child = createPhaseRun({
      runId: run.id,
      phaseId: phase.id,
      parentId: parent.id,
    })
    updatePhaseRun(parent.id, {
      status: "completed",
      agentName: "coder",
      finishedAt: 5,
    })
    expect(getPhaseRun(parent.id)!.status).toBe("completed")
    expect(getPhaseRun(parent.id)!.agentName).toBe("coder")

    const topLevel = listPhaseRuns({ runId: run.id, parentId: null })
    expect(topLevel.map((r) => r.id)).toEqual([parent.id])
    const children = listPhaseRuns({ runId: run.id, parentId: parent.id })
    expect(children.map((r) => r.id)).toEqual([child.id])
  })

  it("cascades phase runs when the run is deleted", () => {
    const def = createProcessDefinition({ name: "P" })
    const phase = createPhase({
      processId: def.id,
      key: "a",
      name: "A",
      position: 0,
    })
    const run = createProcessRun({
      processId: def.id,
      sourceConversationId: null,
    })
    createPhaseRun({ runId: run.id, phaseId: phase.id })
    db.prepare("DELETE FROM process_runs WHERE id = ?").run(run.id)
    expect(listPhaseRuns({ runId: run.id })).toHaveLength(0)
  })

  it("run.process_id is SET NULL when the definition is deleted", () => {
    const def = createProcessDefinition({ name: "P" })
    const run = createProcessRun({
      processId: def.id,
      sourceConversationId: null,
    })
    deleteProcessDefinition(def.id)
    expect(getProcessRun(run.id)!.processId).toBeNull()
  })
})
