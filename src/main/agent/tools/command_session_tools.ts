import { randomUUID } from "crypto"
import { stripAnsi } from "../approval/ansi"
import { shellActionForCommand } from "../approval/shell-analyzer"
import { LocalEnvironment } from "../env/local"
import type {
  CommandCleanupError,
  CommandExit,
  CommandSessionHandle,
} from "../env/types"
import type {
  CommandCompletionInbox,
  CommandCompletionOwner,
} from "../command-completion-inbox"
import { truncateForModel, toolError } from "./output"
import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_YIELD_MS = 1_000
const MAX_YIELD_MS = 30_000
const DEFAULT_OUTPUT_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024
const MODEL_OUTPUT_BYTES = 192 * 1024
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
  cleanupError?: CommandCleanupError
  timeout: NodeJS.Timeout
  cleanup?: NodeJS.Timeout
  settled: Promise<void>
  resolveSettled: () => void
  completionInbox?: CommandCompletionInbox
  completionOwner?: CommandCompletionOwner
}

interface RenderedOutput {
  output: string
  requestedCursor: number
  rawCap: number
  cursor: number
  nextCursor: number
  totalBytes: number
  droppedBytes: number
  omittedBytes: number
  modelTruncated: boolean
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
        "Run a shell command in the workspace. Use the foreground default when the next action depends on final output. Set background true only when independent work can continue; the runtime will deliver completion through wait_for_events when you run out of independent work.",
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
          background: {
            type: "boolean",
            description:
              "Return immediately with a session id after launch when true. Defaults to false, which waits until the command exits, times out, or is cancelled.",
          },
        },
        required: ["command"],
      },
    },
  },
  execute: async (args, ctx) => {
    const result = await startCommand(args, ctx, {
      compatibility: false,
      background: args.background === true,
    })
    if ("error" in result) return result.error
    return renderCommandResult(result.session, result.output, {
      includeSessionId:
        args.background === true ||
        result.session.status === "running" ||
        result.output.cursor < result.output.totalBytes,
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
        "Inspect a command session for bounded output since a cursor and return current status. Use this deliberately to check partial output; do not call it on a timer just to discover normal background completion.",
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

export const waitForEventsTool: Tool = {
  effects: TOOL_EFFECTS.openWorldRead,
  definition: {
    type: "function",
    function: {
      name: "wait_for_events",
      description:
        "Wait for background command completion events owned by this run after independent work has run out. Returns queued completions immediately, waits for a future completion when matching commands are still running, and returns a clear empty result when there are no matching pending commands.",
      parameters: {
        type: "object",
        properties: {
          session_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional background command session IDs to wait for. Omit to wait for any command owned by this run.",
          },
        },
      },
    },
  },
  execute: async (args, ctx) => {
    const inbox = ctx.commandCompletions
    const owner = ctx.commandCompletionOwner
    if (!inbox || !owner) {
      return toolError(
        "unavailable",
        "No runtime event inbox is available for this turn."
      )
    }
    const sessionIds = Array.isArray(args.session_ids)
      ? args.session_ids.filter((id): id is string => typeof id === "string")
      : undefined
    let events = inbox.drain(owner, { sessionIds })
    if (events.length === 0 && inbox.hasPending(owner, sessionIds)) {
      await inbox.waitForEvent(owner, { sessionIds, signal: ctx.signal })
      events = inbox.drain(owner, { sessionIds })
    }
    if (events.length === 0) {
      return JSON.stringify(
        {
          status: "empty",
          message:
            "No matching pending background commands or completion events are owned by this run.",
          completions: [],
        },
        null,
        2
      )
    }
    const result = JSON.stringify(
      {
        status: "completed",
        completions: events.map((event) => ({
          eventId: event.id,
          sessionId: event.sessionId,
          runId: event.runId,
          command: event.command,
          cwd: event.cwd,
          createdAt: event.createdAt,
          status: event.status,
          exitCode: event.exitCode,
          signal: event.signal,
          durationMs: event.durationMs,
          cursor: event.cursor,
          nextCursor: event.nextCursor,
          totalBytes: event.totalBytes,
          droppedBytes: event.droppedBytes,
          omittedBytes: event.omittedBytes,
          modelTruncated: event.modelTruncated,
          truncated: event.truncated,
          cleanupError: event.cleanupError,
          output: event.output,
        })),
      },
      null,
      2
    )
    inbox.markConsumed(events.map((event) => event.id))
    return result
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
    { compatibility: true, background: false }
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
  const rendered =
    `[${status}]\n${truncateForModel(stripAnsi(output.output)).text}`.trimEnd()
  if (!result.session.cleanupError) return rendered
  return toolError(
    "cleanup_failed",
    `Command finished with ${status}, but cleanup failed for temporary source file ${result.session.cleanupError.path}: ${result.session.cleanupError.error}. The command output was:\n${rendered}`
  )
}

async function startCommand(
  args: Record<string, unknown>,
  ctx: ToolContext,
  opts: { compatibility: boolean; background: boolean }
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
        "The execution gate blocked this command; it was not run."
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
    completion:
      opts.background && ctx.commandCompletions && ctx.commandCompletionOwner
        ? {
            inbox: ctx.commandCompletions,
            owner: ctx.commandCompletionOwner,
          }
        : undefined,
  })
  const onAbort = () => void terminateSession(session)
  if (ctx.signal) {
    if (ctx.signal.aborted) await terminateSession(session)
    else ctx.signal.addEventListener("abort", onAbort, { once: true })
    session.handle.onExit(() =>
      ctx.signal?.removeEventListener("abort", onAbort)
    )
  }

  if (opts.compatibility || !opts.background) {
    await waitForSettled(session)
  }
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
  completion?: {
    inbox: CommandCompletionInbox
    owner: CommandCompletionOwner
  }
}): AgentCommandSession {
  let resolveSettled: () => void = () => {}
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve
  })
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
    cleanupError: undefined,
    settled,
    resolveSettled,
    completionInbox: input.completion?.inbox,
    completionOwner: input.completion?.owner,
    timeout: setTimeout(() => {
      session.timedOut = true
      session.status = "timed_out"
      session.handle.kill()
    }, input.timeoutMs),
  }
  sessions.set(session.id, session)
  input.completion?.inbox.register(session.id, input.completion.owner, {
    releaseRetainedOutput: () => releaseSession(session.id),
  })
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
  session.cleanupError = exit.cleanupError
  if (session.status === "running") session.status = "completed"
  session.resolveSettled()
  if (session.completionInbox && session.completionOwner) {
    const output = renderSince(session, 0)
    session.completionInbox.enqueue({
      sessionId: session.id,
      owner: session.completionOwner,
      event: commandCompletionEvent(session, output),
    })
  }
  scheduleSessionCleanup(session)
}

