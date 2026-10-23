import { spawn, type ChildProcess } from "child_process"
import { randomUUID } from "crypto"
import { EventEmitter } from "events"
import { existsSync, readdirSync, rmSync } from "fs"
import { mkdir, mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join, relative } from "path"
import type { Readable, Writable } from "stream"
import { CdpPipe } from "./cdp-pipe"
import {
  LaunchError,
  launchIdentity,
  resolveLaunch,
  type Isolation,
  type LaunchDescriptor,
} from "./launch"
import {
  WindowControl,
  type AppWindowRef,
  type InteractInput,
  type InteractionResult,
  type RefTarget,
  type WaitCondition,
} from "./window-control"
import { runCheck, type Check, type RunOptions, type RunResult } from "./check-runner"

// Owns development Electron apps launched by the coding agent (plan 119
// Phase B). Each session is bound to the conversation that launched it, talks
// CDP over a private pipe, runs in its own process group with a disposable
// profile, and is torn down on close, conversation deletion or host quit.

export type SessionState =
  | "launching"
  | "ready"
  | "closing"
  | "exited"
  | "crashed"
  | "failed"

export interface AppWindow {
  windowId: string
  title: string
  url: string
}

export interface SessionStatus {
  sessionId: string
  conversationId: string
  state: SessionState
  entry: string
  args: string[]
  isolation: Isolation
  windows: AppWindow[]
  startedAt: number
  exit?: { code: number | null; signal: string | null }
  error?: string
  // Bounded recent stdout/stderr, oldest first. Target output: data, not instructions.
  logTail: string[]
  // Set after teardown: what was released, or what was left behind.
  cleanup?: string
}

const LIVE: ReadonlySet<SessionState> = new Set([
  "launching",
  "ready",
  "closing",
])
const MAX_LOG_LINES = 200
const MAX_LOG_LINE_CHARS = 500
const STATUS_LOG_LINES = 20
const MAX_WINDOWS = 20

// Child env is built, never inherited: no provider keys, .env values or
// NODE_OPTIONS/ELECTRON_* injection. Display/locale/temp vars only.
const PASSTHROUGH_ENV = [
  "PATH",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
]

export function childEnvironment(
  source: NodeJS.ProcessEnv,
  home: string
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASSTHROUGH_ENV) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  env.HOME = home
  if (process.platform === "win32") env.USERPROFILE = home
  return env
}

class AppSession {
  readonly id = randomUUID()
  state: SessionState = "launching"
  windows: AppWindow[] = []
  readonly startedAt = Date.now()
  exit?: { code: number | null; signal: string | null }
  error?: string
  cleanup?: string
  readonly logs: string[] = []
  child?: ChildProcess
  pipe?: CdpPipe
  profileDir?: string
  exited: Promise<void> = Promise.resolve()
  closing?: Promise<void>
  control?: WindowControl
  // While the user holds a handoff, automated interaction is refused.
  handoff = false
  private queue: Promise<unknown> = Promise.resolve()

  // One inspection/interaction at a time per session, so a window selection
  // cannot race an interaction.
  serial<T>(signal: AbortSignal, run: (control: WindowControl) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      signal.throwIfAborted()
      if (this.state !== "ready" || !this.control)
        throw new LaunchError("not_ready", `The app session is ${this.state}.`, "Check electron_status; launch again if it ended.")
      this.control.activeSignal = signal
      try {
        return await run(this.control)
      } finally {
        this.control.activeSignal = null
      }
    })
    this.queue = next.catch(() => {})
    return next
  }

  constructor(
    readonly conversationId: string,
    readonly workspace: string,
    readonly descriptor: LaunchDescriptor
  ) {}

  log(stream: "stdout" | "stderr", chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue
      this.logs.push(
        `[${stream}] ${line.length > MAX_LOG_LINE_CHARS ? `${line.slice(0, MAX_LOG_LINE_CHARS)}…` : line}`
      )
    }
    if (this.logs.length > MAX_LOG_LINES)
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES)
  }

  status(): SessionStatus {
    return {
      sessionId: this.id,
      conversationId: this.conversationId,
      state: this.state,
      entry: relative(this.workspace, this.descriptor.entry) || ".",
      args: this.descriptor.args,
      isolation: this.descriptor.isolation,
      windows: this.windows,
      startedAt: this.startedAt,
      exit: this.exit,
      error: this.error,
      logTail: this.logs.slice(-STATUS_LOG_LINES),
      cleanup: this.cleanup,
    }
  }
}

