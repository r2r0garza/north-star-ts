import { randomUUID } from "crypto"
import { stripAnsi } from "../approval/ansi"
import { shellActionForCommand } from "../approval/shell-analyzer"
import { LocalEnvironment } from "../env/local"
import type { CommandExit, CommandSessionHandle } from "../env/types"
import { truncateForModel, toolError } from "./output"
import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_YIELD_MS = 1_000
const MAX_YIELD_MS = 30_000
const DEFAULT_OUTPUT_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024
const COMPLETED_SESSION_TTL_MS = 5 * 60_000
const TERMINATE_GRACE_MS = 1_500

type CommandStatus = "running" | "completed" | "timed_out" | "terminated"

interface OutputChunk {
  stream: "stdout" | "stderr" | "pty"
  start: number
  end: number
  data: Buffer
}

interface AgentCommandSession {
  id: string
  conversationId: string
  workspace: string
  command: string
  cwd: string
  handle: CommandSessionHandle
  createdAt: number
  totalBytes: number
  droppedBytes: number
  maxOutputBytes: number
  chunks: OutputChunk[]
  status: CommandStatus
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  timeout: NodeJS.Timeout
  cleanup?: NodeJS.Timeout
}

interface RenderedOutput {
  output: string
  cursor: number
  totalBytes: number
  droppedBytes: number
  truncated: boolean
  chunks: Array<{ stream: "stdout" | "stderr" | "pty"; text: string }>
}

const sessions = new Map<string, AgentCommandSession>()

export const execCommandTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "exec_command",
      description:
        "Run a shell command in the workspace. Quick commands return completed output inline; long-running commands return a session id that can be polled, written to, or terminated.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: {
            type: "string",
            description:
              "Optional workspace-relative working directory. Defaults to the workspace root.",
          },
          timeout_ms: {
            type: "integer",
            description:
              "Maximum lifetime in milliseconds. Defaults to 30000; capped at 600000.",
          },
          yield_ms: {
            type: "integer",
            description:
              "How long to wait for initial output before returning a running session. Defaults to 1000; capped at 30000.",
          },
          max_output_bytes: {
            type: "integer",
            description:
              "Maximum buffered output bytes for this command session. Defaults to 65536; capped at 1048576.",
          },
          tty: {
            type: "boolean",
            description:
              "Run under a pseudo-terminal when true. Defaults to false.",
          },
        },
        required: ["command"],
      },
    },
  },
  execute: async (args, ctx) => {
    const result = await startCommand(args, ctx, { compatibility: false })
    if ("error" in result) return result.error
    return renderCommandResult(result.session, result.output, {
      includeSessionId: result.session.status === "running",
    })
  },
}

export const writeStdinTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "write_stdin",
      description:
        "Write text or control bytes to a running command session, optionally close stdin, then return newly available output.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          text: { type: "string" },
          eof: { type: "boolean" },
          cursor: { type: "integer" },
          yield_ms: { type: "integer" },
        },
        required: ["session_id"],
      },
    },
  },
  execute: async (args, ctx) => {
    const session = getOwnedSession(args.session_id, ctx)
    if ("error" in session) return session.error
    if (session.session.status !== "running") {
      return pollSessionResult(session.session, numberArg(args.cursor, 0))
    }
    const text = typeof args.text === "string" ? args.text : ""
    if (text) session.session.handle.write(text)
    if (args.eof === true) session.session.handle.closeStdin()
    await waitForSettle(session.session, yieldMs(args.yield_ms))
    return pollSessionResult(session.session, numberArg(args.cursor, 0))
  },
}

export const pollCommandTool: Tool = {
  effects: TOOL_EFFECTS.openWorldRead,
  definition: {
    type: "function",
    function: {
      name: "poll_command",
      description:
        "Poll a command session for new bounded output since a cursor and return current command status.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          cursor: { type: "integer" },
          max_output_bytes: { type: "integer" },
        },
        required: ["session_id"],
      },
    },
  },
  execute: async (args, ctx) => {
    const session = getOwnedSession(args.session_id, ctx)
    if ("error" in session) return session.error
    const output = renderSince(
      session.session,
      numberArg(args.cursor, 0),
      outputCap(args.max_output_bytes)
    )
    return renderCommandResult(session.session, output, {
      includeSessionId: true,
    })
  },
}