function commandCompletionEvent(
  session: AgentCommandSession,
  output: RenderedOutput
) {
  return {
    sessionId: session.id,
    command: session.command,
    cwd: session.cwd,
    status: session.status,
    exitCode: session.exitCode,
    signal: session.signal,
    durationMs: Date.now() - session.createdAt,
    cursor: output.cursor,
    nextCursor: output.nextCursor,
    totalBytes: output.totalBytes,
    droppedBytes: output.droppedBytes,
    omittedBytes: output.omittedBytes,
    modelTruncated: output.modelTruncated,
    truncated: output.truncated,
    cleanupError: session.cleanupError,
    output: output.output,
  }
}

function scheduleSessionCleanup(session: AgentCommandSession): void {
  session.cleanup = setTimeout(() => {
    if (
      session.completionInbox &&
      session.completionOwner &&
      !session.completionInbox.canReleaseSession(
        session.completionOwner,
        session.id
      )
    ) {
      scheduleSessionCleanup(session)
      return
    }
    releaseSession(session.id)
  }, COMPLETED_SESSION_TTL_MS)
}

function releaseSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session || session.status === "running") return
  if (session.cleanup) clearTimeout(session.cleanup)
  sessions.delete(sessionId)
}

function sameCompletionOwner(
  a: CommandCompletionOwner,
  b: CommandCompletionOwner
): boolean {
  return (
    a.conversationId === b.conversationId &&
    a.workspace === b.workspace &&
    a.runId === b.runId
  )
}

