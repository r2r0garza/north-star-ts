import { spawn, type ChildProcess } from "child_process"
import { existsSync, readFileSync } from "fs"
import path from "path"
import { connect, createServer } from "net"
import { stripAnsi } from "../agent/approval/ansi"
import { resolveInWorkspaceReal } from "../agent/tools/workspace"
import * as features from "../db/repositories/features"
import { getWorkspace } from "../db/repositories/workspaces"
import { getRecipeState } from "../db/repositories/app-recipe-states"
import type { MissionControlRunLink } from "../db/types"
import type { ContextSection } from "../agent/context/context-builder"
import { SEAT_CONTEXT_PRIORITY } from "./seat-context"
import {
  DEFAULT_PORT_ENV,
  DEFAULT_READY_TIMEOUT_MS,
  envRefs,
  globalSetup,
  logReady,
  lowerFirst,
  serviceSetup,
  smokePaths,
  serviceUrl,
  startOrder,
  substituteEnvRefs,
  substitutePorts,
  type AppLaunch,
  type AppPrerequisite,
  type AppService,
  type AppSetupStep,
} from "../../shared/mission-control/app-launch"
import { toolEnv, warmShellPath } from "./workspace-analysis/tool-env"
import { waitForOrphans } from "./orphans"
import type { AppRecipeStateName } from "../../shared/mission-control/app-recipe"

// Running a workspace's app for a Mission Control seat (plan 112.1, ported
// from backup:109.03). The
// harness starts the recipe's services in the seat's worktree, picks free
// ports so parallel worktrees don't collide, waits for readiness, and stops
// everything when the phase that started them ends. Services belong to an
// owner (the phase run): starting a running service again returns it.

export type ServiceStatus =
  | "starting"
  | "ready"
  | "failed"
  | "exited"
  | "stopped"

export interface ServiceView {
  key: string
  label: string
  url: string | null
  port: number | null
  status: ServiceStatus
  // Why it failed, and the end of its output (failed or exited only).
  error?: string
  outputTail?: string
}

interface RunningService {
  owner: string
  root: string
  service: AppService
  port: number | null
  child: ChildProcess | null
  status: ServiceStatus
  output: string
  error: string | null
  exited: Promise<void>
}

const OUTPUT_KEEP = 64 * 1024
const TAIL_CHARS = 2000
const POLL_MS = 250
const STOP_GRACE_MS = 3000

const running = new Map<string, RunningService>()

// Every service process the harness spawns, for the live scenario driver's
// orphan check (plan 112.2): it probes these PIDs and their process groups
// after the app's own teardown.
type SpawnListener = (spawned: {
  owner: string
  root: string
  key: string
  pid: number
}) => void
const spawnListeners = new Set<SpawnListener>()

export function onServiceSpawned(listener: SpawnListener): () => void {
  spawnListeners.add(listener)
  return () => spawnListeners.delete(listener)
}

const id = (owner: string, root: string, key: string) =>
  `${owner}\0${root}\0${key}`

function tail(text: string, chars = TAIL_CHARS): string {
  const trimmed = stripAnsi(text).trim()
  return trimmed.length > chars ? `…${trimmed.slice(-chars)}` : trimmed
}

function view(entry: RunningService, withTail: boolean): ServiceView {
  const failed = entry.status === "failed" || entry.status === "exited"
  return {
    key: entry.service.key,
    label: entry.service.label,
    url: entry.port !== null ? serviceUrl(entry.port) : null,
    port: entry.port,
    status: entry.status,
    ...(entry.error ? { error: entry.error } : {}),
    ...(failed || withTail ? { outputTail: tail(entry.output) } : {}),
  }
}

// ── ports ───────────────────────────────────────────────────────────────────

// Can we listen on this port and host? EADDRINUSE means taken; a host this
// machine doesn't have (no IPv6) doesn't count as taken.
function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once("error", (err: NodeJS.ErrnoException) =>
      resolve(err.code !== "EADDRINUSE" && err.code !== "EACCES")
    )
    server.listen({ port, host, exclusive: true }, () =>
      server.close(() => resolve(true))
    )
  })
}

// Does something accept connections on this port and host?
function accepts(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const done = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(500, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}

// Free for a service: nothing answers on it over IPv4 or IPv6 loopback (a
// server on all interfaces doesn't always block a loopback bind, since Node
// listens with SO_REUSEADDR), and it can be bound on loopback.
export async function portFree(port: number): Promise<boolean> {
  if ((await accepts(port, "127.0.0.1")) || (await accepts(port, "::1")))
    return false
  return (await canListen(port, "127.0.0.1")) && (await canListen(port, "::1"))
}

function askOsForPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once("error", reject)
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

// Ports handed to a service that hasn't stopped: never handed out twice,
// even before the service binds them.
function portsInUse(): Set<number> {
  return new Set(
    [...running.values()]
      .filter((e) => e.port !== null && e.status !== "stopped")
      .map((e) => e.port!)
  )
}

// A free loopback port: bind-probe, and retry when the probe raced another
// process or a service of ours hasn't bound its port yet.
export async function allocatePort(): Promise<number> {
  const taken = portsInUse()
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await askOsForPort()
    if (port && !taken.has(port) && (await portFree(port))) return port
  }
  throw new Error("Couldn't find a free port on this machine.")
}

