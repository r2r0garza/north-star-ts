import { afterEach, describe, expect, it } from "vitest"
import { tmpdir } from "os"
import { access, mkdtemp, readFile, rm, symlink } from "fs/promises"
import { isAbsolute, join, relative, resolve } from "path"
import { EventEmitter } from "events"
import { PassThrough } from "stream"
import type { ChildProcess, spawn } from "child_process"
import {
  execCommandTool,
  pollCommandTool,
  terminateOwnedCommandSessions,
  terminateCommandTool,
  testCommandSessions,
  waitForEventsTool,
  writeStdinTool,
} from "./command_session_tools"
import { CommandCompletionInbox } from "../command-completion-inbox"
import { runShellTool } from "./run_shell_tool"
import { LocalEnvironment } from "../env/local"
import type {
  CommandChunk,
  CommandExit,
  CommandSessionHandle,
  Environment,
  SpawnCommandOptions,
} from "../env/types"
import type { ToolContext } from "./types"

const MODEL_OUTPUT_BYTES = 192 * 1024

const nodeCmd = (code: string) =>
  `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspace: tmpdir(),
    conversationId: "c1",
    gate: async () => "approved",
    ...overrides,
  }
}

function parseResult(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>
}

async function pollUntilTerminal(
  sessionId: string,
  cursor: number,
  opts: { deadlineMs?: number; intervalMs?: number } = {}
): Promise<Record<string, unknown>> {
  const deadlineAt = Date.now() + (opts.deadlineMs ?? 1_000)
  const intervalMs = opts.intervalMs ?? 20
  let last: Record<string, unknown> | undefined

  do {
    last = parseResult(
      await pollCommandTool.execute({ session_id: sessionId, cursor }, ctx())
    )
    if (last.status !== "running") return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  } while (Date.now() < deadlineAt)

  throw new Error(
    `Command session did not finish before deadline; last status was ${String(
      last?.status
    )}.`
  )
}

async function collectRecoverableOutput(
  first: Record<string, unknown>
): Promise<string> {
  let result = first
  let output = String(result.output ?? "")
  let cursor = Number(result.nextCursor ?? result.cursor)
  const totalBytes = Number(result.totalBytes)
  const sessionId = String(result.sessionId ?? "")

  while (cursor < totalBytes) {
    expect(sessionId).not.toBe("")
    result = parseResult(
      await pollCommandTool.execute(
        {
          session_id: sessionId,
          cursor,
          max_output_bytes: 1024 * 1024,
        },
        ctx()
      )
    )
    expect(Number(result.nextCursor ?? result.cursor)).toBeGreaterThan(cursor)
    output += String(result.output ?? "")
    cursor = Number(result.nextCursor ?? result.cursor)
  }

  return output
}

class FakeCommandHandle implements CommandSessionHandle {
  private dataCallbacks: Array<(chunk: CommandChunk) => void> = []
  private exitCallbacks: Array<(exit: CommandExit) => void> = []
  private killed = false

  constructor(private readonly chunks: CommandChunk[]) {}

  start(): void {
    setTimeout(() => {
      for (const chunk of this.chunks) {
        if (this.killed) return
        for (const cb of this.dataCallbacks) cb(chunk)
      }
      const exit = { exitCode: 0, signal: null }
      for (const cb of this.exitCallbacks) cb(exit)
    }, 0)
  }

  onData(cb: (chunk: CommandChunk) => void): void {
    this.dataCallbacks.push(cb)
  }

  onExit(cb: (exit: CommandExit) => void): void {
    this.exitCallbacks.push(cb)
  }

  write(): void {}

  closeStdin(): void {}

  interrupt(): void {
    this.killed = true
  }

  kill(): void {
    this.killed = true
  }
}

function fakeEnv(chunks: CommandChunk[]): Environment & {
  spawnedCwds: string[]
  resolvedPaths: string[]
} {
  const spawnedCwds: string[] = []
  const resolvedPaths: string[] = []
  return {
    spawnedCwds,
    resolvedPaths,
    async resolve(path: string): Promise<string> {
      const resolved = resolve("/workspace", path || ".")
      resolvedPaths.push(resolved)
      const rel = relative("/workspace", resolved)
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error("outside the workspace")
      }
      return resolved
    },
    resolveLexical(path: string): string {
      return resolve("/workspace", path || ".")
    },
    async spawnCommand(
      _command: string,
      opts: SpawnCommandOptions
    ): Promise<CommandSessionHandle> {
      spawnedCwds.push(opts.cwd)
      const handle = new FakeCommandHandle(chunks)
      handle.start()
      return handle
    },
  } as Environment & { spawnedCwds: string[]; resolvedPaths: string[] }
}

type FakeChildProcess = ChildProcess & {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
}

function fakeWindowsPythonSpawn(seen: {
  commands: string[]
  scripts: string[]
  neverExit?: boolean
  stdout?: string
}): typeof spawn {
  return ((command: string) => {
    const child = new EventEmitter() as FakeChildProcess
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    Object.defineProperty(child, "pid", { value: 12345 })
    child.kill = () => {
      setImmediate(() => {
        child.stdout.end()
        child.stderr.end()
        child.emit("close", null, "SIGKILL")
      })
      return true
    }

    setImmediate(async () => {
      seen.commands.push(command)
      const scriptPath = command.match(/^(?:py -3|python) "([^"]+)"$/)?.[1]
      if (scriptPath) {
        seen.scripts.push(scriptPath)
        child.stdout.write(seen.stdout ?? (await readFile(scriptPath, "utf8")))
      } else {
        child.stdout.write(command)
      }
      if (!seen.neverExit) {
        child.stdout.end()
        child.stderr.end()
        child.emit("close", 0, null)
      }
    })

    return child
  }) as typeof spawn
}

afterEach(() => {
  testCommandSessions.clear()
})

describe("command session tools", () => {
  it("returns completed output inline for quick commands", async () => {
    const result = parseResult(
      await execCommandTool.execute({ command: "echo hello" }, ctx())
    )

    expect(result.status).toBe("completed")
    expect(result.output).toContain("hello")
    expect(result.sessionId).toBeUndefined()
  })

  it("waits for foreground commands that outlast the old yield interval", async () => {
    const result = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd(
            "setTimeout(() => { process.stdout.write('done\\n'); process.exit(0) }, 80)"
          ),
          yield_ms: 1,
        },
        ctx()
      )
    )

    expect(result.status).toBe("completed")
    expect(result.output).toBe("done\n")
    expect(result.sessionId).toBeUndefined()
  })

  it("sends parsed shell analysis through the approval gate identity/detail", async () => {
    const seen: Array<{
      identity: string
      detail?: Record<string, unknown>
    }> = []
    const workspace = tmpdir()
    await execCommandTool.execute(
      { command: "echo hello > out.txt", yield_ms: 1000 },
      ctx({
        workspace,
        gate: async (action) => {
          seen.push({ identity: action.identity, detail: action.detail })
          return "approved"
        },
      })
    )

    expect(seen[0].identity).toContain('"write"')
    const analysis = seen[0].detail?.shellAnalysis as
      | {
          candidateWritePaths?: string[]
          segments?: Array<{ executable?: string }>
        }
      | undefined
    expect(analysis?.candidateWritePaths?.[0]).toContain("out.txt")
    expect(analysis?.segments?.map((s) => s.executable)).toEqual(["echo"])
  })

  it("resolves cwd through the environment before approval and spawn", async () => {
    const env = fakeEnv([
      { stream: "stdout", data: Buffer.from("ok\n", "utf8") },
    ])
    const seen: Array<{ cwd?: string; workspace?: string }> = []

    await execCommandTool.execute(
      { command: "pwd", cwd: "nested", yield_ms: 10 },
      ctx({
        env,
        gate: async (action) => {
          const detail = action.detail as
            | { cwd?: string; workspace?: string }
            | undefined
          seen.push({
            cwd: detail?.cwd,
            workspace: detail?.workspace,
          })
          return "approved"
        },
      })
    )

    expect(seen).toEqual([
      { cwd: "/workspace/nested", workspace: "/workspace" },
    ])
    expect(env.spawnedCwds).toEqual(["/workspace/nested"])
  })

  it.skipIf(process.platform === "win32")(
    "rejects a cwd symlink that resolves outside the workspace before approval",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "cmd-cwd-ws-"))
      const external = await mkdtemp(join(tmpdir(), "cmd-cwd-external-"))
      let gateCalls = 0
      try {
        await symlink(external, join(workspace, "link"))

        const result = await execCommandTool.execute(
          { command: "pwd", cwd: "link", yield_ms: 10 },
          ctx({
            workspace,
            gate: async () => {
              gateCalls += 1
              return "approved"
            },
          })
        )

        expect(result).toContain("ERROR[bad_cwd]")
        expect(gateCalls).toBe(0)
        expect(testCommandSessions.size).toBe(0)
      } finally {
        await rm(workspace, { recursive: true, force: true })
        await rm(external, { recursive: true, force: true })
      }
    }
  )

  it("materializes Windows Python heredocs for exec_command sessions and cleans them up", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cmd-heredoc-ws-"))
    const seen = { commands: [] as string[], scripts: [] as string[] }
    try {
      const env = new LocalEnvironment(workspace, "host-access", {
        platform: "win32",
        spawn: fakeWindowsPythonSpawn(seen),
      })

      const result = parseResult(
        await execCommandTool.execute(
          {
            command: "python3 - <<'PY'\nprint('from heredoc')\nPY",
            yield_ms: 1000,
          },
          ctx({ workspace, env })
        )
      )

      expect(result.status).toBe("completed")
      expect(result.output).toBe("print('from heredoc')")
      expect(seen.commands[0]).toMatch(
        /^py -3 ".*cowork-python-heredoc-.*\.py"$/
      )
      await expect(access(seen.scripts[0])).rejects.toThrow()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("reports materialized heredoc cleanup failures without echoing script contents", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cmd-heredoc-leak-ws-"))
    const seen = {
      commands: [] as string[],
      scripts: [] as string[],
      stdout: "done",
    }
    try {
      const env = new LocalEnvironment(workspace, "host-access", {
        platform: "win32",
        spawn: fakeWindowsPythonSpawn(seen),
        unlinkTempFile: async (path) => {
          throw new Error(`injected unlink failure for ${path}`)
        },
      })

      const result = parseResult(
        await execCommandTool.execute(
          {
            command:
              "python3 - <<'PY'\nSECRET = 'do-not-echo'\nprint('done')\nPY",
            yield_ms: 1000,
          },
          ctx({ workspace, env })
        )
      )

      expect(result.status).toBe("completed")
      expect(result.cleanupError).toMatchObject({
        path: seen.scripts[0],
      })
      expect(JSON.stringify(result.cleanupError)).not.toContain("do-not-echo")
      await expect(access(seen.scripts[0])).resolves.toBeUndefined()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("cleans up materialized Windows Python heredocs when a session times out", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cmd-heredoc-timeout-ws-"))
    const seen = {
      commands: [] as string[],
      scripts: [] as string[],
      neverExit: true,
    }
    try {
      const env = new LocalEnvironment(workspace, "host-access", {
        platform: "win32",
        spawn: fakeWindowsPythonSpawn(seen),
      })

      const result = parseResult(
        await execCommandTool.execute(
          {
            command: "python3 - <<'PY'\nprint('slow')\nPY",
            timeout_ms: 10,
            yield_ms: 100,
          },
          ctx({ workspace, env })
        )
      )

      expect(result.status).toBe("timed_out")
      await expect(access(seen.scripts[0])).rejects.toThrow()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("cleans up materialized Windows Python heredocs when a session is stopped", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cmd-heredoc-stop-ws-"))
    const seen = {
      commands: [] as string[],
      scripts: [] as string[],
      neverExit: true,
    }
    try {
      const env = new LocalEnvironment(workspace, "host-access", {
        platform: "win32",
        spawn: fakeWindowsPythonSpawn(seen),
      })

      const started = parseResult(
        await execCommandTool.execute(
          {
            command: "python3 - <<'PY'\nprint('stoppable')\nPY",
            timeout_ms: 5000,
            background: true,
          },
          ctx({ workspace, env })
        )
      )
      expect(started.status).toBe("running")

      await terminateCommandTool.execute(
        { session_id: String(started.sessionId) },
        ctx({ workspace, env })
      )

      await expect(access(seen.scripts[0])).rejects.toThrow()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("materializes Windows Python heredocs for run_shell_tool compatibility and cleans them up", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "run-shell-heredoc-ws-"))
    const seen = { commands: [] as string[], scripts: [] as string[] }
    try {
      const env = new LocalEnvironment(workspace, "host-access", {
        platform: "win32",
        spawn: fakeWindowsPythonSpawn(seen),
      })

      const result = await runShellTool.execute(
        { command: "python - <<PY\nprint('compat')\nPY", timeout_ms: 5000 },
        ctx({ workspace, env })
      )

      expect(result).toContain("[exit code 0]")
      expect(result).toContain("print('compat')")
      expect(seen.commands[0]).toMatch(
        /^python ".*cowork-python-heredoc-.*\.py"$/
      )
      await expect(access(seen.scripts[0])).rejects.toThrow()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("reports run_shell heredoc cleanup failures with execution status", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "run-shell-heredoc-leak-ws-")
    )
    const seen = {
      commands: [] as string[],
      scripts: [] as string[],
      stdout: "compat",
    }
    try {
      const env = new LocalEnvironment(workspace, "host-access", {
        platform: "win32",
        spawn: fakeWindowsPythonSpawn(seen),
        unlinkTempFile: async (path) => {
          throw new Error(`injected unlink failure for ${path}`)
        },
      })

      const result = await runShellTool.execute(
        {
          command: "python - <<PY\nSECRET = 'do-not-echo'\nprint('compat')\nPY",
          timeout_ms: 5000,
        },
        ctx({ workspace, env })
      )

      expect(result).toContain("ERROR[cleanup_failed]")
      expect(result).toContain("Command finished with exit code 0")
      expect(result).toContain(seen.scripts[0])
      expect(result).not.toContain("do-not-echo")
      await expect(access(seen.scripts[0])).resolves.toBeUndefined()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("leaves non-heredoc Windows commands unchanged except python3 launcher normalization", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cmd-no-heredoc-ws-"))
    const seen = { commands: [] as string[], scripts: [] as string[] }
    try {
      const env = new LocalEnvironment(workspace, "host-access", {
        platform: "win32",
        spawn: fakeWindowsPythonSpawn(seen),
      })

      const result = parseResult(
        await execCommandTool.execute(
          { command: 'python3 -c "print(1)"', yield_ms: 1000 },
          ctx({ workspace, env })
        )
      )

      expect(result.status).toBe("completed")
      expect(result.output).toBe('py -3 -c "print(1)"')
      expect(seen.scripts).toEqual([])
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("returns a running session and polls without duplicate output", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd(
            "process.stdout.write('one\\n'); setTimeout(() => process.stdout.write('two\\n'), 200); setTimeout(() => process.exit(0), 280)"
          ),
          background: true,
        },
        ctx()
      )
    )

    expect(started.status).toBe("running")
    const sessionId = String(started.sessionId)

    const polled = await pollUntilTerminal(sessionId, Number(started.cursor))

    expect(polled.status).toBe("completed")
    expect(String(polled.output)).toContain("one")
    expect(String(polled.output)).toContain("two")
  })

  it("waits for background command completion events without polling", async () => {
    const inbox = new CommandCompletionInbox()
    const owner = {
      conversationId: "c1",
      workspace: tmpdir(),
      runId: "run-1",
    }
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd(
            "setTimeout(() => { process.stdout.write('event done\\n'); process.exit(0) }, 40)"
          ),
          background: true,
        },
        ctx({
          workspace: owner.workspace,
          commandCompletions: inbox,
          commandCompletionOwner: owner,
        })
      )
    )
    inbox.markInitialResultPersisted(owner, String(started.sessionId))

    const waited = parseResult(
      await waitForEventsTool.execute(
        { session_ids: [String(started.sessionId)] },
        ctx({
          workspace: owner.workspace,
          commandCompletions: inbox,
          commandCompletionOwner: owner,
        })
      )
    )

    expect(waited.status).toBe("completed")
    const completions = waited.completions as Array<Record<string, unknown>>
    expect(completions).toHaveLength(1)
    expect(completions[0].sessionId).toBe(started.sessionId)
    expect(completions[0].status).toBe("completed")
    expect(completions[0].output).toBe("event done\n")
  })

  it("does not expose completion events across run owners", async () => {
    const inbox = new CommandCompletionInbox()
    const owner = {
      conversationId: "c1",
      workspace: tmpdir(),
      runId: "run-1",
    }
    const otherOwner = { ...owner, conversationId: "c2", runId: "run-2" }
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd("process.stdout.write('secret\\n')"),
          background: true,
        },
        ctx({
          workspace: owner.workspace,
          commandCompletions: inbox,
          commandCompletionOwner: owner,
        })
      )
    )
    inbox.markInitialResultPersisted(owner, String(started.sessionId))
    await new Promise((resolve) => setTimeout(resolve, 40))

    const forged = parseResult(
      await waitForEventsTool.execute(
        { session_ids: [String(started.sessionId)] },
        ctx({
          workspace: owner.workspace,
          conversationId: otherOwner.conversationId,
          commandCompletions: inbox,
          commandCompletionOwner: otherOwner,
        })
      )
    )
    const valid = parseResult(
      await waitForEventsTool.execute(
        { session_ids: [String(started.sessionId)] },
        ctx({
          workspace: owner.workspace,
          commandCompletions: inbox,
          commandCompletionOwner: owner,
        })
      )
    )

    expect(forged.status).toBe("empty")
    expect(valid.status).toBe("completed")
  })

  it("keeps completed command output pageable when the model page cap is hit", async () => {
    const expected = Array.from(
      { length: 320 },
      (_, i) => `marker-${String(i).padStart(3, "0")}-${"x".repeat(700)}\n`
    ).join("")

    const started = parseResult(
      await execCommandTool.execute(
        {
          command: "fake",
          max_output_bytes: 1024 * 1024,
          yield_ms: 10,
        },
        ctx({
          env: fakeEnv([
            { stream: "stdout", data: Buffer.from(expected, "utf8") },
          ]),
        })
      )
    )

    expect(started.status).toBe("completed")
    expect(started.sessionId).toBeTruthy()
    expect(started.modelTruncated).toBe(true)
    expect(started.omittedBytes).toBeGreaterThan(0)
    expect(started.cursor).toBe(started.nextCursor)
    expect(Number(started.cursor)).toBeLessThan(Number(started.totalBytes))

    await expect(collectRecoverableOutput(started)).resolves.toBe(expected)
  })

  it("paginates running command output without advancing past omitted bytes", async () => {
    const prefix = "running-page-start\n"
    const body = "y".repeat(220 * 1024)
    const suffix = "\nrunning-page-end\n"
    const expected = `${prefix}${body}${suffix}`

    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd(
            `process.stdout.write(${JSON.stringify(expected)}); setTimeout(() => {}, 1000)`
          ),
          max_output_bytes: 1024 * 1024,
          background: true,
        },
        ctx()
      )
    )

    await new Promise((resolve) => setTimeout(resolve, 100))
    const withOutput = parseResult(
      await pollCommandTool.execute(
        {
          session_id: String(started.sessionId),
          max_output_bytes: 1024 * 1024,
        },
        ctx()
      )
    )

    expect(withOutput.status).toBe("running")
    expect(withOutput.modelTruncated).toBe(true)
    expect(withOutput.omittedBytes).toBeGreaterThan(0)
    expect(String(withOutput.output)).toContain(prefix)
    expect(String(withOutput.output)).not.toContain(suffix)

    await expect(collectRecoverableOutput(withOutput)).resolves.toBe(expected)
    await terminateCommandTool.execute(
      {
        session_id: String(started.sessionId),
        cursor: Number(withOutput.cursor),
      },
      ctx()
    )
  })

  it("keeps bounded polling failures quick for non-terminating sessions", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd("setTimeout(() => {}, 5000)"),
          background: true,
        },
        ctx()
      )
    )

    await expect(
      pollUntilTerminal(String(started.sessionId), Number(started.cursor), {
        deadlineMs: 80,
        intervalMs: 10,
      })
    ).rejects.toThrow("did not finish before deadline")
  })

  it("writes stdin and EOF to a running command", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd(
            "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { process.stdout.write(data.toUpperCase()); })"
          ),
          background: true,
        },
        ctx()
      )
    )

    const result = parseResult(
      await writeStdinTool.execute(
        {
          session_id: String(started.sessionId),
          text: "abc",
          eof: true,
          cursor: Number(started.cursor),
          yield_ms: 500,
        },
        ctx()
      )
    )

    expect(result.status).toBe("completed")
    expect(result.output).toBe("ABC")
  })

  it("does not corrupt UTF-8 when output is capped", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd("process.stdout.write('日本語')"),
          max_output_bytes: 5,
          yield_ms: 500,
        },
        ctx()
      )
    )

    expect(started.status).toBe("completed")
    expect(started.truncated).toBe(true)
    expect(String(started.output)).not.toContain("�")
  })

  it("retains the tail of a single output chunk larger than the session cap", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: "fake",
          max_output_bytes: 4,
          yield_ms: 10,
        },
        ctx({
          env: fakeEnv([
            { stream: "stdout", data: Buffer.from("abcdefgh", "utf8") },
          ]),
        })
      )
    )

    expect(started.status).toBe("completed")
    expect(started.output).toBe("efgh")
    expect(started.cursor).toBe(8)
    expect(started.totalBytes).toBe(8)
    expect(started.droppedBytes).toBe(4)
    expect(started.omittedBytes).toBe(0)
    expect(started.modelTruncated).toBe(false)
    expect(started.truncated).toBe(true)
  })

  it("trims capped session output to a UTF-8-safe suffix", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: "fake",
          max_output_bytes: 5,
          yield_ms: 10,
        },
        ctx({
          env: fakeEnv([
            { stream: "stdout", data: Buffer.from("日本語", "utf8") },
          ]),
        })
      )
    )

    expect(started.output).toBe("語")
    expect(String(started.output)).not.toContain("�")
    expect(started.cursor).toBe(9)
    expect(started.totalBytes).toBe(9)
    expect(started.droppedBytes).toBe(6)
    expect(started.truncated).toBe(true)
  })

  it("paginates multi-byte UTF-8 output without gaps or replacement characters", async () => {
    const expected = `${"日本語".repeat(25_000)}done\n`
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: "fake",
          max_output_bytes: 1024 * 1024,
          yield_ms: 10,
        },
        ctx({
          env: fakeEnv([
            { stream: "stdout", data: Buffer.from(expected, "utf8") },
          ]),
        })
      )
    )

    expect(started.modelTruncated).toBe(true)
    expect(String(started.output)).not.toContain("�")
    const reconstructed = await collectRecoverableOutput(started)
    expect(reconstructed).toBe(expected)
    expect(reconstructed).not.toContain("�")
  })

  it("caps the complete serialized command result across JSON expansion cases", async () => {
    const cases: Array<{ name: string; raw: string; expected: string }> = [
      {
        name: "quotes",
        raw: '"'.repeat(230 * 1024),
        expected: '"'.repeat(230 * 1024),
      },
      {
        name: "backslashes",
        raw: "\\".repeat(230 * 1024),
        expected: "\\".repeat(230 * 1024),
      },
      {
        name: "newlines",
        raw: "\n".repeat(230 * 1024),
        expected: "\n".repeat(230 * 1024),
      },
      {
        name: "controls",
        raw: "\u0001\t".repeat(120 * 1024),
        expected: "\u0001\t".repeat(120 * 1024),
      },
      {
        name: "ordinary ASCII",
        raw: "a".repeat(230 * 1024),
        expected: "a".repeat(230 * 1024),
      },
      {
        name: "ANSI",
        raw: `\u001b[31m${"ansi\n".repeat(48 * 1024)}\u001b[0m`,
        expected: "ansi\n".repeat(48 * 1024),
      },
      {
        name: "UTF-8",
        raw: "日本語".repeat(30 * 1024),
        expected: "日本語".repeat(30 * 1024),
      },
    ]

    for (const item of cases) {
      const startedText = await execCommandTool.execute(
        {
          command: "fake",
          max_output_bytes: 1024 * 1024,
          yield_ms: 10,
        },
        ctx({
          env: fakeEnv([
            { stream: "pty", data: Buffer.from(item.raw, "utf8") },
          ]),
        })
      )
      const started = parseResult(startedText)

      expect(
        Buffer.byteLength(startedText, "utf8"),
        `${item.name} initial result exceeded serialized cap`
      ).toBeLessThanOrEqual(MODEL_OUTPUT_BYTES)
      expect(started.modelTruncated, item.name).toBe(true)
      expect(started.omittedBytes, item.name).toBeGreaterThan(0)

      let result = started
      while (
        Number(result.nextCursor ?? result.cursor) < Number(result.totalBytes)
      ) {
        const polledText = await pollCommandTool.execute(
          {
            session_id: String(result.sessionId),
            cursor: Number(result.nextCursor ?? result.cursor),
            max_output_bytes: 1024 * 1024,
          },
          ctx()
        )
        expect(
          Buffer.byteLength(polledText, "utf8"),
          `${item.name} polled result exceeded serialized cap`
        ).toBeLessThanOrEqual(MODEL_OUTPUT_BYTES)
        result = parseResult(polledText)
      }

      await expect(collectRecoverableOutput(started)).resolves.toBe(
        item.expected
      )
    }
  })

  it("keeps visible ANSI-stripped output pageable across model-capped pages", async () => {
    const expected = Array.from(
      { length: 12_000 },
      (_, i) => `ansi-${String(i).padStart(3, "0")}\n`
    ).join("")
    const raw = expected.replace(/^(.+)$/gm, "\u001b[31m$1\u001b[0m")

    const started = parseResult(
      await execCommandTool.execute(
        {
          command: "fake",
          max_output_bytes: 1024 * 1024,
          yield_ms: 10,
        },
        ctx({
          env: fakeEnv([{ stream: "pty", data: Buffer.from(raw, "utf8") }]),
        })
      )
    )

    expect(String(started.output)).not.toContain("\u001b")
    expect(started.modelTruncated).toBe(true)
    const reconstructed = await collectRecoverableOutput(started)
    expect(reconstructed).toContain("ansi-000")
    expect(reconstructed).toContain("ansi-11999")
    expect(reconstructed).not.toContain("\u001b")
  })

  it("preserves stream order while partially trimming the oldest chunk", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: "fake",
          max_output_bytes: 6,
          yield_ms: 10,
        },
        ctx({
          env: fakeEnv([
            { stream: "stdout", data: Buffer.from("abcd", "utf8") },
            { stream: "stderr", data: Buffer.from("EF", "utf8") },
            { stream: "stdout", data: Buffer.from("GH", "utf8") },
          ]),
        })
      )
    )

    expect(started.output).toBe("cdEFGH")
    expect(started.cursor).toBe(8)
    expect(started.totalBytes).toBe(8)
    expect(started.droppedBytes).toBe(2)
    expect(started.truncated).toBe(true)
  })

  it("does not render replacement characters when polling from inside UTF-8", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd(
            "process.stdout.write('日本語'); setTimeout(() => {}, 1000)"
          ),
          max_output_bytes: 32,
          background: true,
        },
        ctx()
      )
    )

    await new Promise((resolve) => setTimeout(resolve, 100))

    const polled = parseResult(
      await pollCommandTool.execute(
        {
          session_id: String(started.sessionId),
          cursor: 1,
          max_output_bytes: 32,
        },
        ctx()
      )
    )

    expect(polled.output).toBe("本語")
    expect(String(polled.output)).not.toContain("�")
    expect(polled.cursor).toBe(9)
    expect(polled.truncated).toBe(true)
  })

  it("rejects sessions from another conversation", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd("setTimeout(() => {}, 1000)"),
          background: true,
        },
        ctx()
      )
    )

    const result = await pollCommandTool.execute(
      { session_id: String(started.sessionId) },
      ctx({ conversationId: "c2" })
    )

    expect(result).toContain("ERROR[forbidden]")
  })

  it("terminates a running command", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd("setTimeout(() => {}, 5000)"),
          background: true,
        },
        ctx()
      )
    )

    const result = parseResult(
      await terminateCommandTool.execute(
        { session_id: String(started.sessionId) },
        ctx()
      )
    )

    expect(result.status).toBe("terminated")
  })

  it("terminates running background commands owned by a cancelled run", async () => {
    const inbox = new CommandCompletionInbox()
    const owner = {
      conversationId: "c1",
      workspace: tmpdir(),
      runId: "run-cancel",
    }
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd("setTimeout(() => {}, 5000)"),
          background: true,
        },
        ctx({
          workspace: owner.workspace,
          commandCompletions: inbox,
          commandCompletionOwner: owner,
        })
      )
    )

    inbox.cancelRun(owner)
    await terminateOwnedCommandSessions(owner)

    const stopped = parseResult(
      await pollCommandTool.execute(
        { session_id: String(started.sessionId) },
        ctx({ workspace: owner.workspace })
      )
    )
    expect(stopped.status).toBe("terminated")

    const events = parseResult(
      await waitForEventsTool.execute(
        { session_ids: [String(started.sessionId)] },
        ctx({
          workspace: owner.workspace,
          commandCompletions: inbox,
          commandCompletionOwner: owner,
        })
      )
    )
    expect(events.status).toBe("empty")
  })
})
