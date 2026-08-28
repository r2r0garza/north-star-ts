import { stripAnsi } from "../approval/ansi"
import { shellActionForCommand } from "../approval/shell-analyzer"
import { LocalEnvironment } from "../env/local"
import type {
  CommandCleanupError,
  CommandExit,
  CommandSessionHandle,
} from "../env/types"
import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { toolError } from "./output"

type DiagnosticSeverity = "error" | "warning" | "info"
type TestStatus = "passed" | "failed" | "skipped" | "todo"
type TestSessionStatus = "running" | "completed" | "timed_out" | "terminated"

interface DiagnosticRecord {
  path?: string
  line?: number
  column?: number
  severity: DiagnosticSeverity
  code?: string
  message: string
  source: string
}

interface TestCaseResult {
  suite?: string
  name: string
  status: TestStatus
  durationMs?: number
  path?: string
  line?: number
  message?: string
}

interface ProviderCommand {
  provider: string
  command: string
  target: string
}

interface TestSession {
  id: string
  conversationId: string
  workspace: string
  command: string
  provider: string
  target: string
  handle: CommandSessionHandle
  createdAt: number
  output: string
  status: TestSessionStatus
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  cleanupError?: CommandCleanupError
  timeout: NodeJS.Timeout
  cleanup?: NodeJS.Timeout
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_YIELD_MS = 1_000
const MAX_YIELD_MS = 30_000
const MAX_CAPTURE_BYTES = 256 * 1024
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
const COMPLETED_SESSION_TTL_MS = 5 * 60_000
const TERMINATE_GRACE_MS = 1_500

const testSessions = new Map<string, TestSession>()

export const workspaceDiagnosticsTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "workspace_diagnostics",
      description:
        "Run a configured workspace checker such as typecheck, lint, or check and return normalized diagnostic records plus bounded raw evidence.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Optional semantic checker target: typecheck, lint, check, or diagnostics. Defaults to the best declared checker.",
          },
          timeout_ms: {
            type: "integer",
            description:
              "Maximum checker runtime in milliseconds. Defaults to 120000; capped at 600000.",
          },
          max_output_bytes: {
            type: "integer",
            description:
              "Maximum raw stdout/stderr evidence to retain. Defaults to 262144; capped at 262144.",
          },
        },
      },
    },
  },
  execute: async (args, ctx) => {
    const command = await detectCommand(ctx, {
      kind: "diagnostics",
      target: stringArg(args.target),
    })
    if ("error" in command) return command.error

    const prepared = await prepareApprovedCommand(command, ctx, {
      tool: "workspace_diagnostics",
    })
    if ("error" in prepared) return prepared.error

    const result = await prepared.env.exec(command.command, {
      cwd: prepared.cwd,
      timeoutMs: timeoutArg(args.timeout_ms),
      maxOutputBytes: outputCap(args.max_output_bytes),
      signal: ctx.signal,
    })
    const raw = stripAnsi(result.stdout.toString("utf8"))
    const diagnostics = parseDiagnostics(raw)
    return JSON.stringify(
      {
        provider: command.provider,
        target: command.target,
        command: command.command,
        status: result.timedOut
          ? "timed_out"
          : result.aborted
            ? "terminated"
            : "completed",
        exitCode: result.exitCode,
        signal: result.signal,
        counts: countDiagnostics(diagnostics),
        diagnostics,
        rawEvidence: raw,
        outputTruncated: result.outputTruncated ?? false,
        capturedOutputBytes: result.capturedOutputBytes,
        observedOutputBytes: result.observedOutputBytes,
        cleanupError: result.cleanupError,
      },
      null,
      2
    )
  },
}