export const terminateCommandTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "terminate_command",
      description:
        "Terminate a running command session. Sends an interrupt first, then kills the command if it does not exit promptly.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          cursor: { type: "integer" },
        },
        required: ["session_id"],
      },
    },
  },
  execute: async (args, ctx) => {
    const session = getOwnedSession(args.session_id, ctx)
    if ("error" in session) return session.error
    await terminateSession(session.session)
    return pollSessionResult(session.session, numberArg(args.cursor, 0))
  },
}

export async function runShellCompatibility(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const result = await startCommand(
    { ...args, max_output_bytes: args.max_output_bytes ?? MAX_OUTPUT_BYTES },
    ctx,
    { compatibility: true }
  )
  if ("error" in result) return result.error

  while (result.session.status === "running") {
    await waitForExitOrDelay(result.session, 100)
  }
  const output = renderSince(result.session, 0, MAX_OUTPUT_BYTES)
  const status = result.session.timedOut
    ? `timed out after ${result.timeoutMs}ms (killed)`
    : result.session.signal
      ? `terminated by signal ${result.session.signal}`
      : `exit code ${result.session.exitCode ?? "unknown"}`
  sessions.delete(result.session.id)
  return `[${status}]\n${truncateForModel(stripAnsi(output.output)).text}`.trimEnd()
}

async function startCommand(
  args: Record<string, unknown>,
  ctx: ToolContext,
  opts: { compatibility: boolean }
): Promise<
  | {
      session: AgentCommandSession
      output: RenderedOutput
      timeoutMs: number
    }
  | { error: string }
> {
  const command = typeof args.command === "string" ? args.command.trim() : ""
  if (!command)
    return { error: toolError("bad_args", "A `command` is required.") }
  if (!ctx.workspace) {
    return {
      error: toolError("no_workspace", "Shell commands require a workspace."),
    }
  }

  const timeoutMs = timeoutArg(args.timeout_ms)
  const maxOutputBytes = outputCap(args.max_output_bytes, DEFAULT_OUTPUT_BYTES)
  const cwdArg = typeof args.cwd === "string" ? args.cwd : ""
  const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
  let workspaceRoot: string
  let cwd: string
  try {
    workspaceRoot = await env.resolve("")
    cwd = cwdArg ? await env.resolve(cwdArg) : workspaceRoot
  } catch (err) {
    return {
      error: toolError(
        "bad_cwd",
        err instanceof Error
          ? err.message
          : "Working directory is outside the workspace."
      ),
    }
  }
  const envProfile =
    ctx.env instanceof LocalEnvironment
      ? ctx.env.localRuntimeProfile
      : ctx.env
        ? "container"
        : "host-access"
  const action = shellActionForCommand(command, {
    tool: opts.compatibility ? "run_shell_tool" : "exec_command",
    cwd,
    workspace: workspaceRoot,
    runtimeProfile: envProfile,
  })
  const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
  if (outcome === "blocked") {
    return {
      error: toolError(
        "blocked",
        "This command is on the unconditional blocklist and was not run.",
        "run it yourself in a terminal outside the agent if you truly need it"
      ),
    }
  }
  if (outcome === "denied") {
    return {
      error: toolError(
        "denied",
        "The user denied approval to run this command."
      ),
    }
  }

  let spawnCwd: string
  try {
    spawnCwd = cwdArg ? await env.resolve(cwdArg) : await env.resolve("")
    if (spawnCwd !== cwd) {
      return {
        error: toolError(
          "bad_cwd",
          "Working directory changed after approval and was not run."
        ),
      }
    }
  } catch (err) {
    return {
      error: toolError(
        "bad_cwd",
        err instanceof Error
          ? err.message
          : "Working directory is outside the workspace."
      ),
    }
  }
  const handle = await env.spawnCommand(command, {
    cwd: spawnCwd,
    tty: args.tty === true,
    signal: ctx.signal,
  })
  const session = createSession({
    command,
    conversationId: ctx.conversationId ?? "",
    workspace: ctx.workspace,
    cwd,
    handle,
    maxOutputBytes,
    timeoutMs,
  })
  const onAbort = () => void terminateSession(session)
  if (ctx.signal) {
    if (ctx.signal.aborted) await terminateSession(session)
    else ctx.signal.addEventListener("abort", onAbort, { once: true })
    session.handle.onExit(() =>
      ctx.signal?.removeEventListener("abort", onAbort)
    )
  }

  await waitForSettle(
    session,
    opts.compatibility ? timeoutMs : yieldMs(args.yield_ms)
  )
  return {
    session,
    output: renderSince(session, 0, maxOutputBytes),
    timeoutMs,
  }
}

