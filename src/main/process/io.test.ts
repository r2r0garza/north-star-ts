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
  createPhaseAttempt,
  createPhaseRun,
  createProcessRun,
  createPhaseAgent,
  createProcessDefinition,
  getProcessGraph,
  listProcessDefinitions,
  updatePhaseRun,
  updateProcessDefinition,
  updateProcessRun,
} from "../db/repositories/processes"
import { createConversation } from "../db/repositories/conversations"
import { createTask } from "../db/repositories/tasks"
import {
  buildProcessRunIncidentExport,
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

  it("exports failed top-level run identity with sanitized attempts", () => {
    const graph = seedGraph()
    const processTask = seedTask("process run")
    const workerTask = seedTask("phase worker")
    const run = createProcessRun({
      processId: graph.definition.id,
      sourceConversationId: processTask.sourceConversationId,
      workspaceId: null,
      taskId: processTask.id,
      objective: "Ship the thing",
    })
    updateProcessRun(run.id, {
      status: "failed",
      startedAt: Date.UTC(2026, 8, 2, 12),
      finishedAt: Date.UTC(2026, 8, 2, 12, 5),
    })
    const phaseRun = createPhaseRun({
      runId: run.id,
      phaseId: graph.phases[0].id,
      agentName: "coder",
      status: "failed",
    })
    updatePhaseRun(phaseRun.id, {
      taskId: workerTask.id,
      failure: failure({
        runId: run.id,
        phaseRunId: phaseRun.id,
        phaseId: graph.phases[0].id,
        taskId: processTask.id,
        workerTaskId: workerTask.id,
        message: "failed with Authorization: Bearer secret-token-value",
      }),
    })
    createPhaseAttempt({
      runId: run.id,
      phaseRunId: phaseRun.id,
      phaseId: graph.phases[0].id,
      taskId: processTask.id,
      workerTaskId: workerTask.id,
      agentName: "coder",
      stage: "model_request",
      attempt: 2,
      maxAttempts: 3,
      error: "unsanitized",
      failure: failure({
        runId: run.id,
        phaseRunId: phaseRun.id,
        phaseId: graph.phases[0].id,
        taskId: processTask.id,
        workerTaskId: workerTask.id,
        attempt: 2,
        maxAttempts: 3,
        message: "provider body: { token: secret-token-value }",
        cause: "prompt: do not export this",
      }),
    })

    const exported = buildProcessRunIncidentExport(run.id, testAppInfo())
    const serialized = JSON.stringify(exported)

    expect(exported.kind).toBe("process_run_incident")
    expect(exported.app).toEqual(testAppInfo())
    expect(exported.rootRunId).toBe(run.id)
    expect(exported.runs).toMatchObject([
      {
        id: run.id,
        processId: graph.definition.id,
        processName: graph.definition.name,
        taskId: processTask.id,
        sourceConversationId: processTask.sourceConversationId,
        workspaceId: null,
        status: "failed",
      },
    ])
    expect(exported.phaseRuns[0]).toMatchObject({
      id: phaseRun.id,
      runId: run.id,
      phaseId: graph.phases[0].id,
      phaseKey: "plan",
      taskId: workerTask.id,
      workerTaskId: workerTask.id,
      failure: { code: "provider_timeout", stage: "model_request" },
    })
    expect(exported.attempts[0]).toMatchObject({
      runId: run.id,
      phaseRunId: phaseRun.id,
      phaseId: graph.phases[0].id,
      phaseKey: "plan",
      taskId: processTask.id,
      workerTaskId: workerTask.id,
      stage: "model_request",
      attempt: 2,
      maxAttempts: 3,
      failure: { attempt: 2, maxAttempts: 3 },
    })
    expect(serialized).not.toContain("secret-token-value")
    expect(serialized).not.toContain("do not export this")
  })

  it("exports nested sub-process failures with parent and child run identity", () => {
    const graph = seedGraph()
    const parentTask = seedTask("parent process run")
    const parentWorkerTask = seedTask("parent phase worker")
    const childTask = seedTask("child process run")
    const childWorkerTask = seedTask("child phase worker")
    const subprocessPhase = graph.phases.find((phase) => phase.key === "build")!
    const parentRun = createProcessRun({
      processId: graph.definition.id,
      sourceConversationId: parentTask.sourceConversationId,
      workspaceId: null,
      taskId: parentTask.id,
      objective: "Parent objective",
    })
    const parentPhaseRun = createPhaseRun({
      runId: parentRun.id,
      phaseId: subprocessPhase.id,
      status: "failed",
      agentName: "subprocess-runner",
    })
    updatePhaseRun(parentPhaseRun.id, {
      taskId: parentWorkerTask.id,
      failure: failure({
        code: "subprocess_failed",
        stage: "subprocess",
        runId: parentRun.id,
        phaseRunId: parentPhaseRun.id,
        phaseId: subprocessPhase.id,
        taskId: parentTask.id,
        workerTaskId: parentWorkerTask.id,
      }),
    })
    const childProcessId = subprocessPhase.subprocessId!
    const childRun = createProcessRun({
      processId: childProcessId,
      sourceConversationId: parentTask.sourceConversationId,
      workspaceId: null,
      taskId: childTask.id,
      objective: "Child objective",
      parentPhaseRunId: parentPhaseRun.id,
      status: "failed",
    })
    const childPhase = getProcessGraph(childProcessId)!.phases[0]
    const childPhaseRun = createPhaseRun({
      runId: childRun.id,
      phaseId: childPhase.id,
      status: "failed",
      agentName: "child-agent",
    })
    createPhaseAttempt({
      runId: childRun.id,
      phaseRunId: childPhaseRun.id,
      phaseId: childPhase.id,
      taskId: childTask.id,
      workerTaskId: childWorkerTask.id,
      agentName: "child-agent",
      stage: "tool_execution",
      attempt: 1,
      maxAttempts: 1,
      error: "tool failed",
      failure: failure({
        code: "tool_failed",
        stage: "tool_execution",
        runId: childRun.id,
        phaseRunId: childPhaseRun.id,
        phaseId: childPhase.id,
        taskId: childTask.id,
        workerTaskId: childWorkerTask.id,
      }),
    })

    const exported = buildProcessRunIncidentExport(parentRun.id, testAppInfo())

    expect(exported.runs.map((run) => run.id)).toEqual([
      parentRun.id,
      childRun.id,
    ])
    expect(exported.runs.find((run) => run.id === childRun.id)).toMatchObject({
      parentPhaseRunId: parentPhaseRun.id,
      processId: childProcessId,
      processName: "Child Process",
      taskId: childTask.id,
      status: "failed",
    })
    expect(exported.phaseRuns.map((phaseRun) => phaseRun.id)).toEqual([
      parentPhaseRun.id,
      childPhaseRun.id,
    ])
    expect(exported.attempts).toMatchObject([
      {
        runId: childRun.id,
        phaseRunId: childPhaseRun.id,
        phaseId: childPhase.id,
        phaseKey: "only",
        workerTaskId: childWorkerTask.id,
        failure: {
          code: "tool_failed",
          stage: "tool_execution",
          runId: childRun.id,
          phaseRunId: childPhaseRun.id,
        },
      },
    ])
  })
})

