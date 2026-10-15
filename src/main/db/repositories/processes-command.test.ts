import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { runMigrations } from "../migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../connection", () => ({ getDb: () => db }))

import {
  createEdge,
  createPhase,
  createPhaseAgent,
  createPhaseRun,
  createProcessDefinition,
  createProcessRun,
  getPhase,
  getPhaseRun,
  listPhaseAgents,
  updatePhase,
  updatePhaseRun,
} from "./processes"
import { getWorkspace, setWorkspaceCheck, upsertWorkspace } from "./workspaces"
import {
  commandCheckStatus,
  requiredChecks,
} from "../../process/command-checks"
import type { ProcessCommandReceipt } from "../types"

// Deterministic command phases (plan 104): the phase kind, its invariants, the
// migration backfill, and the run-side receipt.

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  db.pragma("foreign_keys = ON")
  runMigrations(db)
})

const test = {
  source: "literal" as const,
  command: "pnpm test",
  cwd: null,
  timeoutMs: 60_000,
  maxOutputBytes: 4096,
}

function definition(name = "P") {
  return createProcessDefinition({ name })
}

describe.skipIf(!sqliteLoads)("v69 migration", () => {
  it("backfills existing sub-process phases as `subprocess` and the rest as `agent`", () => {
    db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    runMigrations(db, { through: 68 })
    const now = Date.now()
    db.prepare(
      "INSERT INTO process_definitions (id, name, created_at, updated_at) VALUES ('child', 'Child', ?, ?), ('parent', 'Parent', ?, ?)"
    ).run(now, now, now, now)
    db.prepare(
      `INSERT INTO process_phases (id, process_id, key, name, position, subprocess_id)
       VALUES ('p-agent', 'parent', 'build', 'Build', 0, NULL),
              ('p-sub', 'parent', 'nested', 'Nested', 1, 'child')`
    ).run()

    runMigrations(db)

    expect(getPhase("p-agent")).toMatchObject({
      kind: "agent",
      commandConfig: null,
    })
    expect(getPhase("p-sub")).toMatchObject({
      kind: "subprocess",
      subprocessId: "child",
    })
    expect(db.pragma("user_version", { simple: true })).toBe(71)
  })

  it("rejects an unknown kind at the column", () => {
    const def = definition()
    const phase = createPhase({
      processId: def.id,
      key: "a",
      name: "A",
      position: 0,
    })
    expect(() =>
      db
        .prepare("UPDATE process_phases SET kind = 'shell' WHERE id = ?")
        .run(phase.id)
    ).toThrow()
  })
})

