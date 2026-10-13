import { describe, it, expect, afterEach, vi } from "vitest"
import { mkdtemp, mkdir, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  executeProcessCommand,
  HeadTailBuffer,
  type CommandExecutorDeps,
} from "./command-executor"
import { LocalEnvironment } from "../../agent/env/local"
import { SHUTDOWN_ABORT_REASON } from "../../agent/abort"
import type { EnvConfig } from "../../agent/env/factory"
import type {
  CommandChunk,
  CommandExit,
  CommandSessionHandle,
  Environment,
} from "../../agent/env/types"
import type {
  ProcessCommandReceipt,
  ResolvedProcessCommand,
} from "../../db/types"

// The deterministic command executor (plan 104): it runs the persisted command
// through the Environment seam with policy, confinement, bounds, timeout, and
// cancellation — and never involves a model.

const CONFIG: ResolvedProcessCommand = {
  check: null,
  command: "pnpm test",
  cwd: null,
  timeoutMs: 60_000,
  maxOutputBytes: 4096,
}

// A scripted command session: tests push output and exit it by hand.
class FakeHandle implements CommandSessionHandle {
  dataCb: (chunk: CommandChunk) => void = () => {}
  exitCb: (exit: CommandExit) => void = () => {}
  interrupted = 0
  killed = 0
  onData(cb: (chunk: CommandChunk) => void) {
    this.dataCb = cb
  }
  onExit(cb: (exit: CommandExit) => void) {
    this.exitCb = cb
  }
  write() {}
  closeStdin() {}
  interrupt() {
    this.interrupted++
  }
  kill() {
    this.killed++
    this.exitCb({ exitCode: null, signal: "SIGKILL" })
  }
  out(text: string, stream: "stdout" | "stderr" = "stdout") {
    this.dataCb({ stream, data: Buffer.from(text) })
  }
}

function fakeEnv(opts: {
  handle?: FakeHandle
  spawnError?: Error
  resolveError?: Error
  notDirectory?: boolean
}) {
  const spawned: Array<{ command: string; cwd: string }> = []
  const env = {
    resolve: vi.fn(async (path: string) => {
      if (opts.resolveError && path) throw opts.resolveError
      return path ? `/ws/${path}` : "/ws"
    }),
    stat: vi.fn(async () => ({
      size: 0,
      isFile: () => !!opts.notDirectory,
      isDirectory: () => !opts.notDirectory,
    })),
    spawnCommand: vi.fn(async (command: string, o: { cwd: string }) => {
      spawned.push({ command, cwd: o.cwd })
      if (opts.spawnError) throw opts.spawnError
      return opts.handle!
    }),
    dispose: vi.fn(async () => {}),
  }
  return { env: env as unknown as Environment, raw: env, spawned }
}

function deps(
  env: Environment,
  patch: Partial<CommandExecutorDeps> = {}
): CommandExecutorDeps & { created: Array<[string, string, EnvConfig]> } {
  const created: Array<[string, string, EnvConfig]> = []
  return {
    created,
    getExecutionConfig: () => ({ kind: "local", profile: "host-access" }),
    createEnvironment: async (workspace, id, cfg) => {
      created.push([workspace, id, cfg])
      return env
    },
    decide: () => ({ level: "allow" }),
    repositoryBlocker: async () => undefined,
    ...patch,
  }
}

function run(
  d: CommandExecutorDeps,
  input: Partial<{
    config: ResolvedProcessCommand
    workspace: string | undefined
    signal: AbortSignal
  }> = {}
) {
  const started: ProcessCommandReceipt[] = []
  const progress: ProcessCommandReceipt[] = []
  const promise = executeProcessCommand(
    {
      config: input.config ?? CONFIG,
      workspace: "workspace" in input ? input.workspace : "/ws",
      phaseRunId: "pr-1",
      signal: input.signal ?? new AbortController().signal,
      onStart: (r) => started.push(r),
      onProgress: (r) => progress.push(r),
    },
    d
  )
  return { promise, started, progress }
}

