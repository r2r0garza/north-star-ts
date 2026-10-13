import { describe, it, expect, beforeEach, vi } from "vitest"
import Database from "better-sqlite3"
import { randomUUID } from "crypto"
import { runMigrations } from "../../db/migrations"
import { sqliteLoadsForTests } from "../../test/sqlite"

const sqliteLoads = sqliteLoadsForTests()

let db: Database.Database
vi.mock("../../db/connection", () => ({ getDb: () => db }))

// Every model touchpoint is recorded: a command phase must reach none of them.
const { loopCalls, completionCalls, envCalls, spawnCalls, exitCodes } =
  vi.hoisted(() => ({
    loopCalls: [] as Array<{ userMessage?: string }>,
    completionCalls: [] as unknown[],
    envCalls: [] as Array<{ workspace: string; cfg: unknown }>,
    spawnCalls: [] as Array<{ command: string; cwd: string }>,
    // Exit codes for successive spawns; empty means 0.
    exitCodes: [] as number[],
  }))

vi.mock("../../agent", () => ({
  generateTitle: async () => "Title",
  runAgentLoop: async (input: {
    conversationId: string
    userMessage?: string
  }) => {
    loopCalls.push({ userMessage: input.userMessage })
    db.prepare(
      "INSERT INTO messages (id, conversation_id, seq, role, content, created_at) VALUES (?, ?, ?, 'assistant', ?, ?)"
    ).run(randomUUID(), input.conversationId, 1, "done", Date.now())
    return { content: "done" }
  },
}))
vi.mock("../../agent/providers", () => ({
  resolveLlm: () => ({ client: {}, model: "m", apiMode: "completions" }),
  createCompletion: async (...args: unknown[]) => {
    completionCalls.push(args)
    return { choices: [{ message: { content: "" } }] }
  },
  NoActiveProviderError: class extends Error {},
}))
vi.mock("../../agent/agents/loader", () => ({
  loadAgent: async (name: string) => ({ name, description: "" }),
}))
vi.mock("../../agent/env/factory", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../agent/env/factory")>()
  return {
    ...actual,
    createEnvironment: async (workspace: string, _id: string, cfg: unknown) => {
      envCalls.push({ workspace, cfg })
      return {
        resolve: async (path: string) =>
          path ? `${workspace}/${path}` : workspace,
        stat: async () => ({
          size: 0,
          isFile: () => false,
          isDirectory: () => true,
        }),
        spawnCommand: async (command: string, opts: { cwd: string }) => {
          spawnCalls.push({ command, cwd: opts.cwd })
          let exit: (e: unknown) => void = () => {}
          let data: (c: unknown) => void = () => {}
          setTimeout(() => {
            data({ stream: "stdout", data: Buffer.from("Tests: 4 passed\n") })
            exit({ exitCode: exitCodes.shift() ?? 0, signal: null })
          }, 0)
          return {
            onData: (cb: (c: unknown) => void) => (data = cb),
            onExit: (cb: (e: unknown) => void) => (exit = cb),
            write() {},
            closeStdin() {},
            interrupt() {},
            kill() {},
          }
        },
        dispose: async () => {},
      }
    },
  }
})

import * as processes from "../../db/repositories/processes"
import {
  setWorkspaceCheck,
  upsertWorkspace,
} from "../../db/repositories/workspaces"
import { ProcessService } from "./service"

beforeEach(() => {
  if (!sqliteLoads) return
  db = new Database(":memory:")
  runMigrations(db)
  loopCalls.length = 0
  completionCalls.length = 0
  envCalls.length = 0
  spawnCalls.length = 0
  exitCodes.length = 0
})

const fakeRunner = { restart: vi.fn(), enqueueKind: vi.fn() } as never

function seedTaskRow(): string {
  const convId = randomUUID()
  const taskId = randomUUID()
  const now = Date.now()
  db.prepare(
    "INSERT INTO conversations (id, mode, title, workspace_id, created_at, updated_at) VALUES (?, 'interactive', NULL, NULL, ?, ?)"
  ).run(convId, now, now)
  db.prepare(
    "INSERT INTO tasks (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at) VALUES (?, ?, ?, NULL, 'running', NULL, NULL, NULL, ?, ?)"
  ).run(taskId, convId, convId, now, now)
  return taskId
}

// Implement → Test (the workspace's `test` check) → Publish.
function shipProcess() {
  const def = processes.createProcessDefinition({ name: "Ship" })
  const ids = ["implement", "test", "publish"].map(
    (key, position) =>
      processes.createPhase({
        processId: def.id,
        key,
        name: key[0].toUpperCase() + key.slice(1),
        position,
        ...(key === "test"
          ? {
              kind: "command" as const,
              commandConfig: {
                source: "check" as const,
                check: "test",
                timeoutMs: 60_000,
                maxOutputBytes: 4096,
              },
            }
          : {}),
      }).id
  )
  processes.createEdge({
    processId: def.id,
    fromPhaseId: ids[0],
    toPhaseId: ids[1],
  })
  processes.createEdge({
    processId: def.id,
    fromPhaseId: ids[1],
    toPhaseId: ids[2],
  })
  return { processId: def.id, testPhaseId: ids[1] }
}