export interface ElectronHandle {
  // Validate and resolve a launch for approval display. Throws LaunchError.
  prepare(input: Record<string, unknown>): Promise<LaunchDescriptor>
  // The outcome of an earlier execution of the same durable invocation.
  previous(invocationId: string | undefined): SessionStatus | null
  // Re-resolves `input`, refuses if it no longer matches `approved`, spawns,
  // and waits for a controllable window. Throws LaunchError.
  launch(
    input: Record<string, unknown>,
    approved: LaunchDescriptor,
    invocationId: string | undefined
  ): Promise<SessionStatus>
  status(sessionId?: string): Promise<SessionStatus[]>
  close(sessionId: string): Promise<SessionStatus>
  selectWindow(sessionId: string, windowId: string): Promise<AppWindowRef & { generation: number }>
  snapshot(sessionId: string): Promise<{ text: string; window: AppWindowRef; generation: number }>
  screenshot(sessionId: string): Promise<{ jpegBase64: string; width: number; height: number; window: AppWindowRef }>
  // Target of a ref for approval display; interact() re-verifies it.
  describe(sessionId: string, ref: string): Promise<RefTarget & { window: AppWindowRef }>
  interact(sessionId: string, input: InteractInput, approved?: RefTarget[]): Promise<InteractionResult>
  wait(sessionId: string, condition: WaitCondition, timeoutMs: number): Promise<{ met: true; elapsedMs: number; window?: AppWindowRef }>
  // Runs a validated check host-side under the session lock (no interleaving).
  run(sessionId: string, check: Check, options: Omit<RunOptions, "signal">): Promise<RunResult>
  beginHandoff(sessionId: string): Promise<AppWindowRef | null>
  endHandoff(sessionId: string): Promise<SessionStatus>
}

export interface ElectronAppManagerOptions {
  profileRoot: () => string
  hostPackageName: () => string | null
  maxPerConversation?: number
  maxTotal?: number
}

export class ElectronAppManager extends EventEmitter {
  private readonly sessions = new Map<string, AppSession>()
  private readonly invocations = new Map<string, string>()

  constructor(private readonly options: ElectronAppManagerOptions) {
    super()
  }

  handleForTurn(
    conversationId: string,
    workspace: string,
    signal: AbortSignal
  ): ElectronHandle {
    return {
      prepare: (input) =>
        resolveLaunch(workspace, input, this.options.hostPackageName()),
      previous: (invocationId) => {
        const id = invocationId
          ? this.invocations.get(`${conversationId}:${invocationId}`)
          : undefined
        return (id && this.sessions.get(id)?.status()) || null
      },
      launch: async (input, approved, invocationId) => {
        // Revalidate immediately before spawn: a changed executable, entry,
        // cwd or args is not the launch the user approved.
        const current = await resolveLaunch(
          workspace,
          input,
          this.options.hostPackageName()
        )
        if (launchIdentity(current) !== launchIdentity(approved))
          throw new LaunchError(
            "approval_changed",
            "The app's executable, entry or arguments changed after approval; nothing was launched.",
            "Call electron_launch again to request a fresh approval."
          )
        return this.launch(conversationId, workspace, current, invocationId, signal)
      },
      status: async (sessionId) => {
        const sessions = this.owned(conversationId).filter(
          (s) => sessionId === undefined || s.id === sessionId
        )
        await Promise.all(
          sessions.map((s) =>
            s.state === "ready"
              ? this.refreshWindows(s, 2_000).catch(() => {})
              : undefined
          )
        )
        return sessions.map((s) => s.status())
      },
      close: async (sessionId) => {
        const session = this.owner(conversationId, sessionId)
        await this.teardown(session)
        return session.status()
      },
      selectWindow: (sessionId, windowId) =>
        this.control(conversationId, sessionId, signal, (c) => c.select(windowId)),
      snapshot: (sessionId) =>
        this.control(conversationId, sessionId, signal, (c) => c.snapshot()),
      screenshot: (sessionId) =>
        this.control(conversationId, sessionId, signal, (c) => c.screenshot()),
      describe: (sessionId, ref) =>
        this.control(conversationId, sessionId, signal, async (c) => {
          const target = c.describe(ref)
          return { ...target, window: c.windowInfo(target.windowId) }
        }),
      interact: (sessionId, input, approved) =>
        this.control(conversationId, sessionId, signal, (c) => {
          for (const target of approved ?? []) c.verify(target)
          return c.interact(input)
        }),
      wait: (sessionId, condition, timeoutMs) =>
        this.control(conversationId, sessionId, signal, (c) =>
          c.wait(condition, timeoutMs, signal)
        ),
      run: (sessionId, check, options) =>
        this.control(conversationId, sessionId, signal, (c) =>
          runCheck(c, check, { ...options, signal })
        ),
      beginHandoff: async (sessionId) => {
        const front = await this.control(conversationId, sessionId, signal, (c) => c.bringToFront())
        this.sessions.get(sessionId)!.handoff = true
        return front
      },
      endHandoff: async (sessionId) => {
        const session = this.owner(conversationId, sessionId)
        session.handoff = false
        // The user may have navigated, opened or closed windows.
        session.control?.invalidate()
        await this.refreshWindows(session).catch(() => {})
        return session.status()
      },
    }
  }