// Let the executor reach its await on the command's exit.
const tick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe("executeProcessCommand", () => {
  it("runs the command in the workspace through the configured environment", async () => {
    const handle = new FakeHandle()
    const { env, raw, spawned } = fakeEnv({ handle })
    const d = deps(env)
    const r = run(d)
    await tick()
    handle.out("Tests: 3 passed\n")
    handle.out("warn: slow\n", "stderr")
    handle.exitCb({ exitCode: 0, signal: null })
    const result = await r.promise

    expect(d.created).toEqual([
      [
        "/ws",
        "process-command:pr-1",
        { kind: "local", profile: "host-access" },
      ],
    ])
    expect(spawned).toEqual([{ command: "pnpm test", cwd: "/ws" }])
    expect(r.started).toHaveLength(1)
    expect(r.started[0]).toMatchObject({ status: "running", finishedAt: null })
    expect(result.error).toBeUndefined()
    expect(result.receipt).toMatchObject({
      status: "completed",
      exitCode: 0,
      environment: "local",
      stdout: "Tests: 3 passed\n",
      stderr: "warn: slow\n",
      outputTruncated: false,
    })
    expect(raw.dispose).toHaveBeenCalledOnce()
  })

  it("selects the container backend from settings", async () => {
    const handle = new FakeHandle()
    const { env } = fakeEnv({ handle })
    const decide = vi.fn<CommandExecutorDeps["decide"]>(() => ({
      level: "allow",
    }))
    const container: EnvConfig = {
      kind: "container",
      runtime: "docker",
      image: "node:20",
    }
    const d = deps(env, { getExecutionConfig: () => container, decide })
    const r = run(d)
    await tick()
    handle.exitCb({ exitCode: 0, signal: null })
    const result = await r.promise
    expect(d.created[0][2]).toEqual(container)
    expect(decide.mock.calls[0][1]).toMatchObject({ sandboxed: true })
    expect(result.receipt?.environment).toBe("container")
  })

  it("reports a non-zero exit as a failure", async () => {
    const handle = new FakeHandle()
    const { env } = fakeEnv({ handle })
    const r = run(deps(env))
    await tick()
    handle.out("1 failed", "stderr")
    handle.exitCb({ exitCode: 1, signal: null })
    const result = await r.promise
    expect(result.code).toBe("command_failed")
    expect(result.receipt).toMatchObject({ status: "failed", exitCode: 1 })
  })

  it("fails before creating an environment when the run has no workspace", async () => {
    const { env } = fakeEnv({})
    const d = deps(env)
    const result = await run(d, { workspace: undefined }).promise
    expect(result).toMatchObject({
      receipt: null,
      code: "command_no_workspace",
    })
    expect(d.created).toEqual([])
  })

  it("never spawns a hard-blocked command", async () => {
    const { env, raw, spawned } = fakeEnv({ handle: new FakeHandle() })
    const r = run(
      deps(env, {
        decide: () => ({ level: "hard_block", reason: "catastrophic" }),
      }),
      { config: { ...CONFIG, command: "rm -rf /" } }
    )
    const result = await r.promise
    expect(result).toMatchObject({ receipt: null, code: "command_blocked" })
    expect(result.error).toContain("catastrophic")
    expect(spawned).toEqual([])
    expect(r.started).toEqual([])
    expect(raw.dispose).toHaveBeenCalledOnce()
  })

  it("runs a command that would only need approval, as an Auto-mode worker would", async () => {
    const handle = new FakeHandle()
    const { env, spawned } = fakeEnv({ handle })
    const r = run(
      deps(env, {
        decide: () => ({ level: "require_approval", reason: "risky" }),
      })
    )
    await tick()
    handle.exitCb({ exitCode: 0, signal: null })
    await r.promise
    expect(spawned).toHaveLength(1)
  })

  it("authorizes the same shell action identity the command tool uses", async () => {
    const handle = new FakeHandle()
    const { env } = fakeEnv({ handle })
    const decide = vi.fn(() => ({ level: "allow" as const }))
    const r = run(deps(env, { decide }))
    await tick()
    handle.exitCb({ exitCode: 0, signal: null })
    await r.promise
    const [action, ctx] = decide.mock.calls[0] as unknown as [
      { tool: string; kind: string; summary: string },
      { workspacePath: string },
    ]
    expect(action).toMatchObject({
      tool: "run_shell_tool",
      kind: "shell",
      summary: "$ pnpm test",
    })
    expect(ctx.workspacePath).toBe("/ws")
  })

  it("rejects a working directory the environment won't resolve", async () => {
    const { env, spawned } = fakeEnv({
      handle: new FakeHandle(),
      resolveError: new Error("Path escapes the workspace"),
    })
    const result = await run(deps(env), {
      config: { ...CONFIG, cwd: "linked-out" },
    }).promise
    expect(result.code).toBe("command_bad_cwd")
    expect(result.error).toContain("escapes the workspace")
    expect(spawned).toEqual([])
  })

  it("rejects a working directory that is a file", async () => {
    const { env } = fakeEnv({ handle: new FakeHandle(), notDirectory: true })
    const result = await run(deps(env), {
      config: { ...CONFIG, cwd: "package.json" },
    }).promise
    expect(result.code).toBe("command_bad_cwd")
  })

  it("does not run while a delegated subagent holds the repository", async () => {
    const { env, spawned } = fakeEnv({ handle: new FakeHandle() })
    const result = await run(
      deps(env, { repositoryBlocker: async () => ({ label: "busy: builder" }) })
    ).promise
    expect(result.code).toBe("repository_busy")
    expect(spawned).toEqual([])
  })

  it("reports a spawn error with the receipt it started", async () => {
    const { env } = fakeEnv({ spawnError: new Error("ENOENT") })
    const r = run(deps(env))
    const result = await r.promise
    expect(result.code).toBe("command_spawn_failed")
    expect(result.receipt).toMatchObject({
      status: "failed",
      error: expect.stringContaining("ENOENT"),
    })
  })

  it("fails a clean exit whose cleanup failed", async () => {
    const handle = new FakeHandle()
    const { env } = fakeEnv({ handle })
    const r = run(deps(env))
    await tick()
    handle.exitCb({
      exitCode: 0,
      signal: null,
      cleanupError: { path: "/tmp/script", error: "EACCES" },
    })
    const result = await r.promise
    expect(result.code).toBe("command_cleanup_failed")
    expect(result.receipt?.status).toBe("failed")
  })

  it("interrupts, then kills, a command past its timeout", async () => {
    vi.useFakeTimers()
    const handle = new FakeHandle()
    const { env } = fakeEnv({ handle })
    const r = run(deps(env), { config: { ...CONFIG, timeoutMs: 5_000 } })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(handle.interrupted).toBe(1)
    expect(handle.killed).toBe(0)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(handle.killed).toBe(1)
    const result = await r.promise
    expect(result.code).toBe("command_timed_out")
    expect(result.receipt?.status).toBe("timed_out")
  })

  it("terminates on cancel and reports it stopped", async () => {
    const handle = new FakeHandle()
    const { env } = fakeEnv({ handle })
    const abort = new AbortController()
    const r = run(deps(env), { signal: abort.signal })
    await tick()
    abort.abort()
    expect(handle.interrupted).toBe(1)
    handle.exitCb({ exitCode: null, signal: "SIGINT" })
    const result = await r.promise
    expect(result.stopped).toBe(true)
    expect(result.receipt?.status).toBe("cancelled")
  })

  it("marks a command stopped by an app quit as interrupted", async () => {
    const handle = new FakeHandle()
    const { env } = fakeEnv({ handle })
    const abort = new AbortController()
    const r = run(deps(env), { signal: abort.signal })
    await tick()
    abort.abort(SHUTDOWN_ABORT_REASON)
    handle.exitCb({ exitCode: null, signal: "SIGINT" })
    const result = await r.promise
    expect(result.stopped).toBe(true)
    expect(result.receipt?.status).toBe("interrupted")
  })

  it("caps captured output, keeping the start and the end", async () => {
    const handle = new FakeHandle()
    const { env } = fakeEnv({ handle })
    const r = run(deps(env), { config: { ...CONFIG, maxOutputBytes: 1024 } })
    await tick()
    handle.out("BEGIN\n")
    handle.out("x".repeat(10_000))
    handle.out("\nVERDICT: 2 failed\n")
    handle.exitCb({ exitCode: 1, signal: null })
    const receipt = (await r.promise).receipt!
    expect(receipt.outputTruncated).toBe(true)
    expect(receipt.observedOutputBytes).toBe(6 + 10_000 + 19)
    expect(receipt.capturedOutputBytes).toBeLessThanOrEqual(1024)
    expect(receipt.stdout.startsWith("BEGIN\n")).toBe(true)
    expect(receipt.stdout.endsWith("VERDICT: 2 failed\n")).toBe(true)
    expect(receipt.stdout).toContain("bytes omitted")
  })

  it("throttles live progress snapshots", async () => {
    vi.useFakeTimers()
    const handle = new FakeHandle()
    const { env } = fakeEnv({ handle })
    const r = run(deps(env, { now: () => Date.now() }))
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 50; i++) handle.out(`line ${i}\n`)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(r.progress.length).toBe(1)
    expect(r.progress[0].stdout).toContain("line 49")
    handle.exitCb({ exitCode: 0, signal: null })
    await r.promise
  })
})