export async function terminateOwnedCommandSessions(
  owner: CommandCompletionOwner
): Promise<void> {
  const owned = [...sessions.values()].filter(
    (session) =>
      session.status === "running" &&
      session.completionOwner &&
      sameCompletionOwner(session.completionOwner, owner)
  )
  await Promise.all(owned.map((session) => terminateSession(session)))
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
  const effectiveCap = Math.min(cap, MODEL_OUTPUT_BYTES)
  let bytes = 0
  let renderedTo = effectiveFrom
  let truncated = from < session.droppedBytes
  let modelTruncated = false
  const chunks: RenderedOutput["chunks"] = []
  for (const chunk of session.chunks) {
    if (chunk.end <= effectiveFrom) continue
    if (bytes >= effectiveCap) {
      truncated = true
      modelTruncated = true
      break
    }
    const offset = Math.max(0, effectiveFrom - chunk.start)
    const available = utf8SafeSuffixFrom(chunk.data, offset)
    if (available.offset > offset) truncated = true
    renderedTo = chunk.start + available.offset
    const keep =
      available.data.length > effectiveCap - bytes
        ? utf8SafePrefix(available.data, effectiveCap - bytes)
        : available.data
    bytes += keep.length
    renderedTo += keep.length
    chunks.push({ stream: chunk.stream, text: keep.toString("utf8") })
    if (keep.length < available.data.length) {
      truncated = true
      modelTruncated = true
      break
    }
  }
  const output = chunks.map((chunk) => chunk.text).join("")
  const omittedBytes = Math.max(0, session.totalBytes - renderedTo)
  return {
    output: stripAnsi(output),
    requestedCursor: from,
    rawCap: effectiveCap,
    cursor: renderedTo,
    nextCursor: renderedTo,
    totalBytes: session.totalBytes,
    droppedBytes: Math.max(0, effectiveFrom - from),
    omittedBytes,
    modelTruncated,
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
  let fitted = output
  let rendered = stringifyCommandResult(session, fitted, opts)
  if (Buffer.byteLength(rendered, "utf8") <= MODEL_OUTPUT_BYTES) {
    return rendered
  }

  let low = 0
  let high = fitted.rawCap
  let best = renderSince(session, fitted.requestedCursor, 0)
  let bestRendered = stringifyCommandResult(session, best, opts)

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = renderSince(session, fitted.requestedCursor, mid)
    const serialized = stringifyCommandResult(session, candidate, opts)
    if (Buffer.byteLength(serialized, "utf8") <= MODEL_OUTPUT_BYTES) {
      best = candidate
      bestRendered = serialized
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  fitted = best
  rendered = bestRendered
  while (Buffer.byteLength(rendered, "utf8") > MODEL_OUTPUT_BYTES) {
    if (fitted.rawCap <= 0) break
    fitted = renderSince(session, fitted.requestedCursor, fitted.rawCap - 1)
    rendered = stringifyCommandResult(session, fitted, opts)
  }
  return rendered
}

function stringifyCommandResult(
  session: AgentCommandSession,
  output: RenderedOutput,
  opts: { includeSessionId: boolean }
): string {
  const durationMs = Date.now() - session.createdAt
  const body = {
    status: session.status,
    ...(opts.includeSessionId ? { sessionId: session.id } : {}),
    cursor: output.cursor,
    nextCursor: output.nextCursor,
    totalBytes: output.totalBytes,
    droppedBytes: output.droppedBytes,
    omittedBytes: output.omittedBytes,
    modelTruncated: output.modelTruncated,
    truncated: output.truncated,
    durationMs,
    exitCode: session.exitCode,
    signal: session.signal,
    cleanupError: session.cleanupError,
    output: output.output,
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

async function waitForSettled(session: AgentCommandSession): Promise<void> {
  if (session.status !== "running" && session.status !== "terminated") return
  await session.settled
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