function seedGraph() {
  const subprocess = createProcessDefinition({ name: "Child Process" })
  createPhase({
    processId: subprocess.id,
    key: "only",
    name: "Only child phase",
    routing: "single",
    gatePolicy: "auto",
    fanOut: false,
    maxReworkRounds: 0,
    dotFolder: false,
    validator: false,
    validatorMaxIterations: 0,
    position: 1,
  })
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

function testAppInfo() {
  return { name: "North Star", version: "1.2.3", build: "test-build" }
}

function seedTask(title: string) {
  const conversation = createConversation({ mode: "north_star" })
  const worker = createConversation({ mode: "north_star" })
  return createTask({
    conversationId: worker.id,
    sourceConversationId: conversation.id,
    title,
    status: "failed",
  })
}

function failure(patch: Partial<import("../db/types").FailureContext> = {}) {
  return {
    code: "provider_timeout",
    stage: "model_request",
    message: "provider timed out",
    retryable: true,
    attempt: 1,
    maxAttempts: 3,
    runId: null,
    phaseRunId: null,
    phaseId: null,
    taskId: null,
    workerTaskId: null,
    agentName: "coder",
    occurredAt: Date.UTC(2026, 8, 2, 12),
    ...patch,
  } satisfies import("../db/types").FailureContext
}