describe("HeadTailBuffer", () => {
  it("never splits a multi-byte character", () => {
    const buf = new HeadTailBuffer(16)
    buf.push(Buffer.from("é".repeat(40)))
    expect(buf.text()).not.toContain("�")
  })
})

describe("executeProcessCommand with a real LocalEnvironment", () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  it.skipIf(process.platform === "win32")(
    "captures stdout and stderr separately with the real exit code",
    async () => {
      dir = await mkdtemp(join(tmpdir(), "process-command-"))
      await mkdir(join(dir, "sub"))
      const result = await executeProcessCommand(
        {
          config: {
            ...CONFIG,
            command: "pwd; echo to-err 1>&2; exit 3",
            cwd: "sub",
          },
          workspace: dir,
          phaseRunId: "pr-real",
          signal: new AbortController().signal,
          onStart: () => {},
          onProgress: () => {},
        },
        {
          getExecutionConfig: () => ({ kind: "local", profile: "host-access" }),
          createEnvironment: async (workspace) =>
            new LocalEnvironment(workspace, "host-access"),
          decide: () => ({ level: "allow" }),
          repositoryBlocker: async () => undefined,
        }
      )
      expect(result.receipt).toMatchObject({
        status: "failed",
        exitCode: 3,
        stderr: "to-err\n",
      })
      expect(result.receipt?.stdout.trim().endsWith("/sub")).toBe(true)
    }
  )
})
