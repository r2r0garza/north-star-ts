import { afterEach, describe, expect, it, vi } from "vitest"
import { resolve } from "path"
import { EventEmitter } from "events"
import {
  getTestResultsTool,
  runTestsTool,
  testDiagnosticsSessions,
  workspaceDiagnosticsTool,
} from "./test_diagnostics_tools"
import type { ToolContext } from "./types"
import type {
  CommandChunk,
  CommandExit,
  CommandSessionHandle,
  Environment,
  ExecOptions,
  ExecResult,
  SpawnCommandOptions,
  StatInfo,
} from "../env/types"

class FakeCommandHandle implements CommandSessionHandle {
  private readonly events = new EventEmitter()
  interruptCalls = 0
  killCalls = 0

  constructor(
    private readonly chunks: CommandChunk[],
    private readonly settleOnInterrupt = true,
    private readonly settleOnKill = true
  ) {}

  get exitListenerCount(): number {
    return this.events.listenerCount("exit")
  }

  start(): void {
    setTimeout(() => {
      for (const chunk of this.chunks) this.events.emit("data", chunk)
      this.emitExit({ exitCode: 0, signal: null })
    }, 0)
  }

  onData(cb: (chunk: CommandChunk) => void): void {
    this.events.on("data", cb)
  }

  onExit(cb: (exit: CommandExit) => void): void {
    this.events.on("exit", cb)
  }

  write(): void {}

  closeStdin(): void {}

  interrupt(): void {
    this.interruptCalls += 1
    if (this.settleOnInterrupt) {
      this.emitExit({ exitCode: null, signal: "SIGINT" })
    }
  }

  kill(): void {
    this.killCalls += 1
    if (this.settleOnKill) {
      this.emitExit({ exitCode: null, signal: "SIGKILL" })
    }
  }

  emitExit(exit: CommandExit): void {
    this.events.emit("exit", exit)
  }
}

function fakeEnv(opts: {
  packageJson?: Record<string, unknown>
  lockfile?: "pnpm-lock.yaml" | "yarn.lock" | "package-lock.json"
  execOutput?: string
  spawnOutput?: string
  neverExit?: boolean
  settleOnInterrupt?: boolean
  settleOnKill?: boolean
}): Environment & {
  execCommands: string[]
  spawnCommands: string[]
  handles: FakeCommandHandle[]
} {
  const execCommands: string[] = []
  const spawnCommands: string[] = []
  const handles: FakeCommandHandle[] = []
  return {
    execCommands,
    spawnCommands,
    handles,
    async resolve(path: string): Promise<string> {
      return resolve("/workspace", path || ".")
    },
    resolveLexical(path: string): string {
      return resolve("/workspace", path || ".")
    },
    async readFile(path: string): Promise<Buffer> {
      if (path.endsWith("package.json")) {
        return Buffer.from(JSON.stringify(opts.packageJson ?? {}), "utf8")
      }
      throw new Error("not found")
    },
    async stat(path: string): Promise<StatInfo> {
      const basename = path.split("/").pop()
      if (basename && basename === opts.lockfile) {
        return {
          size: 1,
          isFile: () => true,
          isDirectory: () => false,
        }
      }
      throw new Error("not found")
    },
    async exec(command: string, _opts: ExecOptions): Promise<ExecResult> {
      execCommands.push(command)
      return {
        stdout: Buffer.from(opts.execOutput ?? "", "utf8"),
        stderr: Buffer.alloc(0),
        exitCode: 1,
        signal: null,
        timedOut: false,
      }
    },
    async spawnCommand(
      command: string,
      _opts: SpawnCommandOptions
    ): Promise<CommandSessionHandle> {
      spawnCommands.push(command)
      const handle = new FakeCommandHandle(
        [
          {
            stream: "stdout",
            data: Buffer.from(opts.spawnOutput ?? "", "utf8"),
          },
        ],
        opts.settleOnInterrupt,
        opts.settleOnKill
      )
      handles.push(handle)
      if (!opts.neverExit) handle.start()
      return handle
    },
    async readTextLines(): Promise<never> {
      throw new Error("unused")
    },
    async writeFile(): Promise<void> {},
    async chmod(): Promise<void> {},
    async rename(): Promise<void> {},
    async removeFile(): Promise<void> {},
    async mkdirp(): Promise<void> {},
    async readdir(): Promise<[]> {
      return []
    },
    async search(): Promise<never> {
      throw new Error("unused")
    },
    async dispose(): Promise<void> {},
  } as Environment & {
    execCommands: string[]
    spawnCommands: string[]
    handles: FakeCommandHandle[]
  }
}