// ── readiness ───────────────────────────────────────────────────────────────

async function answersHttp(port: number, pathname: string): Promise<boolean> {
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      const res = await fetch(`http://${host}:${port}${pathname}`, {
        signal: AbortSignal.timeout(2000),
        redirect: "manual",
      })
      await res.body?.cancel().catch(() => {})
      if (res.status < 500) return true
    } catch {
      // Not listening yet (or not on this address).
    }
  }
  return false
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

async function waitReady(
  entry: RunningService,
  signal?: AbortSignal
): Promise<void> {
  const { service } = entry
  const timeout = service.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  const deadline = Date.now() + timeout
  while (entry.status === "starting") {
    if (signal?.aborted) {
      entry.error = "stopped before it was ready"
      return
    }
    const ready =
      "log" in service.ready
        ? logReady(service.ready.log, stripAnsi(entry.output))
        : entry.port !== null &&
          (await answersHttp(entry.port, service.ready.http))
    // The process may have exited while the probe ran.
    if (entry.status !== "starting") return
    if (ready) {
      entry.status = "ready"
      return
    }
    if (Date.now() >= deadline) {
      entry.status = "failed"
      entry.error = `not ready after ${Math.round(timeout / 1000)} seconds (${"log" in service.ready ? `no output matched /${service.ready.log}/` : `GET ${service.ready.http} on port ${entry.port} didn't answer`})`
      await kill(entry)
      return
    }
    await delay(POLL_MS, signal)
  }
}

// ── processes ───────────────────────────────────────────────────────────────

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === "win32")
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      }).on("error", () => child.kill())
    // Its own process group: stopping it stops what it spawned (a dev
    // server's watcher, a bundler).
    else process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

async function kill(entry: RunningService): Promise<void> {
  const child = entry.child
  if (!child) return
  signalTree(child, "SIGTERM")
  const done = await Promise.race([
    entry.exited.then(() => true),
    delay(STOP_GRACE_MS).then(() => false),
  ])
  if (!done) {
    signalTree(child, "SIGKILL")
    await Promise.race([entry.exited, delay(1000)])
  }
}

function spawnService(
  entry: RunningService,
  cwd: string,
  command: string,
  env: Record<string, string>
): void {
  const isWin = process.platform === "win32"
  const child = spawn(
    isWin ? "cmd.exe" : "/bin/sh",
    isWin ? ["/d", "/s", "/c", command] : ["-c", command],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !isWin,
    }
  )
  entry.child = child
  if (child.pid)
    for (const listener of spawnListeners)
      listener({
        owner: entry.owner,
        root: entry.root,
        key: entry.service.key,
        pid: child.pid,
      })
  const keep = (chunk: Buffer) => keepOutput(entry, chunk.toString("utf8"))
  child.stdout?.on("data", keep)
  child.stderr?.on("data", keep)
  entry.exited = new Promise((resolve) => {
    child.once("error", (err) => {
      if (entry.status === "starting" || entry.status === "ready") {
        entry.status = "failed"
        entry.error = err.message
      }
      resolve()
    })
    child.once("close", (code, signal) => {
      if (entry.status === "starting") {
        entry.status = "failed"
        entry.error = `exited with ${code ?? signal ?? "an error"} before it was ready`
      } else if (entry.status === "ready") {
        entry.status = "exited"
        entry.error = `exited with ${code ?? signal ?? "an error"}`
      }
      resolve()
    })
  })
}

// The roles whose work steps may start the app: the builder (to try what it
// built) and QA (to verify it).
export const APP_LAUNCH_ROLES = new Set(["builder", "qa"])

// The launch recipe of a Mission Control run's workspace.
export function recipeForLink(
  link: MissionControlRunLink | null | undefined
): AppLaunch {
  const feature = link ? features.getFeature(link.featureId) : null
  const workspace = feature?.workspaceId
    ? getWorkspace(feature.workspaceId)
    : null
  return workspace?.appLaunch ?? { services: [] }
}

// The recipe's state on the branch a step works in, for its briefing: the
// story's branch (its worktree's), read from the database so a step never
// waits on Git to start.
export function recipeStateForStep(
  link: MissionControlRunLink | null | undefined
): AppRecipeStateName | null {
  const workspace = workspaceForLink(link)
  const story = link?.userStoryId
    ? features.getUserStory(link.userStoryId)
    : null
  if (!workspace || !story?.branch) return null
  return getRecipeState(workspace.id, story.branch)?.state ?? null
}

// The workspace behind a Mission Control run: its id and main checkout (for
// `{env:KEY}` references a worktree's untracked files don't have).
export function workspaceForLink(
  link: MissionControlRunLink | null | undefined
): { id: string; path: string } | null {
  const feature = link ? features.getFeature(link.featureId) : null
  const workspace = feature?.workspaceId
    ? getWorkspace(feature.workspaceId)
    : null
  return workspace ? { id: workspace.id, path: workspace.path } : null
}

