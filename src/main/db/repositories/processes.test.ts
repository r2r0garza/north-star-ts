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
  getPhase,
  listPhases,
  updatePhase,
  wouldCloseSubprocessCycle,
  createPhaseAgent,
  listPhaseAgents,
  createEdge,
  listEdges,
  getProcessGraph,
  createProcessRun,
  getProcessRun,
  getProcessRunByParentPhaseRunId,
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
    expect(db.pragma("user_version", { simple: true })).toBe(24)
  })

  it("adds the v24 subprocess_id column to process_phases", () => {
    const cols = (
      db.pragma("table_info(process_phases)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toContain("subprocess_id")
  })

  it("adds the v24 parent_phase_run_id column to process_runs", () => {
    const cols = (
      db.pragma("table_info(process_runs)") as Array<{ name: string }>
    ).map((c) => c.name)
    expect(cols).toContain("parent_phase_run_id")
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

describe.skipIf(!sqliteLoads)("sub-processes (plan 038.1)", () => {
  it("subprocess_id defaults null and round-trips through create/update", () => {
    const parent = createProcessDefinition({ name: "Parent" })
    const sub = createProcessDefinition({ name: "Sub" })
    const phase = createPhase({
      processId: parent.id,
      key: "impl",
      name: "Implement",
      position: 0,
    })
    expect(getPhase(phase.id)!.subprocessId).toBeNull()
    updatePhase(phase.id, { subprocessId: sub.id })
    expect(getPhase(phase.id)!.subprocessId).toBe(sub.id)
    updatePhase(phase.id, { subprocessId: null })
    expect(getPhase(phase.id)!.subprocessId).toBeNull()
  })

  it("rejects a phase that is both fan-out and a sub-process", () => {
    const parent = createProcessDefinition({ name: "Parent" })
    const sub = createProcessDefinition({ name: "Sub" })
    expect(() =>
      createPhase({
        processId: parent.id,
        key: "impl",
        name: "Implement",
        fanOut: true,
        subprocessId: sub.id,
        position: 0,
      })
    ).toThrow(/both fan-out and a sub-process/)
    // Also on update: a fan-out phase can't gain a subprocess_id.
    const fan = createPhase({
      processId: parent.id,
      key: "fan",
      name: "Fan",
      fanOut: true,
      position: 1,
    })
    expect(() => updatePhase(fan.id, { subprocessId: sub.id })).toThrow(
      /both fan-out and a sub-process/
    )
  })

  it("rejects a self-referential sub-process (cycle)", () => {
    const def = createProcessDefinition({ name: "Self" })
    expect(() =>
      createPhase({
        processId: def.id,
        key: "a",
        name: "A",
        subprocessId: def.id,
        position: 0,
      })
    ).toThrow(/cycle/)
    expect(wouldCloseSubprocessCycle(def.id, def.id)).toBe(true)
  })

  it("rejects a 2-hop sub-process cycle but allows an acyclic chain", () => {
    // A runs B, B runs C — acyclic. Then C running A would close a cycle.
    const A = createProcessDefinition({ name: "A" })
    const B = createProcessDefinition({ name: "B" })
    const C = createProcessDefinition({ name: "C" })
    createPhase({
      processId: A.id,
      key: "ab",
      name: "AB",
      subprocessId: B.id,
      position: 0,
    })
    createPhase({
      processId: B.id,
      key: "bc",
      name: "BC",
      subprocessId: C.id,
      position: 0,
    })
    // C -> A closes A -> B -> C -> A.
    expect(wouldCloseSubprocessCycle(C.id, A.id)).toBe(true)
    expect(() =>
      createPhase({
        processId: C.id,
        key: "ca",
        name: "CA",
        subprocessId: A.id,
        position: 0,
      })
    ).toThrow(/cycle/)
    // C -> a brand-new definition D is fine (no cycle).
    const D = createProcessDefinition({ name: "D" })
    expect(wouldCloseSubprocessCycle(C.id, D.id)).toBe(false)
  })

  it("parent_phase_run_id round-trips and getProcessRunByParentPhaseRunId finds the nested run", () => {
    const parent = createProcessDefinition({ name: "Parent" })
    const sub = createProcessDefinition({ name: "Sub" })
    const phase = createPhase({
      processId: parent.id,
      key: "impl",
      name: "Implement",
      subprocessId: sub.id,
      position: 0,
    })
    const run = createProcessRun({
      processId: parent.id,
      sourceConversationId: null,
    })
    const implRun = createPhaseRun({ runId: run.id, phaseId: phase.id })
    expect(getProcessRun(run.id)!.parentPhaseRunId).toBeNull()
    const child = createProcessRun({
      processId: sub.id,
      sourceConversationId: null,
      parentPhaseRunId: implRun.id,
    })
    expect(getProcessRun(child.id)!.parentPhaseRunId).toBe(implRun.id)
    expect(getProcessRunByParentPhaseRunId(implRun.id)!.id).toBe(child.id)
    expect(
      listProcessRuns({ parentPhaseRunId: implRun.id }).map((r) => r.id)
    ).toEqual([child.id])
  })
})