function createSession(input: {
  command: string
  conversationId: string
  workspace: string
  cwd: string
  handle: CommandSessionHandle
  maxOutputBytes: number
  timeoutMs: number
}): AgentCommandSession {
  const session: AgentCommandSession = {
    id: randomUUID(),
    conversationId: input.conversationId,
    workspace: input.workspace,
    command: input.command,
    cwd: input.cwd,
    handle: input.handle,
    createdAt: Date.now(),
    totalBytes: 0,
    droppedBytes: 0,
    maxOutputBytes: input.maxOutputBytes,
    chunks: [],
    status: "running",
    exitCode: null,
    signal: null,
    timedOut: false,
    timeout: setTimeout(() => {
      session.timedOut = true
      session.status = "timed_out"
      session.handle.kill()
    }, input.timeoutMs),
  }
  sessions.set(session.id, session)
  input.handle.onData((chunk) =>
    appendOutput(session, chunk.stream, chunk.data)
  )
  input.handle.onExit((exit) => settleSession(session, exit))
  return session
}

function appendOutput(
  session: AgentCommandSession,
  stream: OutputChunk["stream"],
  data: Buffer
): void {
  if (data.length === 0) return
  const start = session.totalBytes
  const end = start + data.length
  session.totalBytes = end
  session.chunks.push({ stream, start, end, data })
  let bytesToDrop =
    session.totalBytes - session.droppedBytes - session.maxOutputBytes
  while (bytesToDrop > 0 && session.chunks.length > 0) {
    const oldest = session.chunks[0]
    if (bytesToDrop >= oldest.data.length) {
      session.chunks.shift()
      session.droppedBytes = oldest.end
      bytesToDrop =
        session.totalBytes - session.droppedBytes - session.maxOutputBytes
      continue
    }

    const trimmed = utf8SafeSuffixFrom(oldest.data, bytesToDrop)
    if (trimmed.data.length === 0) {
      session.chunks.shift()
      session.droppedBytes = oldest.end
    } else {
      oldest.start += trimmed.offset
      oldest.data = trimmed.data
      session.droppedBytes = oldest.start
    }
    bytesToDrop =
      session.totalBytes - session.droppedBytes - session.maxOutputBytes
  }
}

function settleSession(session: AgentCommandSession, exit: CommandExit): void {
  clearTimeout(session.timeout)
  session.exitCode = exit.exitCode
  session.signal = exit.signal
  if (session.status === "running") session.status = "completed"
  session.cleanup = setTimeout(() => {
    sessions.delete(session.id)
  }, COMPLETED_SESSION_TTL_MS)
}

async function terminateSession(session: AgentCommandSession): Promise<void> {
  if (session.status !== "running") return
  session.status = "terminated"
  session.handle.interrupt()
  await waitForExitOrDelay(session, TERMINATE_GRACE_MS)
  if ((session.status as CommandStatus) === "terminated") {
    session.handle.kill()
    await waitForExitOrDelay(session, 500)
  }
}

function getOwnedSession(
  id: unknown,
  ctx: ToolContext
): { session: AgentCommandSession } | { error: string } {
  if (typeof id !== "string" || !id) {
    return { error: toolError("bad_args", "A `session_id` is required.") }
  }
  const session = sessions.get(id)
  if (!session) {
    return { error: toolError("not_found", "Command session was not found.") }
  }
  if (session.workspace !== ctx.workspace) {
    return {
      error: toolError(
        "forbidden",
        "Command session does not belong to this workspace."
      ),
    }
  }
  const conversationId = ctx.conversationId ?? ""
  if (session.conversationId !== conversationId) {
    return {
      error: toolError(
        "forbidden",
        "Command session does not belong to this conversation."
      ),
    }
  }
  return { session }
}