describe.skipIf(!sqliteLoads)("phase kinds (plan 104)", () => {
  it("defaults to agent, or subprocess when a sub-process is named", () => {
    const child = definition("Child")
    const def = definition()
    expect(
      createPhase({ processId: def.id, key: "a", name: "A", position: 0 }).kind
    ).toBe("agent")
    expect(
      createPhase({
        processId: def.id,
        key: "b",
        name: "B",
        position: 1,
        subprocessId: child.id,
      }).kind
    ).toBe("subprocess")
  })

  it("creates a command phase with a normalized, bounded config", () => {
    const def = definition()
    const phase = createPhase({
      processId: def.id,
      key: "test",
      name: "Test",
      position: 0,
      kind: "command",
      commandConfig: {
        ...test,
        command: "  pnpm test  ",
        cwd: "./packages//app/",
      },
    })
    expect(phase.kind).toBe("command")
    expect(phase.commandConfig).toEqual({ ...test, cwd: "packages/app" })
  })

  it("enforces the kind-specific invariants", () => {
    const child = definition("Child")
    const def = definition()
    const base = { processId: def.id, key: "x", name: "X", position: 0 }
    expect(() => createPhase({ ...base, kind: "command" })).toThrow(
      /needs a command/
    )
    expect(() =>
      createPhase({
        ...base,
        kind: "command",
        commandConfig: { ...test, command: "  " },
      })
    ).toThrow(/command is required/)
    expect(() =>
      createPhase({
        ...base,
        kind: "command",
        commandConfig: test,
        subprocessId: child.id,
      })
    ).toThrow(/sub-process/)
    expect(() =>
      createPhase({
        ...base,
        kind: "command",
        commandConfig: test,
        fanOut: true,
      })
    ).toThrow(/fan out/)
    expect(() =>
      createPhase({
        ...base,
        kind: "command",
        commandConfig: test,
        validator: true,
      })
    ).toThrow(/validator/)
    expect(() =>
      createPhase({
        ...base,
        kind: "command",
        commandConfig: test,
        proofStep: true,
      })
    ).toThrow(/proof step/)
    expect(() =>
      createPhase({ ...base, kind: "agent", commandConfig: test })
    ).toThrow(/agent phase cannot have a command/)
    expect(() => createPhase({ ...base, kind: "subprocess" })).toThrow(
      /needs a process/
    )
    expect(() =>
      createPhase({
        ...base,
        kind: "subprocess",
        subprocessId: child.id,
        commandConfig: test,
      })
    ).toThrow(/cannot have a command/)
  })

  it("rejects out-of-bounds timeouts and output limits", () => {
    const def = definition()
    const base = {
      processId: def.id,
      key: "x",
      name: "X",
      position: 0,
      kind: "command" as const,
    }
    expect(() =>
      createPhase({ ...base, commandConfig: { ...test, timeoutMs: 10 } })
    ).toThrow(/timeoutMs/)
    expect(() =>
      createPhase({
        ...base,
        commandConfig: { ...test, timeoutMs: 3 * 60 * 60_000 },
      })
    ).toThrow(/timeoutMs/)
    expect(() =>
      createPhase({ ...base, commandConfig: { ...test, maxOutputBytes: 10 } })
    ).toThrow(/maxOutputBytes/)
    expect(() =>
      createPhase({
        ...base,
        commandConfig: { ...test, command: "x".repeat(9_000) },
      })
    ).toThrow(/longer than/)
  })

  it.each([
    ["/etc"],
    ["../outside"],
    ["src/../../outside"],
    ["~/code"],
    ["C:\\work"],
  ])("rejects the escaping working directory %s", (cwd) => {
    const def = definition()
    expect(() =>
      createPhase({
        processId: def.id,
        key: "x",
        name: "X",
        position: 0,
        kind: "command",
        commandConfig: { ...test, cwd },
      })
    ).toThrow(/workspace/)
  })

  it("switches an agent phase to a command in one write, discarding its pool", () => {
    const def = definition()
    const phase = createPhase({
      processId: def.id,
      key: "t",
      name: "T",
      position: 0,
      validator: true,
    })
    createPhaseAgent({ phaseId: phase.id, agentName: "tester", position: 0 })
    updatePhase(phase.id, { runtimeConfig: { worker: { modelId: "m" } } })

    expect(() => updatePhase(phase.id, { kind: "command" })).toThrow(
      /needs a command/
    )
    // Nothing was written by the rejected switch.
    expect(getPhase(phase.id)?.kind).toBe("agent")
    expect(listPhaseAgents(phase.id)).toHaveLength(1)

    const updated = updatePhase(phase.id, {
      kind: "command",
      commandConfig: test,
    })
    expect(updated).toMatchObject({
      kind: "command",
      commandConfig: test,
      validator: false,
      runtimeConfig: null,
    })
    expect(listPhaseAgents(phase.id)).toHaveLength(0)
    expect(() =>
      createPhaseAgent({ phaseId: phase.id, agentName: "tester", position: 0 })
    ).toThrow(/no agent pool/)
  })

  it("rejects an explicit contradiction instead of coercing it", () => {
    const def = definition()
    const phase = createPhase({
      processId: def.id,
      key: "t",
      name: "T",
      position: 0,
    })
    expect(() =>
      updatePhase(phase.id, {
        kind: "command",
        commandConfig: test,
        fanOut: true,
      })
    ).toThrow(/fan out/)
    const command = updatePhase(phase.id, {
      kind: "command",
      commandConfig: test,
    })
    expect(() => updatePhase(command.id, { validator: true })).toThrow(
      /validator/
    )
    expect(() => updatePhase(command.id, { commandConfig: null })).toThrow(
      /needs a command/
    )
  })

  it("switches back to an agent and clears the command", () => {
    const def = definition()
    const phase = createPhase({
      processId: def.id,
      key: "t",
      name: "T",
      position: 0,
      kind: "command",
      commandConfig: test,
    })
    expect(updatePhase(phase.id, { kind: "agent" })).toMatchObject({
      kind: "agent",
      commandConfig: null,
    })
  })

  it("keeps the pre-104 sub-process toggle working through the inferred kind", () => {
    const child = definition("Child")
    const def = definition()
    const phase = createPhase({
      processId: def.id,
      key: "t",
      name: "T",
      position: 0,
    })
    expect(updatePhase(phase.id, { subprocessId: child.id }).kind).toBe(
      "subprocess"
    )
    expect(updatePhase(phase.id, { subprocessId: null }).kind).toBe("agent")
  })

  it("lets a command phase depend only on whole phases", () => {
    const def = definition()
    const build = createPhase({
      processId: def.id,
      key: "b",
      name: "B",
      position: 0,
      fanOut: true,
    })
    const test2 = createPhase({
      processId: def.id,
      key: "t",
      name: "T",
      position: 1,
      kind: "command",
      commandConfig: test,
    })
    expect(() =>
      createEdge({
        processId: def.id,
        fromPhaseId: build.id,
        toPhaseId: test2.id,
        trigger: "on_each_subtask",
      })
    ).toThrow(/whole phases/)
    createEdge({
      processId: def.id,
      fromPhaseId: build.id,
      toPhaseId: test2.id,
    })

    const review = createPhase({
      processId: def.id,
      key: "r",
      name: "R",
      position: 2,
    })
    createEdge({
      processId: def.id,
      fromPhaseId: build.id,
      toPhaseId: review.id,
      trigger: "on_each_subtask",
    })
    expect(() =>
      updatePhase(review.id, { kind: "command", commandConfig: test })
    ).toThrow(/whole phases/)
  })
})