// ── public API ──────────────────────────────────────────────────────────────

// Where a start or verification stopped (plan 112.3). Structured, so failure
// classification reads the stage and reason instead of scraping text.
export type LaunchStage =
  | "prerequisites"
  | "setup"
  | "start"
  | "ready"
  | "smoke"
  | "stop"

export type LaunchFailureReason =
  | "no_recipe"
  | "invalid_recipe"
  | "prerequisite_unavailable"
  | "setup_failed"
  | "missing_env"
  | "port_in_use"
  | "spawn_failed"
  | "exited_early"
  | "ready_timeout"
  | "smoke_status"
  | "smoke_unreachable"
  | "smoke_browser"
  | "orphans"
  | "aborted"

export interface LaunchFailure {
  stage: LaunchStage
  reason: LaunchFailureReason
  // Plain language, for the user and the repair seat.
  summary: string
  // The end of the output of what failed (a service, a setup step).
  logs: string
  service?: string
  prerequisite?: string
  // The `{env:KEY}` references nothing resolved.
  missingEnv?: string[]
  // Smoke: the URL loaded, its status, and what the browser saw.
  url?: string
  status?: number
  consoleErrors?: string[]
  failedRequests?: string[]
}

export type StartOutcome =
  | { ok: true; services: ServiceView[] }
  | {
      ok: false
      code: string
      message: string
      services: ServiceView[]
      failure?: LaunchFailure
    }

// ── .env references ─────────────────────────────────────────────────────────

// KEY=value lines of a .env file: comments, `export`, and quotes handled.
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line
    )
    if (!match) continue
    let value = match[2].trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote))
      value = value.slice(1, -1)
    else value = value.replace(/\s+#.*$/, "")
    if (quote === '"') value = value.replace(/\\n/g, "\n")
    out[match[1]] ??= value
  }
  return out
}

// The values `{env:KEY}` resolves to: the worktree's .env.local, then its
// .env, then the main checkout's (a worktree has none of its untracked
// files). The first file that has a key wins.
export function envFileValues(
  root: string,
  mainRoot?: string | null
): Record<string, string> {
  const values: Record<string, string> = {}
  const roots = [...new Set([root, ...(mainRoot ? [mainRoot] : [])])]
  for (const dir of roots)
    for (const name of [".env.local", ".env"]) {
      const file = path.join(dir, name)
      if (!existsSync(file)) continue
      try {
        for (const [k, v] of Object.entries(
          parseDotenv(readFileSync(file, "utf8"))
        ))
          values[k] ??= v
      } catch {
        // Unreadable: treated as absent.
      }
    }
  return values
}

// ── prerequisites and setup ─────────────────────────────────────────────────

const PREREQUISITE_TIMEOUT_MS = 30_000

async function checkPrerequisite(
  prerequisite: AppPrerequisite,
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal
): Promise<string | null> {
  const { check } = prerequisite
  if ("tcp" in check) {
    if (
      (await accepts(check.tcp, "127.0.0.1")) ||
      (await accepts(check.tcp, "::1"))
    )
      return null
    return `nothing answers on port ${check.tcp}`
  }
  const result = await runToCompletion({
    cwd,
    command: check.command,
    env,
    timeoutMs: PREREQUISITE_TIMEOUT_MS,
    signal,
  })
  return result.ok ? null : `\`${check.command}\` ${result.error}`
}

// One command to completion in its own process group, with a time cap.
function runToCompletion(input: {
  cwd: string
  command: string
  env: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  onOutput?: (chunk: string) => void
}): Promise<{ ok: boolean; error: string; output: string }> {
  const isWin = process.platform === "win32"
  return new Promise((resolve) => {
    let output = ""
    let child: ChildProcess
    try {
      child = spawn(
        isWin ? "cmd.exe" : "/bin/sh",
        isWin ? ["/d", "/s", "/c", input.command] : ["-c", input.command],
        {
          cwd: input.cwd,
          env: input.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: !isWin,
        }
      )
    } catch (err) {
      resolve({
        ok: false,
        error: `couldn't run: ${err instanceof Error ? err.message : String(err)}`,
        output: "",
      })
      return
    }
    const keep = (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      output = (output + text).slice(-OUTPUT_KEEP)
      input.onOutput?.(text)
    }
    child.stdout?.on("data", keep)
    child.stderr?.on("data", keep)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      signalTree(child, "SIGKILL")
    }, input.timeoutMs)
    const abort = () => signalTree(child, "SIGKILL")
    input.signal?.addEventListener("abort", abort, { once: true })
    child.once("error", (err) => {
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", abort)
      resolve({ ok: false, error: `couldn't run: ${err.message}`, output })
    })
    child.once("close", (code, sig) => {
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", abort)
      resolve(
        code === 0
          ? { ok: true, error: "", output }
          : {
              ok: false,
              error: timedOut
                ? `didn't finish within ${Math.round(input.timeoutMs / 60_000) || 1} minute${input.timeoutMs > 60_000 ? "s" : ""}`
                : `exited with ${code ?? sig ?? "an error"}`,
              output,
            }
      )
    })
  })
}