export const runTestsTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "run_tests",
      description:
        "Run a configured test target with bounded session support. The target selects declared package scripts; it is not an arbitrary shell command.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Semantic test target or declared test script name. Defaults to test.",
          },
          path: {
            type: "string",
            description:
              "Optional workspace-relative file/path filter. Passed after -- to the declared test script.",
          },
          name: {
            type: "string",
            description:
              "Optional test name filter. Supported for common JS runners via --testNamePattern.",
          },
          timeout_ms: {
            type: "integer",
            description:
              "Maximum test runtime in milliseconds. Defaults to 120000; capped at 600000.",
          },
          yield_ms: {
            type: "integer",
            description:
              "How long to wait for initial output before returning a running session. Defaults to 1000; capped at 30000.",
          },
        },
      },
    },
  },
  execute: async (args, ctx) => {
    const command = await detectCommand(ctx, {
      kind: "test",
      target: stringArg(args.target) ?? "test",
      pathFilter: stringArg(args.path),
      nameFilter: stringArg(args.name),
    })
    if ("error" in command) return command.error

    const prepared = await prepareApprovedCommand(command, ctx, {
      tool: "run_tests",
    })
    if ("error" in prepared) return prepared.error

    const handle = await prepared.env.spawnCommand(command.command, {
      cwd: prepared.cwd,
      tty: false,
      signal: ctx.signal,
    })
    const session = createTestSession({
      handle,
      workspace: ctx.workspace,
      conversationId: ctx.conversationId ?? "",
      command,
      timeoutMs: timeoutArg(args.timeout_ms),
    })
    if (ctx.signal) {
      const onAbort = () => void terminateTestSession(session)
      if (ctx.signal.aborted) await terminateTestSession(session)
      else ctx.signal.addEventListener("abort", onAbort, { once: true })
      session.handle.onExit(() =>
        ctx.signal?.removeEventListener("abort", onAbort)
      )
    }
    await waitForSettle(session, yieldMs(args.yield_ms))
    return renderTestSession(session, {
      offset: 0,
      limit: DEFAULT_PAGE_SIZE,
      includeRawEvidence: true,
    })
  },
}

export const getTestResultsTool: Tool = {
  effects: TOOL_EFFECTS.openWorldRead,
  definition: {
    type: "function",
    function: {
      name: "get_test_results",
      description:
        "Page normalized test results and bounded raw evidence from a run_tests session owned by this conversation and workspace.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          offset: {
            type: "integer",
            description: "Zero-based result offset. Defaults to 0.",
          },
          limit: {
            type: "integer",
            description: "Maximum test cases to return. Defaults to 50.",
          },
          include_raw_evidence: {
            type: "boolean",
            description:
              "When true, includes bounded raw output evidence. Defaults to false.",
          },
        },
        required: ["session_id"],
      },
    },
  },
  execute: async (args, ctx) => {
    const session = getOwnedTestSession(args.session_id, ctx)
    if ("error" in session) return session.error
    return renderTestSession(session.session, {
      offset: numberArg(args.offset, 0),
      limit: pageLimit(args.limit),
      includeRawEvidence: args.include_raw_evidence === true,
    })
  },
}

async function detectCommand(
  ctx: ToolContext,
  opts: {
    kind: "diagnostics" | "test"
    target?: string
    pathFilter?: string
    nameFilter?: string
  }
): Promise<ProviderCommand | { error: string }> {
  if (!ctx.workspace) {
    return {
      error: toolError(
        "no_workspace",
        `${opts.kind === "test" ? "Test" : "Diagnostic"} tools require a workspace.`
      ),
    }
  }
  const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
  let pkg: { scripts?: Record<string, unknown> }
  try {
    const packagePath = await env.resolve("package.json")
    pkg = JSON.parse((await env.readFile(packagePath)).toString("utf8")) as {
      scripts?: Record<string, unknown>
    }
  } catch {
    return {
      error: toolError(
        "no_provider",
        "No package.json provider configuration was found; explicit test/checker registration is not implemented yet."
      ),
    }
  }
  const scripts = pkg.scripts ?? {}
  const script = pickScript(scripts, opts)
  if (!script) {
    return {
      error: toolError(
        "no_provider",
        `No declared ${opts.kind} script matched target ${JSON.stringify(
          opts.target ?? ""
        )}.`
      ),
    }
  }
  const manager = await detectPackageManager(env)
  const command =
    opts.kind === "test"
      ? withTestFilters(`${manager} run ${shellQuote(script)}`, opts)
      : `${manager} run ${shellQuote(script)}`
  return {
    provider: `package-json:${manager}`,
    command,
    target: script,
  }
}

async function prepareApprovedCommand(
  command: ProviderCommand,
  ctx: ToolContext,
  opts: { tool: string }
): Promise<
  { env: NonNullable<ToolContext["env"]>; cwd: string } | { error: string }
> {
  const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
  let workspaceRoot: string
  try {
    workspaceRoot = await env.resolve("")
  } catch (err) {
    return {
      error: toolError(
        "bad_workspace",
        err instanceof Error ? err.message : "Workspace could not be resolved."
      ),
    }
  }
  const envProfile =
    ctx.env instanceof LocalEnvironment
      ? ctx.env.localRuntimeProfile
      : ctx.env
        ? "container"
        : "host-access"
  const action = shellActionForCommand(command.command, {
    tool: opts.tool,
    cwd: workspaceRoot,
    workspace: workspaceRoot,
    runtimeProfile: envProfile,
  })
  action.summary = `${opts.tool}: ${command.target}`
  action.detail = {
    ...action.detail,
    provider: command.provider,
    target: command.target,
  }
  const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
  if (outcome === "blocked") {
    return {
      error: toolError(
        "blocked",
        "This configured command is on the unconditional blocklist and was not run."
      ),
    }
  }
  if (outcome === "denied") {
    return {
      error: toolError(
        "denied",
        "The user denied approval to run this configured command."
      ),
    }
  }
  const cwd = await env.resolve("")
  if (cwd !== workspaceRoot) {
    return {
      error: toolError(
        "bad_workspace",
        "Workspace root changed after approval and was not run."
      ),
    }
  }
  return { env, cwd }
}