function ctx(
  env: Environment,
  overrides: Partial<ToolContext> = {}
): ToolContext {
  return {
    workspace: "/workspace",
    conversationId: "c1",
    env,
    gate: async () => "approved",
    ...overrides,
  }
}

function parsed(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>
}

afterEach(() => {
  testDiagnosticsSessions.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("workspace diagnostics and test tools", () => {
  it("runs a declared checker through the approval gate and parses TypeScript diagnostics", async () => {
    const env = fakeEnv({
      lockfile: "pnpm-lock.yaml",
      packageJson: { scripts: { typecheck: "tsc --noEmit" } },
      execOutput:
        "src/main/index.ts(12,8): error TS2322: Type 'string' is not assignable to type 'number'.\n",
    })
    const actions: Array<{ tool: string; summary: string }> = []
    const result = parsed(
      await workspaceDiagnosticsTool.execute(
        { target: "typecheck" },
        ctx(env, {
          gate: async (action) => {
            actions.push({ tool: action.tool, summary: action.summary })
            return "approved"
          },
        })
      )
    )

    expect(env.execCommands).toEqual(["pnpm run 'typecheck'"])
    expect(actions).toEqual([
      {
        tool: "workspace_diagnostics",
        summary: "workspace_diagnostics: typecheck",
      },
    ])
    expect(result.counts).toEqual({ errors: 1, warnings: 0, infos: 0 })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        path: "src/main/index.ts",
        line: 12,
        column: 8,
        severity: "error",
        code: "TS2322",
        source: "typescript",
      }),
    ])
  })

  it("rejects test execution when no declared test script exists", async () => {
    const env = fakeEnv({ packageJson: { scripts: { build: "vite build" } } })

    await expect(runTestsTool.execute({}, ctx(env))).resolves.toContain(
      "ERROR[no_provider]"
    )
    expect(env.spawnCommands).toEqual([])
  })

  it("starts a bounded test session and pages normalized results", async () => {
    const env = fakeEnv({
      packageJson: { scripts: { test: "vitest run" } },
      spawnOutput:
        " ✓ src/a.test.ts (2)\n   ✓ first 4ms\n   ✓ second 2ms\n ✓ src/b.test.ts (1)\n   - skipped case\n",
    })
    const started = parsed(
      await runTestsTool.execute({ yield_ms: 20 }, ctx(env))
    )

    expect(env.spawnCommands).toEqual(["npm run 'test'"])
    expect(started.status).toBe("completed")
    expect(started.counts).toEqual({
      total: 3,
      passed: 2,
      failed: 0,
      skipped: 1,
      todo: 0,
    })

    const page = parsed(
      await getTestResultsTool.execute(
        { session_id: started.sessionId, offset: 1, limit: 1 },
        ctx(env)
      )
    )

    expect(page.results).toEqual([
      expect.objectContaining({ name: "second", status: "passed" }),
    ])
    expect(page.hasMore).toBe(true)
    expect(page.nextOffset).toBe(2)
  })

  it("keeps test result sessions scoped to their conversation", async () => {
    const env = fakeEnv({
      packageJson: { scripts: { test: "vitest run" } },
      spawnOutput: " ✓ src/a.test.ts (1)\n   ✓ first\n",
    })
    const started = parsed(
      await runTestsTool.execute({ yield_ms: 20 }, ctx(env))
    )

    await expect(
      getTestResultsTool.execute(
        { session_id: started.sessionId },
        ctx(env, { conversationId: "other" })
      )
    ).resolves.toContain("ERROR[forbidden]")
  })

  it("keeps one exit listener after an initial timer-first yield", async () => {
    vi.useFakeTimers()
    const env = fakeEnv({
      packageJson: { scripts: { test: "vitest run" } },
      neverExit: true,
    })
    const pending = runTestsTool.execute({ yield_ms: 100 }, ctx(env))

    await vi.advanceTimersByTimeAsync(100)
    const started = parsed(await pending)

    expect(started.status).toBe("running")
    expect(env.handles[0].exitListenerCount).toBe(1)
    env.handles[0].emitExit({ exitCode: 0, signal: null })
    const completed = parsed(
      await getTestResultsTool.execute(
        { session_id: started.sessionId, include_raw_evidence: true },
        ctx(env)
      )
    )
    expect(completed.status).toBe("completed")
  })

  it("uses settlement for abort cleanup and avoids kill after interrupt exit", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const addSpy = vi.spyOn(controller.signal, "addEventListener")
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
    const env = fakeEnv({
      packageJson: { scripts: { test: "vitest run" } },
      neverExit: true,
    })
    const pending = runTestsTool.execute(
      { yield_ms: 100 },
      ctx(env, { signal: controller.signal })
    )

    await vi.advanceTimersByTimeAsync(100)
    const started = parsed(await pending)
    expect(env.handles[0].exitListenerCount).toBe(1)

    controller.abort()
    await Promise.resolve()
    await Promise.resolve()

    expect(env.handles[0].interruptCalls).toBe(1)
    expect(env.handles[0].killCalls).toBe(0)
    expect(env.handles[0].exitListenerCount).toBe(1)
    expect(addSpy).toHaveBeenCalledWith("abort", expect.any(Function), {
      once: true,
    })
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function))
    const completed = parsed(
      await getTestResultsTool.execute(
        { session_id: started.sessionId },
        ctx(env)
      )
    )
    expect(completed.status).toBe("terminated")
  })

  it("escalates an aborted test once after bounded grace periods", async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const env = fakeEnv({
      packageJson: { scripts: { test: "vitest run" } },
      neverExit: true,
      settleOnInterrupt: false,
      settleOnKill: false,
    })
    const pending = runTestsTool.execute(
      { yield_ms: 100 },
      ctx(env, { signal: controller.signal })
    )

    await vi.advanceTimersByTimeAsync(100)
    await pending
    controller.abort()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(env.handles[0].killCalls).toBe(1)
    expect(env.handles[0].exitListenerCount).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(env.handles[0].killCalls).toBe(1)
  })

  it("preserves the first diagnostic exit and schedules cleanup once", async () => {
    vi.useFakeTimers()
    const env = fakeEnv({
      packageJson: { scripts: { test: "vitest run" } },
      neverExit: true,
    })
    const pending = runTestsTool.execute({ yield_ms: 100 }, ctx(env))
    await vi.advanceTimersByTimeAsync(100)
    const started = parsed(await pending)
    const timersBeforeExit = vi.getTimerCount()

    env.handles[0].emitExit({ exitCode: 3, signal: null })
    env.handles[0].emitExit({
      exitCode: null,
      signal: "SIGKILL",
      cleanupError: { path: "/second", error: "ignored" },
    })
    const completed = parsed(
      await getTestResultsTool.execute(
        { session_id: started.sessionId },
        ctx(env)
      )
    )

    expect(completed).toMatchObject({ exitCode: 3, signal: null })
    expect(completed.cleanupError).toBeUndefined()
    expect(vi.getTimerCount() - timersBeforeExit).toBe(0)
  })

  it("does not expose arbitrary shell when only the test category is allowed", async () => {
    const env = fakeEnv({
      packageJson: { scripts: { test: "vitest run" } },
    })

    await runTestsTool.execute({ target: "test" }, ctx(env))

    expect(env.spawnCommands).toEqual(["npm run 'test'"])
  })
})