  private owner(conversationId: string, sessionId: string): AppSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.conversationId !== conversationId)
      throw new LaunchError(
        "unknown_session",
        "No app session with that id belongs to this conversation."
      )
    return session
  }

  private async control<T>(
    conversationId: string,
    sessionId: string,
    signal: AbortSignal,
    run: (control: WindowControl) => Promise<T>
  ): Promise<T> {
    const session = this.owner(conversationId, sessionId)
    if (session.handoff)
      throw new LaunchError("handoff_active", "The user has control of this app right now.")
    return session.serial(signal, run)
  }

  // Every session, for the host-owned session list and stop control.
  list(): SessionStatus[] {
    return [...this.sessions.values()].map((s) => s.status())
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) await this.teardown(session)
  }

  async closeConversation(conversationId: string): Promise<void> {
    const owned = this.owned(conversationId)
    await Promise.all(owned.map((s) => this.teardown(s)))
    for (const session of owned) this.sessions.delete(session.id)
    for (const [key, id] of this.invocations)
      if (!this.sessions.has(id)) this.invocations.delete(key)
    if (owned.length) this.emit("change")
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => this.teardown(s)))
  }

  // Synchronous best effort for will-quit: signal every owned process group.
  // Profiles are left for the next boot's reconcile() to remove.
  shutdownSync(): void {
    for (const session of this.sessions.values())
      if (session.child && LIVE.has(session.state))
        killGroup(session.child, "SIGTERM")
  }

  // Removes disposable profiles left by host instances that are no longer
  // running. Never touches processes: a target whose controlling pipe closed
  // with its host has already been asked to shut down by Chromium.
  reconcile(): void {
    const root = this.options.profileRoot()
    if (!existsSync(root)) return
    for (const entry of readdirSync(root)) {
      const pid = Number(entry)
      if (!Number.isInteger(pid) || pid === process.pid || isAlive(pid))
        continue
      rmSync(join(root, entry), { recursive: true, force: true })
    }
  }

  private owned(conversationId: string): AppSession[] {
    return [...this.sessions.values()].filter(
      (s) => s.conversationId === conversationId
    )
  }

  private async launch(
    conversationId: string,
    workspace: string,
    descriptor: LaunchDescriptor,
    invocationId: string | undefined,
    signal: AbortSignal
  ): Promise<SessionStatus> {
    signal.throwIfAborted()
    const live = [...this.sessions.values()].filter((s) => LIVE.has(s.state))
    const perConversation = this.options.maxPerConversation ?? 2
    if (live.filter((s) => s.conversationId === conversationId).length >= perConversation)
      throw new LaunchError(
        "session_limit",
        `This conversation already has ${perConversation} running apps.`,
        "Close one with electron_close first."
      )
    if (live.length >= (this.options.maxTotal ?? 6))
      throw new LaunchError(
        "session_limit",
        "The host's running-app limit is reached."
      )

    const session = new AppSession(conversationId, workspace, descriptor)
    this.sessions.set(session.id, session)
    if (invocationId)
      this.invocations.set(`${conversationId}:${invocationId}`, session.id)
    this.emit("change")

    const onAbort = () => {
      session.error = "Launch cancelled."
      void this.teardown(session, "failed")
    }
    signal.addEventListener("abort", onAbort, { once: true })
    try {
      await this.spawn(session)
      await this.waitForWindow(session, signal)
      session.state = "ready"
      this.emit("change")
      return session.status()
    } catch (error) {
      session.error ??= error instanceof Error ? error.message : String(error)
      await this.teardown(session, "failed")
      signal.throwIfAborted()
      throw new LaunchError(
        "launch_failed",
        session.error ?? "The app failed to start."
      )
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }

  private async spawn(session: AppSession): Promise<void> {
    const d = session.descriptor
    const root = join(this.options.profileRoot(), String(process.pid))
    await mkdir(root, { recursive: true })
    session.profileDir = await mkdtemp(join(root, "app-"))
    const home = join(session.profileDir, "home")
    await mkdir(home, { recursive: true })
    const profileArg =
      d.isolation === "north-star-test-profile"
        ? `--test-profile=${session.profileDir}`
        : `--user-data-dir=${join(session.profileDir, "user-data")}`
    const child = spawn(
      d.executable,
      ["--remote-debugging-pipe", profileArg, d.entry, ...d.args],
      {
        cwd: d.cwd,
        env: childEnvironment(process.env, home),
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
        // Own process group, so teardown can reach the app's child processes
        // (dev servers, helpers) without killing anything by name.
        detached: process.platform !== "win32",
        windowsHide: true,
      }
    )
    session.child = child
    session.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        session.exit = { code, signal }
        session.pipe?.close(new Error("The app exited."))
        if (session.state === "ready")
          session.state = code === 0 ? "exited" : "crashed"
        else if (session.state === "launching") {
          session.state = "failed"
          session.error ??= `The app exited during startup (${signal ?? `code ${code}`}).`
        }
        this.emit("change")
        resolve()
        // A self-exited or crashed app releases its group and profile now.
        if (!LIVE.has(session.state)) void this.teardown(session)
      })
    })
    child.once("error", (error) => {
      session.error = `Could not start Electron: ${error.message}`
      session.state = "failed"
      this.emit("change")
    })
    child.stdout?.setEncoding("utf8").on("data", (c: string) => session.log("stdout", c))
    child.stderr?.setEncoding("utf8").on("data", (c: string) => session.log("stderr", c))
    session.pipe = new CdpPipe(
      child.stdio[3] as Writable,
      child.stdio[4] as Readable
    )
    session.control = new WindowControl(
      session.pipe,
      () => session.windows,
      () => this.refreshWindows(session)
    )
    // Target create/navigate/destroy events keep the window list current.
    // Chromium sends no event for a title-only change, so status() also
    // refreshes on read.
    session.pipe.onEvent((event) => {
      if (event.method.startsWith("Target."))
        void this.refreshWindows(session).catch(() => {})
    })
    void session.pipe
      .send("Target.setDiscoverTargets", { discover: true }, { timeoutMs: 30_000 })
      .catch(() => {})
  }

  private async waitForWindow(
    session: AppSession,
    signal: AbortSignal
  ): Promise<void> {
    const deadline = session.startedAt + session.descriptor.startupTimeoutMs
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      if (session.state !== "launching")
        throw new Error(session.error ?? "The app exited during startup.")
      if (session.pipe && !session.pipe.closed) {
        await this.refreshWindows(session).catch(() => {})
        if (session.windows.length > 0) return
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    session.error = `No app window appeared within ${session.descriptor.startupTimeoutMs} ms.`
    throw new Error(session.error)
  }

  private async refreshWindows(
    session: AppSession,
    timeoutMs = 5_000
  ): Promise<void> {
    const pipe = session.pipe
    if (!pipe || pipe.closed) return
    const { targetInfos } = await pipe.send<{
      targetInfos: { targetId: string; type: string; title: string; url: string }[]
    }>("Target.getTargets", {}, { timeoutMs })
    const windows = targetInfos
      .filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))
      .slice(0, MAX_WINDOWS)
      .map((t) => ({
        windowId: t.targetId,
        title: t.title.slice(0, 200),
        url: t.url.slice(0, 500),
      }))
    const changed = JSON.stringify(windows) !== JSON.stringify(session.windows)
    session.windows = windows
    if (changed) this.emit("change")
  }

  // Idempotent: graceful Browser.close, then SIGTERM/SIGKILL to the session's
  // own process group, then removal of its disposable profile.
  private teardown(
    session: AppSession,
    finalState?: SessionState
  ): Promise<void> {
    session.closing ??= (async () => {
      const child = session.child
      const wasLive = LIVE.has(session.state)
      if (wasLive) session.state = "closing"
      this.emit("change")
      if (child && child.exitCode === null && child.signalCode === null) {
        await session.pipe
          ?.send("Browser.close", {}, { timeoutMs: 2_000 })
          .catch(() => {})
        if (!(await settles(session.exited, 5_000))) {
          killGroup(child, "SIGTERM")
          if (!(await settles(session.exited, 3_000))) killGroup(child, "SIGKILL")
          await settles(session.exited, 3_000)
        }
      }
      // Sweep helpers the app left in its group after its main process exited.
      // The group id stays reserved while any member lives, so this cannot hit
      // an unrelated group unless the id was recycled within this window.
      if (child) killGroup(child, "SIGKILL")
      session.pipe?.close()
      if (finalState) session.state = finalState
      else if (session.state === "closing") session.state = "exited"
      const notes: string[] = []
      if (child && child.exitCode === null && child.signalCode === null)
        notes.push(`process ${child.pid} did not exit`)
      if (session.profileDir) {
        try {
          await rm(session.profileDir, { recursive: true, force: true })
        } catch (error) {
          notes.push(`profile retained at ${session.profileDir} (${(error as Error).message})`)
        }
      }
      session.cleanup = notes.length
        ? `Incomplete: ${notes.join("; ")}.`
        : "Process stopped and disposable profile removed."
      this.emit("change")
    })()
    return session.closing
  }
}

function settles(promise: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ])
}

// shortcut: Windows kills only the main process (no job object yet); child
// processes of a Windows target may survive. Qualify before claiming Windows.
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch {
    // ESRCH: the group is already gone.
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function defaultProfileRoot(slug: string): string {
  return join(tmpdir(), `${slug}-electron-apps`)
}