function pickScript(
  scripts: Record<string, unknown>,
  opts: { kind: "diagnostics" | "test"; target?: string }
): string | null {
  const names = Object.keys(scripts).filter(
    (name) => typeof scripts[name] === "string"
  )
  const requested = opts.target?.trim()
  if (requested && names.includes(requested)) return requested
  if (opts.kind === "test") {
    return names.find((name) => name === "test") ?? null
  }
  const preferred = requested
    ? [requested]
    : ["typecheck", "lint", "check", "diagnostics"]
  return preferred.find((name) => names.includes(name)) ?? null
}

async function detectPackageManager(
  env: NonNullable<ToolContext["env"]>
): Promise<"pnpm" | "yarn" | "npm"> {
  for (const [file, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ] as const) {
    try {
      await env.stat(await env.resolve(file))
      return manager
    } catch {
      // try next lockfile
    }
  }
  return "npm"
}

function withTestFilters(
  command: string,
  opts: { pathFilter?: string; nameFilter?: string }
): string {
  const extras: string[] = []
  if (opts.pathFilter) extras.push(shellQuote(opts.pathFilter))
  if (opts.nameFilter) {
    extras.push("--testNamePattern", shellQuote(opts.nameFilter))
  }
  return extras.length ? `${command} -- ${extras.join(" ")}` : command
}

function parseDiagnostics(raw: string): DiagnosticRecord[] {
  const records: DiagnosticRecord[] = []
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    const ts =
      /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/.exec(line)
    if (ts) {
      records.push({
        path: ts[1],
        line: Number(ts[2]),
        column: Number(ts[3]),
        severity: ts[4] as DiagnosticSeverity,
        code: ts[5],
        message: ts[6],
        source: "typescript",
      })
      continue
    }
    const eslint =
      /^(.+?):(\d+):(\d+):\s+(error|warning|info)\s+(.+?)(?:\s+([@\w/-]+))?$/.exec(
        line
      )
    if (eslint) {
      records.push({
        path: eslint[1],
        line: Number(eslint[2]),
        column: Number(eslint[3]),
        severity: eslint[4] as DiagnosticSeverity,
        code: eslint[6],
        message: eslint[5],
        source: "eslint",
      })
    }
  }
  return records
}

function parseTestCases(raw: string): TestCaseResult[] {
  const cases: TestCaseResult[] = []
  const lines = raw.split(/\r?\n/)
  let currentPath: string | undefined
  let failedPath: string | undefined
  for (const line of lines) {
    const clean = stripAnsi(line).trimEnd()
    const file =
      /^\s*(?:✓|✔|PASS|❯|×|FAIL)\s+(.+\.(?:test|spec)\.[jt]sx?)(?:\s+\((\d+)\))?/.exec(
        clean
      )
    if (file) {
      currentPath = file[1]
      if (/^\s*(?:×|FAIL)/.test(clean)) failedPath = file[1]
      continue
    }
    const vitestCase = /^\s*(✓|✔|×|-)\s+(.+?)(?:\s+(\d+)ms)?$/.exec(clean)
    if (vitestCase && !/^(Tests|Test Files)\b/.test(vitestCase[2])) {
      cases.push({
        suite: currentPath,
        path: currentPath,
        name: vitestCase[2].trim(),
        status:
          vitestCase[1] === "×"
            ? "failed"
            : vitestCase[1] === "-"
              ? "skipped"
              : "passed",
        durationMs: vitestCase[3] ? Number(vitestCase[3]) : undefined,
      })
      continue
    }
    const failName = /^\s*FAIL\s+(.+)$/.exec(clean)
    if (failName) {
      cases.push({
        suite: failedPath,
        path: failedPath,
        name: failName[1].trim(),
        status: "failed",
      })
    }
  }
  return cases
}

function countDiagnostics(records: DiagnosticRecord[]) {
  return {
    errors: records.filter((r) => r.severity === "error").length,
    warnings: records.filter((r) => r.severity === "warning").length,
    infos: records.filter((r) => r.severity === "info").length,
  }
}

