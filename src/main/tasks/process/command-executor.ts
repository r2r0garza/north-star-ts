import { stripAnsi } from "../../agent/approval/ansi"
import { shellActionForCommand } from "../../agent/approval/shell-analyzer"
import type { PolicyContext } from "../../agent/approval/policy"
import type { ActionDecision, ToolAction } from "../../agent/approval/types"
import type { EnvConfig } from "../../agent/env/factory"
import type { CommandExit, Environment } from "../../agent/env/types"
import { SHUTDOWN_ABORT_REASON, PAUSE_ABORT_REASON } from "../../agent/abort"
import { formatDuration } from "../../../shared/process-command"
import type {
  ProcessCommandReceipt,
  ResolvedProcessCommand,
} from "../../db/types"
import type { CommandPhaseResult } from "./scheduler"

// The deterministic Process command executor (plan 104). Runs a command phase's
// PERSISTED command through the same execution seam a worker's command tool
// uses — the configured Local/container Environment, workspace confinement, the
// shared approval PolicyEngine, the repository-lease check, bounded output, a
// timeout, and interrupt→kill process-tree cleanup on cancel — without any model
// call. The scheduler settles the phase from the returned receipt.

// How long a command gets to exit after an interrupt before it is killed.
const TERMINATE_GRACE_MS = 1_500
// How often a running command's bounded output is persisted for the monitor.
const PROGRESS_INTERVAL_MS = 1_000

export interface CommandExecutorDeps {
  getExecutionConfig: () => EnvConfig
  createEnvironment: (
    workspace: string,
    id: string,
    cfg: EnvConfig
  ) => Promise<Environment>
  decide: (action: ToolAction, ctx: PolicyContext) => ActionDecision
  // A delegated subagent holding the repository blocks other commands there.
  repositoryBlocker: (cwd: string) => Promise<{ label: string } | undefined>
  now?: () => number
}