function renderSince(
  session: AgentCommandSession,
  cursor: number,
  cap = DEFAULT_OUTPUT_BYTES
): RenderedOutput {
  const from = Math.max(0, Math.floor(cursor))
  const effectiveFrom = Math.max(from, session.droppedBytes)
  let bytes = 0
  let renderedTo = effectiveFrom
  let truncated = from < session.droppedBytes
  const chunks: RenderedOutput["chunks"] = []
  for (const chunk of session.chunks) {
    if (chunk.end <= effectiveFrom) continue
    if (bytes >= cap) {
      truncated = true
      break
    }
    const offset = Math.max(0, effectiveFrom - chunk.start)
    const available = utf8SafeSuffixFrom(chunk.data, offset)
    if (available.offset > offset) truncated = true
    renderedTo = chunk.start + available.offset
    const keep =
      available.data.length > cap - bytes
        ? utf8SafePrefix(available.data, cap - bytes)
        : available.data
    bytes += keep.length
    renderedTo += keep.length
    chunks.push({ stream: chunk.stream, text: keep.toString("utf8") })
    if (keep.length < available.data.length) {
      truncated = true
      break
    }
  }
  const output = chunks.map((chunk) => chunk.text).join("")
  return {
    output: stripAnsi(output),
    cursor: renderedTo,
    totalBytes: session.totalBytes,
    droppedBytes: Math.max(0, effectiveFrom - from),
    truncated,
    chunks,
  }
}

function utf8SafePrefix(buffer: Buffer, maxBytes: number): Buffer {
  let end = Math.min(buffer.length, Math.max(0, maxBytes))
  while (end > 0) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end))
      return buffer.subarray(0, end)
    } catch {
      end -= 1
    }
  }
  return Buffer.alloc(0)
}

function utf8SafeSuffixFrom(
  buffer: Buffer,
  offset: number
): { offset: number; data: Buffer } {
  let start = Math.min(buffer.length, Math.max(0, offset))
  while (start < buffer.length) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(start))
      return { offset: start, data: buffer.subarray(start) }
    } catch {
      start += 1
    }
  }
  return { offset: buffer.length, data: Buffer.alloc(0) }
}

function pollSessionResult(
  session: AgentCommandSession,
  cursor: number
): string {
  return renderCommandResult(session, renderSince(session, cursor), {
    includeSessionId: true,
  })
}

function renderCommandResult(
  session: AgentCommandSession,
  output: RenderedOutput,
  opts: { includeSessionId: boolean }
): string {
  const durationMs = Date.now() - session.createdAt
  const body = {
    status: session.status,
    ...(opts.includeSessionId ? { sessionId: session.id } : {}),
    cursor: output.cursor,
    totalBytes: output.totalBytes,
    droppedBytes: output.droppedBytes,
    truncated: output.truncated,
    durationMs,
    exitCode: session.exitCode,
    signal: session.signal,
    output: truncateForModel(output.output).text,
  }
  return JSON.stringify(body, null, 2)
}

async function waitForSettle(
  session: AgentCommandSession,
  ms: number
): Promise<void> {
  if (session.status !== "running") return
  await waitForExitOrDelay(session, ms)
}

function waitForExitOrDelay(
  session: AgentCommandSession,
  ms: number
): Promise<void> {
  if (session.status !== "running" && session.status !== "terminated") {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    session.handle.onExit(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function timeoutArg(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS
}

function yieldMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), MAX_YIELD_MS)
    : DEFAULT_YIELD_MS
}

function outputCap(value: unknown, fallback = DEFAULT_OUTPUT_BYTES): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_OUTPUT_BYTES)
    : fallback
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback
}

export const testCommandSessions = {
  get size(): number {
    return sessions.size
  },

  clear(): void {
    for (const session of sessions.values()) {
      clearTimeout(session.timeout)
      if (session.cleanup) clearTimeout(session.cleanup)
      session.handle.kill()
    }
    sessions.clear()
  },
}