function countTests(records: TestCaseResult[]) {
  return {
    total: records.length,
    passed: records.filter((r) => r.status === "passed").length,
    failed: records.filter((r) => r.status === "failed").length,
    skipped: records.filter((r) => r.status === "skipped").length,
    todo: records.filter((r) => r.status === "todo").length,
  }
}

function createTestSession(input: {
  handle: CommandSessionHandle
  workspace: string
  conversationId: string
  command: ProviderCommand
  timeoutMs: number
}): TestSession {
  const session: TestSession = {
    id: cryptoRandomId(),
    workspace: input.workspace,
    conversationId: input.conversationId,
    command: input.command.command,
    provider: input.command.provider,
    target: input.command.target,
    handle: input.handle,
    createdAt: Date.now(),
    output: "",
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
  testSessions.set(session.id, session)
  input.handle.onData((chunk) => {
    session.output = trimOutput(
      session.output + chunk.data.toString("utf8"),
      MAX_CAPTURE_BYTES
    )
  })
  input.handle.onExit((exit) => settleTestSession(session, exit))
  return session
}

function settleTestSession(session: TestSession, exit: CommandExit): void {
  clearTimeout(session.timeout)
  session.exitCode = exit.exitCode
  session.signal = exit.signal
  session.cleanupError = exit.cleanupError
  if (session.status === "running") session.status = "completed"
  session.cleanup = setTimeout(() => {
    testSessions.delete(session.id)
  }, COMPLETED_SESSION_TTL_MS)
}

async function terminateTestSession(session: TestSession): Promise<void> {
  if (session.status !== "running") return
  session.status = "terminated"
  session.handle.interrupt()
  await waitForExitOrDelay(session, TERMINATE_GRACE_MS)
  if ((session.status as TestSessionStatus) === "terminated") {
    session.handle.kill()
    await waitForExitOrDelay(session, 500)
  }
}

function getOwnedTestSession(
  id: unknown,
  ctx: ToolContext
): { session: TestSession } | { error: string } {
  if (typeof id !== "string" || !id) {
    return { error: toolError("bad_args", "A `session_id` is required.") }
  }
  const session = testSessions.get(id)
  if (!session) {
    return { error: toolError("not_found", "Test session was not found.") }
  }
  if (session.workspace !== ctx.workspace) {
    return {
      error: toolError(
        "forbidden",
        "Test session does not belong to this workspace."
      ),
    }
  }
  const conversationId = ctx.conversationId ?? ""
  if (session.conversationId !== conversationId) {
    return {
      error: toolError(
        "forbidden",
        "Test session does not belong to this conversation."
      ),
    }
  }
  return { session }
}

function renderTestSession(
  session: TestSession,
  opts: { offset: number; limit: number; includeRawEvidence: boolean }
): string {
  const results = parseTestCases(session.output)
  const offset = Math.min(opts.offset, results.length)
  const page = results.slice(offset, offset + opts.limit)
  return JSON.stringify(
    {
      status: session.status,
      sessionId: session.id,
      provider: session.provider,
      target: session.target,
      command: session.command,
      durationMs: Date.now() - session.createdAt,
      exitCode: session.exitCode,
      signal: session.signal,
      cleanupError: session.cleanupError,
      counts: countTests(results),
      offset,
      limit: opts.limit,
      hasMore: offset + page.length < results.length,
      nextOffset:
        offset + page.length < results.length ? offset + page.length : null,
      results: page,
      rawEvidence: opts.includeRawEvidence
        ? stripAnsi(session.output)
        : undefined,
      outputTruncated:
        Buffer.byteLength(session.output, "utf8") >= MAX_CAPTURE_BYTES,
    },
    null,
    2
  )
}

async function waitForSettle(session: TestSession, ms: number): Promise<void> {
  if (session.status !== "running") return
  await waitForExitOrDelay(session, ms)
}

function waitForExitOrDelay(session: TestSession, ms: number): Promise<void> {
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

function trimOutput(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return stripAnsi(text)
  let trimmed = text
  while (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    trimmed = trimmed.slice(Math.max(1, trimmed.length - maxBytes))
  }
  return stripAnsi(trimmed)
}

function outputCap(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_CAPTURE_BYTES)
    : MAX_CAPTURE_BYTES
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

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback
}

function pageLimit(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function cryptoRandomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

export const testDiagnosticsSessions = {
  clear(): void {
    for (const session of testSessions.values()) {
      clearTimeout(session.timeout)
      if (session.cleanup) clearTimeout(session.cleanup)
      session.handle.kill()
    }
    testSessions.clear()
  },
}