function runIn(processId: string, workspacePath: string) {
  const workspace = upsertWorkspace(workspacePath)
  return processes.createProcessRun({
    processId,
    sourceConversationId: null,
    workspaceId: workspace.id,
    taskId: seedTaskRow(),
    objective: "ship",
    status: "running",
  })
}

function drive(runId: string) {
  const run = processes.getProcessRun(runId)!
  return new ProcessService(fakeRunner).execute({
    task: { id: run.taskId!, input: { processRunId: runId } } as never,
    signal: new AbortController().signal,
    emit: () => {},
    workspace: undefined,
  })
}

describe.skipIf(!sqliteLoads)(
  "ProcessService command phases (plan 104)",
  () => {
    it("runs Implement → the workspace's test check → Publish with no model request", async () => {
      const { processId, testPhaseId } = shipProcess()
      setWorkspaceCheck(upsertWorkspace("/work/ship").id, "test", {
        command: "pnpm test",
        cwd: "app",
      })
      const run = runIn(processId, "/work/ship")

      expect(await drive(run.id)).toEqual({ content: "process complete" })

      // Two agent phases ran workers; the command phase ran none and made no
      // model request of any kind.
      expect(loopCalls).toHaveLength(2)
      expect(completionCalls).toHaveLength(0)
      expect(envCalls).toEqual([
        {
          workspace: "/work/ship",
          cfg: expect.objectContaining({ kind: "local" }),
        },
      ])
      expect(spawnCalls).toEqual([
        { command: "pnpm test", cwd: "/work/ship/app" },
      ])

      expect(processes.getProcessRun(run.id)?.commandSnapshot).toEqual({
        [testPhaseId]: {
          check: "test",
          command: "pnpm test",
          cwd: "app",
          timeoutMs: 60_000,
          maxOutputBytes: 4096,
        },
      })
      const testRun = processes
        .listPhaseRuns({ runId: run.id, parentId: null })
        .find((pr) => pr.phaseId === testPhaseId)!
      expect(testRun).toMatchObject({ status: "completed", taskId: null })
      expect(testRun.commandReceipt).toMatchObject({
        check: "test",
        exitCode: 0,
        stdout: "Tests: 4 passed\n",
      })

      // Publish received the bounded command result, marked as data.
      const publishPrompt = loopCalls[1].userMessage!
      expect(publishPrompt).toContain("### Test")
      expect(publishPrompt).toContain("trust=untrusted_data channel=command")
      expect(publishPrompt).toContain("DATA: Workspace check: test")
      expect(publishPrompt).toContain("DATA: Command: pnpm test")
      expect(publishPrompt).toContain("DATA: Tests: 4 passed")
    })

    it("runs each workspace's own command for the same process", async () => {
      const { processId } = shipProcess()
      setWorkspaceCheck(upsertWorkspace("/work/web").id, "test", {
        command: "pnpm test",
        cwd: null,
      })
      setWorkspaceCheck(upsertWorkspace("/work/engine").id, "test", {
        command: "cargo test",
        cwd: null,
      })
      await drive(runIn(processId, "/work/web").id)
      await drive(runIn(processId, "/work/engine").id)
      expect(spawnCalls.map((c) => c.command)).toEqual([
        "pnpm test",
        "cargo test",
      ])
    })

    it("refuses to start a run whose workspace lacks a check, with no default", async () => {
      const { processId } = shipProcess()
      await expect(
        new ProcessService(fakeRunner).startRun({
          processId,
          sourceConversationId: null,
          objective: "ship",
          workspacePath: "/work/new",
        })
      ).rejects.toThrow(/doesn't define the check “test”/)
      expect(processes.listProcessRuns({ processId })).toHaveLength(0)
    })

    it("fails a run before any phase when its workspace lacks a check at first drive", async () => {
      const { processId } = shipProcess()
      const run = runIn(processId, "/work/bare")
      expect(await drive(run.id)).toMatchObject({
        error: expect.stringContaining("“test”"),
      })
      expect(processes.getProcessRun(run.id)?.status).toBe("failed")
      expect(loopCalls).toHaveLength(0)
      expect(spawnCalls).toHaveLength(0)
    })

    it("freezes the command for the run, and re-resolves a fixed check on Retry", async () => {
      const { processId, testPhaseId } = shipProcess()
      const workspace = upsertWorkspace("/work/ship")
      setWorkspaceCheck(workspace.id, "test", {
        command: "pnpm tset",
        cwd: null,
      })
      const run = runIn(processId, "/work/ship")
      exitCodes.push(127)

      expect(await drive(run.id)).toMatchObject({
        error: "a process phase failed",
      })
      expect(processes.getProcessRun(run.id)?.status).toBe("failed")

      // Fixing the workspace check doesn't touch the frozen run...
      setWorkspaceCheck(workspace.id, "test", {
        command: "pnpm test",
        cwd: null,
      })
      expect(
        processes.getProcessRun(run.id)?.commandSnapshot?.[testPhaseId]?.command
      ).toBe("pnpm tset")
      // ...until the user retries, which resolves the check again.
      new ProcessService(fakeRunner).restartRun(run.id)
      expect(await drive(run.id)).toEqual({ content: "process complete" })

      expect(spawnCalls.map((c) => c.command)).toEqual([
        "pnpm tset",
        "pnpm test",
      ])
      // Implement completed the first time and was not re-run.
      expect(loopCalls).toHaveLength(2)
    })
  }
)