// Base environment for anything the harness runs in a worktree.
function baseEnv(cwd: string, root: string): Record<string, string> {
  const env: Record<string, string> = { ...toolEnv() }
  // Keep dev servers from opening the user's browser or waiting on a TTY.
  env.BROWSER ??= "none"
  env.CI ??= "1"
  withProjectBins(env, cwd, root)
  return env
}

// The recipe's prerequisites, then its setup steps that run before every
// service. Null when all is well.
async function prepareRecipe(input: {
  root: string
  recipe: AppLaunch
  signal?: AbortSignal
}): Promise<LaunchFailure | null> {
  const { root, recipe } = input
  for (const prerequisite of recipe.prerequisites ?? []) {
    const env = baseEnv(root, root)
    const problem = await checkPrerequisite(
      prerequisite,
      root,
      env,
      input.signal
    )
    if (problem)
      return {
        stage: "prerequisites",
        reason: "prerequisite_unavailable",
        prerequisite: prerequisite.key,
        summary: `the app needs ${lowerFirst(prerequisite.label)}, and it isn't available (${problem})${prerequisite.hint ? `. ${prerequisite.hint}` : ""}`,
        logs: "",
      }
  }
  for (const step of globalSetup(recipe)) {
    let cwd: string
    try {
      cwd = await resolveInWorkspaceReal(root, step.cwd || ".")
    } catch (err) {
      return setupFailure(
        step,
        err instanceof Error ? err.message : String(err),
        ""
      )
    }
    const result = await runToCompletion({
      cwd,
      command: step.command,
      env: baseEnv(cwd, root),
      timeoutMs: SETUP_TIMEOUT_MS,
      signal: input.signal,
    })
    if (!result.ok) return setupFailure(step, result.error, result.output)
  }
  return null
}

function setupFailure(
  step: AppSetupStep,
  error: string,
  output: string
): LaunchFailure {
  return {
    stage: "setup",
    reason: "setup_failed",
    ...(step.service ? { service: step.service } : {}),
    summary: `the setup step "${step.label}" (\`${step.command}\`) ${error}`,
    logs: tail(output),
  }
}

