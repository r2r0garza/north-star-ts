import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../../db/migrations"

let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

let sqliteLoads = true
try {
  new Database(":memory:").close()
} catch {
  sqliteLoads = false
}

// Each phase worker's agent loop is stubbed — no real LLM turn. It records the
// agentName the forked worker conversation was stamped with, so the test can
// assert routing picked the right agent, and appends a final assistant message so
// the run has "output".
const loopCalls: { conversationId: string }[] = []
vi.mock("../../agent", () => ({
  runAgentLoop: async (input: { conversationId: string }) => {
    loopCalls.push({ conversationId: input.conversationId })
    // Give the worker a final assistant message (its "output").
    db.prepare(
      "INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, 'assistant', 'done', ?)"
    ).run(randomUUID(), input.conversationId, 1, Date.now())
    return { content: "done" }
  },
}))

// The router's classifier. `nextReply` is the chosen agent name; the roster the
// router builds is asserted indirectly via the recorded agentName on the run.
let nextReply = ""
vi.mock("../../agent/providers", () => {
  class NoActiveProviderError extends Error {}
  return {
    resolveLlm: () => ({
      client: {},
      model: "m",
      accountId: "a1",
      apiMode: "completions",
    }),
    createCompletion: async () => ({
      choices: [{ message: { content: nextReply } }],
    }),
    NoActiveProviderError,
  }
})

const descriptions: Record<string, string> = {}
vi.mock("../../agent/agents/loader", () => ({
  loadAgent: async (name: string) => ({
    name,
    description: descriptions[name] ?? "",
  }),
}))

import * as processes from "../../db/repositories/processes"
import { ProcessService } from "./service"
import type { TaskEventPayload } from "../runner"

// A minimal fake runner — the service only calls enqueueKind from startRun, which
// this test doesn't exercise (it drives the executor directly).
const fakeRunner = { enqueueKind: () => ({ id: "t" }) } as never

function seedTaskRow(): { taskId: string } {
  const convId = randomUUID()
  const taskId = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
  ).run(convId, now, now)
  db.prepare(
    "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, NULL, 'running', NULL, NULL, NULL, ?, ?)"
  ).run(taskId, convId, convId, now, now)
  return { taskId }
}

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  loopCalls.length = 0
  nextReply = ""
  for (const k of Object.keys(descriptions)) delete descriptions[k]
})

describe.skipIf(!sqliteLoads)("ProcessService dispatch routing", () => {
  it("records the routed agent_name on a dispatch phase's run", async () => {
    // One dispatch phase with a two-agent pool (frontend, backend).
    const def = processes.createProcessDefinition({ name: "T" })
    const phase = processes.createPhase({
      processId: def.id,
      key: "construct",
      name: "Construct",
      routing: "dispatch",
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "frontend",
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "backend",
      position: 1,
    })
    descriptions["frontend"] = "React/CSS UI work"
    descriptions["backend"] = "APIs and databases"
    // The classifier picks backend (not pool[0]) — proves routing, not fallback.
    nextReply = "backend"

    const { taskId } = seedTaskRow()
    const run = processes.createProcessRun({
      processId: def.id,
      sourceConversationId: null,
      taskId,
      objective: "build a server route",
      status: "running",
    })

    const svc = new ProcessService(fakeRunner)
    const events: TaskEventPayload[] = []
    const task = { id: taskId, input: { processRunId: run.id } } as never
    const result = await svc.execute({
      task,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      workspace: undefined,
    })

    expect((result as { content?: string }).content).toBe("process complete")
    const phaseRun = processes
      .listPhaseRuns({ runId: run.id, parentId: null })
      .find((pr) => pr.phaseId === phase.id)!
    expect(phaseRun.status).toBe("completed")
    // Routed to the classifier's pick, and the same name rides the phase event.
    expect(phaseRun.agentName).toBe("backend")
    const completed = events.find(
      (e) => e.type === "process_phase" && e.status === "completed"
    ) as { agentName?: string } | undefined
    expect(completed?.agentName).toBe("backend")
  })

  it("uses pool[0] for a single-routing phase (no classifier)", async () => {
    const def = processes.createProcessDefinition({ name: "T" })
    const phase = processes.createPhase({
      processId: def.id,
      key: "plan",
      name: "Plan",
      routing: "single",
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "planner",
      position: 0,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      agentName: "other",
      position: 1,
    })
    // Even if the classifier WOULD pick "other", single routing ignores it.
    nextReply = "other"

    const { taskId } = seedTaskRow()
    const run = processes.createProcessRun({
      processId: def.id,
      sourceConversationId: null,
      taskId,
      objective: "plan it",
      status: "running",
    })

    const svc = new ProcessService(fakeRunner)
    await svc.execute({
      task: { id: taskId, input: { processRunId: run.id } } as never,
      signal: new AbortController().signal,
      emit: () => {},
      workspace: undefined,
    })

    const phaseRun = processes
      .listPhaseRuns({ runId: run.id, parentId: null })
      .find((pr) => pr.phaseId === phase.id)!
    expect(phaseRun.agentName).toBe("planner")
  })
})