export async function executeProcessCommand(
  input: {
    // The frozen command for this phase (a resolved check or a literal).
    config: ResolvedProcessCommand
    // The run's resolved workspace (its worktree for a Mission Control story).
    workspace: string | undefined
    phaseRunId: string
    signal: AbortSignal
    onStart: (receipt: ProcessCommandReceipt) => void
    onProgress: (receipt: ProcessCommandReceipt) => void
  },
  deps: CommandExecutorDeps
): Promise<CommandPhaseResult> {
  const { config, workspace, signal } = input
  const now = deps.now ?? Date.now
  if (!workspace)
    return {
      receipt: null,
      code: "command_no_workspace",
      error:
        "This run has no workspace folder, so the command has nowhere to run. Start the run with a workspace.",
    }
  if (signal.aborted) return { receipt: null, stopped: true }

  const envConfig = deps.getExecutionConfig()
  let env: Environment
  try {
    env = await deps.createEnvironment(
      workspace,
      `process-command:${input.phaseRunId}`,
      envConfig
    )
  } catch (err) {
    return {
      receipt: null,
      code: "execution_backend_unavailable",
      error: `Execution backend unavailable: ${message(err)}`,
    }
  }

  try {
    let workspaceRoot: string
    let cwd: string
    try {
      workspaceRoot = await env.resolve("")
      cwd = config.cwd ? await env.resolve(config.cwd) : workspaceRoot
      if (!(await env.stat(cwd)).isDirectory())
        throw new Error(`${config.cwd} is not a directory`)
    } catch (err) {
      return {
        receipt: null,
        code: "command_bad_cwd",
        error: `The working directory ${config.cwd ?? "(workspace root)"} is not usable: ${message(err)}`,
      }
    }

    // Authorize through the SAME engine and action identity as a worker's
    // command tool. Process phases run with Process autonomy (workers run in
    // Auto mode, the phase gate is the human checkpoint), so everything but a
    // hard block runs; a hard-blocked command never spawns.
    const localProfile =
      envConfig.kind === "local"
        ? (envConfig.profile ?? "host-access")
        : "host-access"
    const action = shellActionForCommand(config.command, {
      tool: "run_shell_tool",
      cwd,
      workspace: workspaceRoot,
      runtimeProfile:
        envConfig.kind === "container" ? "container" : localProfile,
    })
    const decision = deps.decide(action, {
      workspacePath: workspace,
      sandboxed: envConfig.kind === "container",
      localProfile,
    })
    if (decision.level === "hard_block")
      return {
        receipt: null,
        code: "command_blocked",
        error: `The approval policy blocks this command, so it was not run: ${decision.reason}`,
      }

    const lease = await deps.repositoryBlocker(cwd)
    if (lease)
      return {
        receipt: null,
        code: "repository_busy",
        error: `The repository is busy, so the command was not run: ${lease.label}`,
      }
    if (signal.aborted) return { receipt: null, stopped: true }

    const environment = envConfig.kind === "container" ? "container" : "local"
    const stdout = new HeadTailBuffer(Math.floor(config.maxOutputBytes / 2))
    const stderr = new HeadTailBuffer(
      config.maxOutputBytes - Math.floor(config.maxOutputBytes / 2)
    )
    const startedAt = now()
    const snapshot = (
      patch: Partial<ProcessCommandReceipt> = {}
    ): ProcessCommandReceipt => ({
      version: 1,
      check: config.check,
      command: config.command,
      cwd: config.cwd,
      environment,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt,
      finishedAt: null,
      stdout: stripAnsi(stdout.text()),
      stderr: stripAnsi(stderr.text()),
      outputTruncated: stdout.truncated || stderr.truncated,
      capturedOutputBytes: stdout.capturedBytes + stderr.capturedBytes,
      observedOutputBytes: stdout.observedBytes + stderr.observedBytes,
      error: null,
      ...patch,
    })

    // The crash-safety marker: from here on the command may have side effects.
    input.onStart(snapshot())

    let handle: Awaited<ReturnType<Environment["spawnCommand"]>>
    try {
      handle = await env.spawnCommand(config.command, {
        cwd,
        tty: false,
        signal,
      })
    } catch (err) {
      const error = `The command failed to start: ${message(err)}`
      return {
        receipt: snapshot({ status: "failed", finishedAt: now(), error }),
        code: "command_spawn_failed",
        error,
      }
    }

    let timedOut = false
    let aborted = false
    let exited = false
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const terminate = () => {
      if (exited) return
      handle.interrupt()
      timers.push(
        setTimeout(() => {
          if (!exited) handle.kill()
        }, TERMINATE_GRACE_MS)
      )
    }
    let lastProgress = 0
    let progressTimer: ReturnType<typeof setTimeout> | null = null
    const reportProgress = () => {
      progressTimer = null
      if (exited) return
      lastProgress = now()
      input.onProgress(snapshot())
    }
    handle.onData((chunk) => {
      ;(chunk.stream === "stderr" ? stderr : stdout).push(chunk.data)
      if (progressTimer || exited) return
      const wait = Math.max(0, PROGRESS_INTERVAL_MS - (now() - lastProgress))
      progressTimer = setTimeout(reportProgress, wait)
    })
    const exit = await new Promise<CommandExit>((resolve) => {
      handle.onExit(resolve)
      timers.push(
        setTimeout(() => {
          timedOut = true
          terminate()
        }, config.timeoutMs)
      )
      const onAbort = () => {
        aborted = true
        terminate()
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    })
    exited = true
    for (const timer of timers) clearTimeout(timer)
    if (progressTimer) clearTimeout(progressTimer)

    const finishedAt = now()
    const base = { exitCode: exit.exitCode, signal: exit.signal, finishedAt }
    if (aborted) {
      const resumable =
        signal.reason === SHUTDOWN_ABORT_REASON ||
        signal.reason === PAUSE_ABORT_REASON
      return {
        receipt: snapshot({
          ...base,
          status: resumable ? "interrupted" : "cancelled",
          error: resumable
            ? "The run was paused or the app quit while this command was running."
            : null,
        }),
        stopped: true,
      }
    }
    if (timedOut) {
      const error = `The command ran past its ${formatDuration(config.timeoutMs)} timeout and was stopped.`
      return {
        receipt: snapshot({ ...base, status: "timed_out", error }),
        code: "command_timed_out",
        error,
      }
    }
    if (exit.cleanupError) {
      const error = `Cleanup failed for ${exit.cleanupError.path}: ${exit.cleanupError.error}`
      return {
        receipt: snapshot({ ...base, status: "failed", error }),
        code: "command_cleanup_failed",
        error,
      }
    }
    const succeeded = exit.exitCode === 0 && !exit.signal
    return {
      receipt: snapshot({
        ...base,
        status: succeeded ? "completed" : "failed",
      }),
      ...(succeeded ? {} : { code: "command_failed" }),
    }
  } finally {
    await env.dispose().catch(() => {})
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Bounded capture of one output stream: the first half of the budget and a
// rolling last half, so both the start of a log and its verdict at the end
// survive a chatty command.
export class HeadTailBuffer {
  private readonly headCap: number
  private readonly tailCap: number
  private head: Buffer[] = []
  private headBytes = 0
  private tail: Buffer = Buffer.alloc(0)
  observedBytes = 0

  constructor(capacity: number) {
    this.headCap = Math.ceil(capacity / 2)
    this.tailCap = capacity - this.headCap
  }

  push(data: Buffer): void {
    this.observedBytes += data.length
    let rest = data
    if (this.headBytes < this.headCap) {
      const take = Math.min(this.headCap - this.headBytes, rest.length)
      this.head.push(rest.subarray(0, take))
      this.headBytes += take
      rest = rest.subarray(take)
    }
    if (rest.length === 0 || this.tailCap === 0) return
    const joined = Buffer.concat([this.tail, rest])
    this.tail =
      joined.length > this.tailCap
        ? Buffer.from(joined.subarray(joined.length - this.tailCap))
        : joined
  }

  get capturedBytes(): number {
    return this.headBytes + this.tail.length
  }

  get truncated(): boolean {
    return this.observedBytes > this.capturedBytes
  }

  text(): string {
    const head = Buffer.concat(this.head)
    if (!this.truncated)
      return Buffer.concat([head, this.tail]).toString("utf8")
    const omitted = this.observedBytes - this.capturedBytes
    return (
      utf8Prefix(head) +
      `\n[… ${omitted} bytes omitted …]\n` +
      utf8Suffix(this.tail)
    )
  }
}

// Drop a multi-byte character cut off at the end of a prefix.
function utf8Prefix(buf: Buffer): string {
  let end = buf.length
  let back = 0
  while (back < 4 && end - back - 1 >= 0) {
    const byte = buf[end - back - 1]
    if ((byte & 0xc0) !== 0x80) {
      const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
      if (need > back + 1) end -= back + 1
      break
    }
    back++
  }
  return buf.subarray(0, end).toString("utf8")
}

// Drop continuation bytes left at the start of a suffix.
function utf8Suffix(buf: Buffer): string {
  let start = 0
  while (start < buf.length && start < 3 && (buf[start] & 0xc0) === 0x80)
    start++
  return buf.subarray(start).toString("utf8")
}