// Start `keys` (default: all) and their dependencies in `root`, dependencies
// first, each awaited until ready. A service this owner already has running
// is reused. Before the first service it starts, the recipe's prerequisites
// are checked and its setup steps run. Stops at the first service that
// fails; the ones already started keep running (they're the owner's, stopped
// at phase end). `mainRoot` is the main checkout, for `{env:KEY}` references
// a worktree's untracked .env files don't have.
export async function startServices(input: {
  owner: string
  root: string
  recipe: AppLaunch
  keys?: string[]
  signal?: AbortSignal
  mainRoot?: string | null
}): Promise<StartOutcome> {
  const { owner, root, recipe } = input
  if (!recipe.services.length)
    return {
      ok: false,
      code: "no_recipe",
      message:
        "This workspace has no app launch recipe, so there's nothing to start.",
      services: [],
    }
  let order: AppService[]
  try {
    order = startOrder(recipe, input.keys)
  } catch (err) {
    return {
      ok: false,
      code: "unknown_service",
      message: err instanceof Error ? err.message : String(err),
      services: [],
    }
  }
  await warmShellPath()
  const results: ServiceView[] = []
  const ports: Record<string, number | null> = {}
  let prepared = false
  let envValues: Record<string, string> | null = null
  for (const service of order) {
    const key = id(owner, root, service.key)
    const existing = running.get(key)
    if (
      existing &&
      (existing.status === "ready" || existing.status === "starting")
    ) {
      if (existing.status === "starting")
        await waitReady(existing, input.signal)
      ports[service.key] = existing.port
      results.push(view(existing, false))
      if (existing.status !== "ready")
        return failure(service, existing, results)
      continue
    }
    // The first service this call starts: prerequisites and setup first.
    if (!prepared) {
      prepared = true
      const problem = await prepareRecipe({
        root,
        recipe,
        signal: input.signal,
      })
      if (problem)
        return {
          ok: false,
          code:
            problem.stage === "prerequisites"
              ? "prerequisite_unavailable"
              : "setup_failed",
          message: `The app can't start: ${problem.summary}.`,
          services: results,
          failure: problem,
        }
    }
    const entry: RunningService = {
      owner,
      root,
      service,
      port: null,
      child: null,
      status: "starting",
      output: "",
      error: null,
      exited: Promise.resolve(),
    }
    const failEarly = (
      error: string,
      reason: LaunchFailureReason = "spawn_failed",
      extra: Partial<LaunchFailure> = {}
    ) => {
      entry.status = "failed"
      entry.error = error
      running.set(key, entry)
      results.push(view(entry, false))
      return failure(service, entry, results, { reason, ...extra })
    }
    if (service.port === "auto") {
      try {
        entry.port = await allocatePort()
      } catch (err) {
        return failEarly(
          err instanceof Error ? err.message : String(err),
          "port_in_use"
        )
      }
    } else if (typeof service.port === "number") {
      const holder = [...running.values()].find(
        (e) =>
          e.port === service.port &&
          (e.status === "ready" || e.status === "starting")
      )
      if (holder)
        return failEarly(
          `port ${service.port} is in use by the "${holder.service.key}" service of ${holder.owner === owner ? "this step" : "another running step"} (in ${holder.root}). Use "auto" so parallel worktrees get their own ports.`,
          "port_in_use"
        )
      if (!(await portFree(service.port)))
        return failEarly(
          `port ${service.port} is already in use by another process on this machine. Stop it, or set this service's port to "auto".`,
          "port_in_use"
        )
      entry.port = service.port
    }
    ports[service.key] = entry.port
    let cwd: string
    let command: string
    let env: Record<string, string>
    try {
      cwd = await resolveInWorkspaceReal(root, service.cwd || ".")
      command = substitutePorts(service.command, entry.port, ports)
      env = baseEnv(cwd, root)
      const missing: string[] = []
      for (const [name, value] of Object.entries(service.env ?? {})) {
        let text = substitutePorts(value, entry.port, ports)
        if (envRefs(text).length) {
          envValues ??= envFileValues(root, input.mainRoot)
          const resolved = substituteEnvRefs(text, envValues)
          missing.push(...resolved.missing)
          text = resolved.text
        }
        env[name] = text
      }
      if (missing.length)
        return failEarly(
          `${[...new Set(missing)].map((k) => `${k}`).join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} set: the recipe reads ${missing.length === 1 ? "it" : "them"} from .env.local or .env, and neither the worktree nor the main checkout has ${missing.length === 1 ? "it" : "them"}`,
          "missing_env",
          { missingEnv: [...new Set(missing)] }
        )
    } catch (err) {
      return failEarly(err instanceof Error ? err.message : String(err))
    }
    if (entry.port !== null)
      env[service.portEnv ?? DEFAULT_PORT_ENV] = String(entry.port)
    running.set(key, entry)
    for (const step of serviceSetup(recipe, service.key)) {
      let stepCommand: string
      let stepCwd: string
      try {
        stepCommand = substitutePorts(step.command, entry.port, ports)
        stepCwd = await resolveInWorkspaceReal(root, step.cwd || ".")
      } catch (err) {
        return failEarly(err instanceof Error ? err.message : String(err))
      }
      const result = await runToCompletion({
        cwd: stepCwd,
        command: stepCommand,
        env,
        timeoutMs: SETUP_TIMEOUT_MS,
        signal: input.signal,
        onOutput: (text) => keepOutput(entry, text),
      })
      if (!result.ok)
        return failEarly(
          `its setup command (\`${step.command}\`) ${result.error}`,
          "setup_failed",
          { stage: "setup" }
        )
    }
    try {
      spawnService(entry, cwd, command, env)
    } catch (err) {
      entry.status = "failed"
      entry.error = err instanceof Error ? err.message : String(err)
    }
    await waitReady(entry, input.signal)
    results.push(view(entry, false))
    if (entry.status !== "ready") {
      if (input.signal?.aborted) await kill(entry)
      return failure(service, entry, results)
    }
  }
  return { ok: true, services: results }
}

// The project's own tools first on PATH, the way a developer's activated
// shell has them: a virtualenv's entry points and node_modules binaries, in
// the service's directory and the worktree root. Without it a recipe that
// runs my-cli serve fails with "command not found" (nav-test-17).
const ENV_BINS =
  process.platform === "win32"
    ? [".venv/Scripts", "venv/Scripts", "node_modules/.bin"]
    : [".venv/bin", "venv/bin", "node_modules/.bin"]

function withProjectBins(
  env: Record<string, string>,
  cwd: string,
  root: string
): void {
  const dirs = [...new Set([cwd, root])].flatMap((base) =>
    ENV_BINS.map((bin) => path.join(base, bin)).filter((dir) => existsSync(dir))
  )
  if (!dirs.length) return
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH"
  env[key] = [...dirs, env[key]].filter(Boolean).join(path.delimiter)
  const venv = dirs.find((dir) =>
    /[\\/](\.venv|venv)[\\/](bin|Scripts)$/.test(dir)
  )
  if (venv) env.VIRTUAL_ENV ??= path.dirname(venv)
}

// Each setup step's cap (plan 112.3).
export const SETUP_TIMEOUT_MS = 5 * 60_000

function keepOutput(entry: RunningService, text: string): void {
  const next = entry.output + text
  entry.output =
    next.length > OUTPUT_KEEP ? next.slice(next.length - OUTPUT_KEEP) : next
}

// What a service's failure was, from how it ended.
function failureReason(entry: RunningService): LaunchFailureReason {
  const error = entry.error ?? ""
  if (/^not ready after/.test(error)) return "ready_timeout"
  if (/^stopped before it was ready/.test(error)) return "aborted"
  if (/before it was ready/.test(error)) return "exited_early"
  return "spawn_failed"
}

