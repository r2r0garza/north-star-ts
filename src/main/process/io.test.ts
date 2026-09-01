import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../db/migrations"
import { sqliteLoadsForTests } from "../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../db/connection", () => ({ getDb: () => db }))

import {
  createEdge,
  createPhase,
  createPhaseAgent,
  createProcessDefinition,
  getProcessGraph,
  listProcessDefinitions,
  updateProcessDefinition,
} from "../db/repositories/processes"
import {
  buildProcessExport,
  importProcessExport,
  type ProcessExport,
} from "./io"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

describe.skipIf(!sqliteLoads)("process import/export", () => {
  it("exports id-free JSON with edges keyed by phase key", () => {
    const graph = seedGraph()
    const exported = buildProcessExport(graph)
    const text = JSON.stringify(exported)

    expect(exported.formatVersion).toBe(1)
    expect(exported.phases.map((p) => p.key)).toEqual(["plan", "build"])
    expect(exported.edges).toEqual([
      { fromKey: "plan", toKey: "build", trigger: "on_each_subtask" },
    ])
    expect(text).not.toContain(graph.definition.id)
    for (const phase of graph.phases) expect(text).not.toContain(phase.id)
    for (const edge of graph.edges) expect(text).not.toContain(edge.id)
  })

  it("round-trips a graph modulo fresh row ids", () => {
    const originalGraph = seedGraph()
    const original = buildProcessExport(originalGraph)

    const result = importProcessExport(original)
    const importedGraph = getProcessGraph(result.processId)!
    const imported = buildProcessExport(importedGraph)

    expect(stripVolatile(imported)).toEqual(stripVolatile(original))
    expect(importedGraph.definition.id).not.toBe(originalGraph.definition.id)
    expect(result.warnings).toHaveLength(2)
  })

  it("rejects malformed imports without partial writes", () => {
    expect(() =>
      importProcessExport({
        formatVersion: 1,
        definition: { name: "Bad", description: null },
        phases: [
          {
            key: "a",
            name: "A",
            routing: "single",
            gatePolicy: "auto",
            fanOut: false,
            maxReworkRounds: 0,
            dotFolder: false,
            validator: false,
            validatorMaxIterations: 0,
            position: 1,
            agents: [],
          },
        ],
        edges: [{ fromKey: "a", toKey: "missing", trigger: "on_complete" }],
      })
    ).toThrow("unknown toKey")

    expect(listProcessDefinitions()).toHaveLength(0)
  })

  it("warns and drops unresolved sub-process references", () => {
    const input = minimalExport()
    input.phases[0].subprocess = { name: "Missing child" }

    const result = importProcessExport(input)
    const graph = getProcessGraph(result.processId)!

    expect(graph.phases[0].subprocessId).toBeNull()
    expect(result.warnings.join(" ")).toContain("Missing child")
  })
})

function seedGraph() {
  const subprocess = createProcessDefinition({ name: "Child Process" })
  const definition = createProcessDefinition({
    name: "Ship Feature",
    description: "Build and verify a slice",
  })
  updateProcessDefinition(definition.id, { requireFlagApproval: false })
  const plan = createPhase({
    processId: definition.id,
    key: "plan",
    name: "Plan",
    routing: "single",
    gatePolicy: "approve",
    fanOut: true,
    maxReworkRounds: 2,
    dotFolder: true,
    validator: true,
    validatorMaxIterations: 3,
    validatorAgent:
      'agentref:v1:{"sourceKind":"cursor","scope":"global","definitionPath":"/tmp/reviewer.md","nativeName":"reviewer"}',
    position: 1,
  })
  const build = createPhase({
    processId: definition.id,
    key: "build",
    name: "Build",
    routing: "dispatch",
    gatePolicy: "auto",
    fanOut: false,
    maxReworkRounds: 0,
    dotFolder: false,
    validator: false,
    validatorMaxIterations: 0,
    subprocessId: subprocess.id,
    position: 2,
  })
  createPhaseAgent({
    phaseId: plan.id,
    agentName:
      'agentref:v1:{"sourceKind":"north_star","scope":"workspace","definitionPath":"/tmp/coder.agent.md","nativeName":"coder"}',
    skills: ["react"],
    tools: [],
    position: 0,
  })
  createEdge({
    processId: definition.id,
    fromPhaseId: plan.id,
    toPhaseId: build.id,
    trigger: "on_each_subtask",
  })
  return getProcessGraph(definition.id)!
}

function minimalExport(): ProcessExport {
  return {
    formatVersion: 1,
    exportedAt: "2026-09-01T00:00:00.000Z",
    definition: {
      name: "Imported",
      description: null,
      requireFlagApproval: true,
    },
    phases: [
      {
        key: "only",
        name: "Only",
        routing: "single",
        gatePolicy: "auto",
        fanOut: false,
        maxReworkRounds: 0,
        dotFolder: false,
        validator: false,
        validatorMaxIterations: 0,
        validatorAgent: null,
        subprocess: null,
        position: 1,
        agents: [],
      },
    ],
    edges: [],
  }
}

function stripVolatile(
  exported: ProcessExport
): Omit<ProcessExport, "exportedAt"> {
  const { exportedAt: _exportedAt, ...rest } = exported
  return rest
}
