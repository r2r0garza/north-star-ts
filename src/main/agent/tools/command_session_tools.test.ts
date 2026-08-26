import { afterEach, describe, expect, it } from "vitest"
import { tmpdir } from "os"
import {
  execCommandTool,
  pollCommandTool,
  terminateCommandTool,
  testCommandSessions,
  writeStdinTool,
} from "./command_session_tools"
import type { ToolContext } from "./types"

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

afterEach(() => {
  testCommandSessions.clear()
})

describe("command session tools", () => {
  it("returns completed output inline for quick commands", async () => {
    const result = parseResult(
      await execCommandTool.execute(
        { command: "echo hello", yield_ms: 1000 },
        ctx()
      )
    )

    expect(result.status).toBe("completed")
    expect(result.output).toContain("hello")
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

  it("returns a running session and polls without duplicate output", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd(
            "process.stdout.write('one\\n'); setTimeout(() => process.stdout.write('two\\n'), 200); setTimeout(() => process.exit(0), 280)"
          ),
          yield_ms: 80,
        },
        ctx()
      )
    )

    expect(started.status).toBe("running")
    expect(started.output).toBe("one\n")
    const sessionId = String(started.sessionId)
    const cursor = Number(started.cursor)

    await new Promise((resolve) => setTimeout(resolve, 250))
    const polled = parseResult(
      await pollCommandTool.execute({ session_id: sessionId, cursor }, ctx())
    )

    expect(polled.status).toBe("completed")
    expect(String(polled.output)).toContain("two")
    expect(String(polled.output)).not.toContain("one")
  })

  it("writes stdin and EOF to a running command", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        {
          command: nodeCmd(
            "let data=''; process.stdin.on('data', c => data += c); process.stdin.on('end', () => { process.stdout.write(data.toUpperCase()); })"
          ),
          yield_ms: 10,
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

  it("rejects sessions from another conversation", async () => {
    const started = parseResult(
      await execCommandTool.execute(
        { command: nodeCmd("setTimeout(() => {}, 1000)"), yield_ms: 10 },
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
        { command: nodeCmd("setTimeout(() => {}, 5000)"), yield_ms: 10 },
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
})