function failure(
  service: AppService,
  entry: RunningService,
  services: ServiceView[],
  extra: Partial<LaunchFailure> & { reason?: LaunchFailureReason } = {}
): StartOutcome {
  const message = `${service.label} (${service.key}) didn't start: ${entry.error ?? entry.status}.`
  const reason = extra.reason ?? failureReason(entry)
  return {
    ok: false,
    code: "service_failed",
    message,
    services,
    failure: {
      stage:
        reason === "ready_timeout" || reason === "exited_early"
          ? "ready"
          : "start",
      reason,
      service: service.key,
      summary: `${service.label} didn't start: ${entry.error ?? entry.status}`,
      logs: tail(entry.output),
      ...extra,
    },
  }
}

// The owner's services in `root`, in recipe order where known. `logs` adds
// the output tail of that service even when it's healthy.
export function serviceStatus(input: {
  owner: string
  root: string
  recipe: AppLaunch
  logs?: string
}): ServiceView[] {
  const order = input.recipe.services.map((s) => s.key)
  return [...running.values()]
    .filter((e) => e.owner === input.owner && e.root === input.root)
    .sort((a, b) => order.indexOf(a.service.key) - order.indexOf(b.service.key))
    .map((e) => view(e, e.service.key === input.logs))
}

// The URLs of the owner's services: the origins a seat's browser may open
// besides loopback ones (plan 112.4).
export function ownerServiceUrls(owner: string): string[] {
  return [...running.values()]
    .filter((e) => e.owner === owner && e.port !== null)
    .map((e) => serviceUrl(e.port!))
}

// Whether the owner's app is down: a service it started failed or exited.
// A proof step whose app went down can't verify anything (plan 112.4): its
// story goes unverified instead of rejected.
export function ownerAppFailed(owner: string): boolean {
  return [...running.values()].some(
    (e) => e.owner === owner && (e.status === "failed" || e.status === "exited")
  )
}

async function stopEntries(entries: RunningService[]): Promise<number> {
  // Dependents first: the reverse of the order they were started in.
  const live = entries.reverse()
  for (const entry of live) {
    if (entry.status === "starting" || entry.status === "ready") {
      entry.status = "stopped"
      await kill(entry)
    } else if (entry.child) await kill(entry)
    entry.status = "stopped"
    running.delete(id(entry.owner, entry.root, entry.service.key))
  }
  return live.length
}

// Stop the owner's services (all, or `keys`). Returns how many were stopped.
export function stopServices(input: {
  owner: string
  root?: string
  keys?: string[]
}): Promise<number> {
  const keys = input.keys?.length ? new Set(input.keys) : null
  return stopEntries(
    [...running.values()].filter(
      (e) =>
        e.owner === input.owner &&
        (input.root === undefined || e.root === input.root) &&
        (!keys || keys.has(e.service.key))
    )
  )
}

export { orphanProcesses, waitForOrphans } from "./orphans"

// ── verification (plan 112.3) ───────────────────────────────────────────────

// One browser load per smoke URL: what the page logged and which requests
// failed. Injected: the Playwright runner in the app (smoke-load.ts), a fake
// in tests, and the seat browser later (112.4) if it proves better.
export interface SmokePageResult {
  url: string
  // Navigation failed or answered 5xx.
  error: string | null
  consoleErrors: string[]
  failedRequests: string[]
}

export type SmokeBrowserLoad = (input: {
  urls: string[]
  cwd: string
  signal?: AbortSignal
}) => Promise<{ pages: SmokePageResult[] } | { notVerifiable: string }>

export interface VerifyStage {
  stage: LaunchStage
  ok: boolean
  ms: number
}

export interface VerifyResult {
  ok: boolean
  failure?: LaunchFailure
  // A receipt: each stage reached and how long it took.
  stages: VerifyStage[]
  services: ServiceView[]
  // Each smoke URL and what it answered.
  smoke: Array<{ url: string; status: number | null }>
  // The browser load didn't happen (no test browser yet): HTTP smoke still
  // decided the outcome.
  browserSkipped: string | null
}

async function smokeGet(
  url: string,
  signal?: AbortSignal
): Promise<number | null> {
  const parsed = new URL(url)
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      const res = await fetch(
        `http://${host}:${parsed.port}${parsed.pathname}${parsed.search}`,
        {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
          redirect: "manual",
        }
      )
      await res.body?.cancel().catch(() => {})
      return res.status
    } catch {
      // Not on this address.
    }
  }
  return null
}