describe.skipIf(!sqliteLoads)("command receipts", () => {
  it("live on the phase run, not the definition", () => {
    const def = definition()
    const phase = createPhase({
      processId: def.id,
      key: "t",
      name: "T",
      position: 0,
      kind: "command",
      commandConfig: test,
    })
    const run = createProcessRun({
      processId: def.id,
      sourceConversationId: null,
    })
    const pr = createPhaseRun({ runId: run.id, phaseId: phase.id })
    expect(pr.commandReceipt).toBeNull()

    const receipt: ProcessCommandReceipt = {
      version: 1,
      command: "pnpm test",
      cwd: null,
      environment: "local",
      status: "completed",
      exitCode: 0,
      signal: null,
      startedAt: 1,
      finishedAt: 2,
      stdout: "ok",
      stderr: "",
      outputTruncated: false,
      capturedOutputBytes: 2,
      observedOutputBytes: 2,
      error: null,
    }
    updatePhaseRun(pr.id, { commandReceipt: receipt })
    // Editing the definition afterwards never rewrites what ran.
    updatePhase(phase.id, { commandConfig: { ...test, command: "pnpm lint" } })
    expect(getPhaseRun(pr.id)?.commandReceipt).toEqual(receipt)
    updatePhaseRun(pr.id, { commandReceipt: null })
    expect(getPhaseRun(pr.id)?.commandReceipt).toBeNull()
  })
})

describe.skipIf(!sqliteLoads)("workspace checks (plan 104)", () => {
  const check = {
    source: "check" as const,
    check: "test",
    timeoutMs: 60_000,
    maxOutputBytes: 4096,
  }

  it("stores named checks per workspace, validated, with removal", () => {
    const ws = upsertWorkspace("/work/web")
    expect(ws.commandChecks).toEqual({})
    setWorkspaceCheck(ws.id, "Test", { command: " pnpm test ", cwd: "./app" })
    expect(getWorkspace(ws.id)?.commandChecks).toEqual({
      test: { command: "pnpm test", cwd: "app" },
    })
    expect(() =>
      setWorkspaceCheck(ws.id, "e2e", { command: "x", cwd: "../out" })
    ).toThrow(/inside the workspace/)
    expect(() =>
      setWorkspaceCheck(ws.id, "two words", { command: "x", cwd: null })
    ).toThrow(/lowercase letters/)
    setWorkspaceCheck(ws.id, "test", null)
    expect(getWorkspace(ws.id)?.commandChecks).toEqual({})
  })

  it("reads a stored literal config without a source as a literal command", () => {
    const def = definition()
    const phase = createPhase({
      processId: def.id,
      key: "t",
      name: "T",
      position: 0,
      kind: "command",
      commandConfig: test,
    })
    db.prepare("UPDATE process_phases SET command_config = ? WHERE id = ?").run(
      JSON.stringify({
        command: "pnpm test",
        cwd: null,
        timeoutMs: 60_000,
        maxOutputBytes: 4096,
      }),
      phase.id
    )
    expect(getPhase(phase.id)?.commandConfig).toEqual(test)
  })

  it("creates a check-mode command phase and rejects a bad check name", () => {
    const def = definition()
    const base = {
      processId: def.id,
      key: "t",
      name: "T",
      position: 0,
      kind: "command" as const,
    }
    expect(
      createPhase({ ...base, commandConfig: check }).commandConfig
    ).toEqual(check)
    expect(() =>
      createPhase({ ...base, key: "u", commandConfig: { ...check, check: "" } })
    ).toThrow(/needs a check name/)
  })

  it("collects required checks through sub-processes and reports the missing ones", () => {
    const child = definition("Child")
    createPhase({
      processId: child.id,
      key: "e2e",
      name: "E2E",
      position: 0,
      kind: "command",
      commandConfig: { ...check, check: "e2e" },
    })
    const parent = definition("Parent")
    createPhase({
      processId: parent.id,
      key: "t",
      name: "T",
      position: 0,
      kind: "command",
      commandConfig: check,
    })
    createPhase({
      processId: parent.id,
      key: "lit",
      name: "L",
      position: 1,
      kind: "command",
      commandConfig: test,
    })
    createPhase({
      processId: parent.id,
      key: "n",
      name: "N",
      position: 2,
      subprocessId: child.id,
    })

    expect(requiredChecks(parent.id)).toEqual(["e2e", "test"])
    const ws = upsertWorkspace("/work/web")
    setWorkspaceCheck(ws.id, "test", { command: "pnpm test", cwd: null })
    expect(commandCheckStatus(parent.id, getWorkspace(ws.id))).toMatchObject({
      required: ["e2e", "test"],
      missing: ["e2e"],
    })
    expect(commandCheckStatus(parent.id, undefined).missing).toEqual([
      "e2e",
      "test",
    ])
  })
})