// Verify a recipe by running it (plan 112.3): prerequisites, setup, start in
// dependency order, readiness, smoke (an HTTP GET below 500 per smoke path,
// then one browser load each), then stop everything and assert no process
// outlived it. The services belong to `owner` for the duration and are
// always stopped, whatever happened.
export async function verifyRecipe(input: {
  root: string
  recipe: AppLaunch
  owner: string
  signal?: AbortSignal
  mainRoot?: string | null
  browserLoad?: SmokeBrowserLoad | null
}): Promise<VerifyResult> {
  const { root, recipe, owner, signal } = input
  const stages: VerifyStage[] = []
  const smoke: VerifyResult["smoke"] = []
  let browserSkipped: string | null = null
  let services: ServiceView[] = []
  let failure: LaunchFailure | undefined
  const pids: number[] = []
  const stopListening = onServiceSpawned((spawned) => {
    if (spawned.owner === owner && spawned.root === root) pids.push(spawned.pid)
  })
  const timed = async <T>(
    stage: LaunchStage,
    run: () => Promise<T>,
    ok: (value: T) => boolean
  ): Promise<T> => {
    const started = Date.now()
    const value = await run()
    stages.push({ stage, ok: ok(value), ms: Date.now() - started })
    return value
  }
  const run = async (): Promise<LaunchFailure | undefined> => {
    const started = await timed(
      "start",
      () =>
        startServices({
          owner,
          root,
          recipe,
          signal,
          mainRoot: input.mainRoot,
        }),
      (outcome) => outcome.ok
    )
    services = started.services
    if (!started.ok) {
      return (
        started.failure ?? {
          stage: "start",
          reason: started.code === "no_recipe" ? "no_recipe" : "invalid_recipe",
          summary: started.message,
          logs: "",
        }
      )
    }
    const urls: Array<{ url: string; service: AppService }> = []
    for (const view of started.services) {
      const service = recipe.services.find((s) => s.key === view.key)
      if (!service || !view.url) continue
      for (const p of smokePaths(service))
        urls.push({ url: `${view.url}${p}`, service })
    }
    return timed(
      "smoke",
      async (): Promise<LaunchFailure | undefined> => {
        for (const { url, service } of urls) {
          const status = await smokeGet(url, signal)
          smoke.push({ url, status })
          const logs = tail(
            running.get(id(owner, root, service.key))?.output ?? ""
          )
          if (status === null)
            return {
              stage: "smoke",
              reason: "smoke_unreachable",
              service: service.key,
              url,
              summary: `${service.label} was ready, but ${url} didn't answer`,
              logs,
            }
          if (status >= 500)
            return {
              stage: "smoke",
              reason: "smoke_status",
              service: service.key,
              url,
              status,
              summary: `${service.label} answered ${url} with ${status}`,
              logs,
            }
        }
        if (!urls.length || !input.browserLoad) return undefined
        const loaded = await input.browserLoad({
          urls: urls.map((u) => u.url),
          cwd: root,
          signal,
        })
        if ("notVerifiable" in loaded) {
          browserSkipped = loaded.notVerifiable
          return undefined
        }
        const bad = loaded.pages.find(
          (p) => p.error || p.consoleErrors.length || p.failedRequests.length
        )
        if (!bad) return undefined
        const service = urls.find((u) => u.url === bad.url)?.service
        return {
          stage: "smoke",
          reason: "smoke_browser",
          ...(service ? { service: service.key } : {}),
          url: bad.url,
          consoleErrors: bad.consoleErrors,
          failedRequests: bad.failedRequests,
          summary: `${bad.url} ${bad.error ? `didn't load in a browser (${bad.error})` : `loaded with ${[bad.consoleErrors.length ? `${bad.consoleErrors.length} console error${bad.consoleErrors.length === 1 ? "" : "s"}` : "", bad.failedRequests.length ? `${bad.failedRequests.length} failed request${bad.failedRequests.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ")}`}`,
          logs: service
            ? tail(running.get(id(owner, root, service.key))?.output ?? "")
            : "",
        }
      },
      (f) => !f
    )
  }
  try {
    failure = await run()
  } finally {
    stopListening()
    const stopStarted = Date.now()
    await stopServices({ owner, root })
    const orphans = await waitForOrphans(pids)
    stages.push({
      stage: "stop",
      ok: !orphans.length,
      ms: Date.now() - stopStarted,
    })
    if (orphans.length) {
      for (const pid of orphans)
        try {
          process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL")
        } catch {
          // Gone meanwhile.
        }
      // A recipe that leaves processes behind isn't verified, even if the
      // app ran: the next start would collide with them.
      if (!failure)
        failure = {
          stage: "stop",
          reason: "orphans",
          summary: `${orphans.length} process${orphans.length === 1 ? "" : "es"} kept running after the app was stopped`,
          logs: "",
        }
    }
  }
  return { ok: !failure, failure, stages, services, smoke, browserSkipped }
}

// App quit: signal every service's process group without waiting.
export function stopAllServicesSync(): void {
  for (const entry of running.values()) {
    entry.status = "stopped"
    if (entry.child) signalTree(entry.child, "SIGTERM")
  }
  running.clear()
}

// The URLs and environment a check gets for the services it declared: the
// `{port:<key>}` placeholders in its command, `APP_<KEY>_URL` and
// `APP_<KEY>_PORT`, and BASE_URL for the first one with a port.
export function serviceEnvironment(services: ServiceView[]): {
  env: Record<string, string>
  ports: Record<string, number | null>
} {
  const env: Record<string, string> = {}
  const ports: Record<string, number | null> = {}
  for (const s of services) {
    ports[s.key] = s.port
    if (s.port === null) continue
    const name = s.key.toUpperCase().replace(/-/g, "_")
    env[`APP_${name}_URL`] = s.url!
    env[`APP_${name}_PORT`] = String(s.port)
    env.BASE_URL ??= s.url!
  }
  return { env, ports }
}

// For the tools' results: one line per service.
export function describeServices(services: ServiceView[]): string {
  return services
    .map((s) => {
      const where = s.url ? ` at ${s.url}` : ""
      const lines = [`- ${s.key} (${s.label}): ${s.status}${where}`]
      if (s.error) lines.push(`  ${s.error}`)
      if (s.outputTail)
        lines.push(
          `  output:\n${s.outputTail
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n")}`
        )
      return lines.join("\n")
    })
    .join("\n")
}

export const testAppServices = {
  get size(): number {
    return running.size
  },
  pids(): number[] {
    return [...running.values()]
      .map((e) => e.child?.pid)
      .filter((pid): pid is number => typeof pid === "number")
  },
  async clear(): Promise<void> {
    await stopEntries([...running.values()])
  },
}

// Shown to a seat that can start the app: what's configured and how to use
// it, and to a builder, that keeping it working is part of its job (plan
// 112.3: the builder's definition of done includes the recipe).
export function appLaunchContextSection(
  recipe: AppLaunch,
  role?: string,
  state?: AppRecipeStateName | null
): ContextSection {
  const briefing = appLaunchBriefing(recipe, state)
  return {
    name: "mission_control_app_launch",
    priority: SEAT_CONTEXT_PRIORITY,
    content:
      role === "builder" && recipe.services.length
        ? `${briefing}\n\n${BUILDER_START_RULE}`
        : briefing,
    provenance: {
      trust: "system",
      channel: "runtime",
      source: "mission_control_app_launch",
    },
  }
}

// QA verifies in the running app, so a build that doesn't start wastes a
// whole round (nav-test-17: the builder finished on green tests; QA's first
// app_start failed).
export const BUILDER_START_RULE =
  "Before you finish, start the app with `app_start` and check your change in it. If it won't start, fixing that is part of your work: your code, or the recipe itself with `app_launch_save` (a missing setup step such as a migration, a wrong command, an `{env:KEY}` the app needs). If your story changes how the app runs (a new service, a new environment variable, a new setup step), update the recipe with `app_launch_save`. Don't finish while the app fails to start."

function recipeLines(recipe: AppLaunch): string[] {
  return [
    ...(recipe.prerequisites ?? []).map(
      (p) => `- Needs ${p.label}${p.hint ? ` (${p.hint})` : ""}`
    ),
    ...(recipe.setup ?? []).map(
      (step) =>
        `- Setup${step.service ? ` for \`${step.service}\`` : ""}: \`${step.command}\`${step.cwd ? ` in \`${step.cwd}\`` : ""}`
    ),
    ...recipe.services.map((s) => {
      const deps = s.dependsOn?.length
        ? `, after ${s.dependsOn.join(", ")}`
        : ""
      const port =
        s.port === "auto" && !s.command.includes("{port")
          ? `, port in $${s.portEnv ?? DEFAULT_PORT_ENV}`
          : ""
      return `- \`${s.key}\` (${s.label}): \`${s.command}\`${s.cwd ? ` in \`${s.cwd}\`` : ""}${port}${deps}`
    }),
  ]
}

export function appLaunchBriefing(
  recipe: AppLaunch,
  state?: AppRecipeStateName | null
): string {
  if (!recipe.services.length)
    return [
      "## Making the app startable (required)",
      "This workspace has no app launch recipe yet, so Mission Control can't start the app for QA, the acceptance gates, or the stories after yours. Part of your job is fixing that: once your work makes the app runnable, call `app_launch_save` with how to start it (the command, its directory, and a readiness check, plus any setup steps and .env keys it needs). The app must let Mission Control choose its port (an environment variable or a `{port}` argument) so parallel worktrees don't collide. The recipe is tried in your worktree and saved only if the app starts and its pages load; fix whatever stops it and call again. Don't finish while the app runs but no recipe is saved. If your story's changes don't make anything runnable yet, say so in your summary.",
    ].join("\n")
  const unproven =
    recipe.services.some((s) => s.provisional) ||
    (state !== "verified" &&
      recipe.services.every((s) => s.source === "detector"))
  if (unproven)
    return [
      "## Running the app (recipe drafted, not yet proven)",
      "Mission Control will start the app with the recipe below, drafted from the project's files (or planned from the feature's intent) before anyone ran it. Start it with `app_start`. If it doesn't start the app — a missing setup step, environment variable, or service — call `app_launch_save` with a recipe that works; it replaces this one only if this one can't start the app or yours adds a service. Don't start the app by hand with a shell command. Everything you start is stopped when this step ends.",
      ...recipeLines(recipe),
    ].join("\n")
  return [
    "## Running the app",
    "This workspace has an app launch recipe. Start the app with `app_start` (it runs setup, picks free ports, waits until each service is ready, and returns the URLs); check on it with `app_status` and stop it with `app_stop`. Don't start these services by hand with a shell command: the ports would collide with other worktrees, and nothing would stop them. Everything you start is stopped when this step ends. If the app needs a service, setup step, or environment variable this recipe doesn't have, a builder adds it with `app_launch_save`.",
    ...recipeLines(recipe),
  ].join("\n")
}
