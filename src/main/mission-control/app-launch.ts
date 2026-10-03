import { spawn, type ChildProcess } from "child_process"
import { connect, createServer } from "net"
import { stripAnsi } from "../agent/approval/ansi"
import { resolveInWorkspaceReal } from "../agent/tools/workspace"
import * as features from "../db/repositories/features"
import { getWorkspace } from "../db/repositories/workspaces"
import type { MissionControlRunLink } from "../db/types"
import type { ContextSection } from "../agent/context/context-builder"
import { SEAT_CONTEXT_PRIORITY } from "./seat-context"
import {
  DEFAULT_PORT_ENV,
  DEFAULT_READY_TIMEOUT_MS,
  logReady,
  serviceUrl,
  startOrder,
  substitutePorts,
  type AppLaunch,
  type AppService,
} from "../../shared/mission-control/app-launch"
import { toolEnv, warmShellPath } from "./workspace-analysis/tool-env"

// Running a workspace's app for a Mission Control seat (plan 109.03). The
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
  const keep = (chunk: Buffer) => {
    const next = entry.output + chunk.toString("utf8")
    entry.output =
      next.length > OUTPUT_KEEP ? next.slice(next.length - OUTPUT_KEEP) : next
  }
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

// ── public API ──────────────────────────────────────────────────────────────

export type StartOutcome =
  | { ok: true; services: ServiceView[] }
  | { ok: false; code: string; message: string; services: ServiceView[] }

// Start `keys` (default: all) and their dependencies in `root`, dependencies
// first, each awaited until ready. A service this owner already has running
// is reused. Stops at the first service that fails; the ones already started
// keep running (they're the owner's, stopped at phase end).
export async function startServices(input: {
  owner: string
  root: string
  recipe: AppLaunch
  keys?: string[]
  signal?: AbortSignal
}): Promise<StartOutcome> {
  const { owner, root, recipe } = input
  if (!recipe.services.length)
    return {
      ok: false,
      code: "no_recipe",
      message:
        "This workspace has no app launch recipe, so there's nothing to start. The user can add one under the Feature's Advanced settings → App launch.",
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
    const failEarly = (error: string) => {
      entry.status = "failed"
      entry.error = error
      running.set(key, entry)
      results.push(view(entry, false))
      return failure(service, entry, results)
    }
    if (service.port === "auto") {
      try {
        entry.port = await allocatePort()
      } catch (err) {
        return failEarly(err instanceof Error ? err.message : String(err))
      }
    } else if (typeof service.port === "number") {
      const holder = [...running.values()].find(
        (e) =>
          e.port === service.port &&
          (e.status === "ready" || e.status === "starting")
      )
      if (holder)
        return failEarly(
          `port ${service.port} is in use by the "${holder.service.key}" service of ${holder.owner === owner ? "this step" : "another running step"} (in ${holder.root}). Use "auto" so parallel worktrees get their own ports.`
        )
      if (!(await portFree(service.port)))
        return failEarly(
          `port ${service.port} is already in use by another process on this machine. Stop it, or set this service's port to "auto".`
        )
      entry.port = service.port
    }
    ports[service.key] = entry.port
    let cwd: string
    let command: string
    const env: Record<string, string> = { ...toolEnv() }
    try {
      cwd = await resolveInWorkspaceReal(root, service.cwd || ".")
      command = substitutePorts(service.command, entry.port, ports)
      for (const [name, value] of Object.entries(service.env ?? {}))
        env[name] = substitutePorts(value, entry.port, ports)
    } catch (err) {
      return failEarly(err instanceof Error ? err.message : String(err))
    }
    if (entry.port !== null)
      env[service.portEnv ?? DEFAULT_PORT_ENV] = String(entry.port)
    // Keep dev servers from opening the user's browser or waiting on a TTY.
    env.BROWSER ??= "none"
    env.CI ??= "1"
    running.set(key, entry)
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

function failure(
  service: AppService,
  entry: RunningService,
  services: ServiceView[]
): StartOutcome {
  return {
    ok: false,
    code: "service_failed",
    message: `${service.label} (${service.key}) didn't start: ${entry.error ?? entry.status}.`,
    services,
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

// Shown to a seat that can start the app: what's configured and how to use it.
export function appLaunchContextSection(recipe: AppLaunch): ContextSection {
  return {
    name: "mission_control_app_launch",
    priority: SEAT_CONTEXT_PRIORITY,
    content: appLaunchBriefing(recipe),
    provenance: {
      trust: "system",
      channel: "runtime",
      source: "mission_control_app_launch",
    },
  }
}

export function appLaunchBriefing(recipe: AppLaunch): string {
  return [
    "## Running the app",
    "This workspace has an app launch recipe. Start the app with `app_start` (it picks free ports, waits until each service is ready, and returns the URLs); check on it with `app_status` and stop it with `app_stop`. Don't start these services by hand with a shell command: the ports would collide with other worktrees, and nothing would stop them. Everything you start is stopped when this step ends.",
    ...recipe.services.map((s) => {
      const deps = s.dependsOn?.length
        ? `, after ${s.dependsOn.join(", ")}`
        : ""
      return `- \`${s.key}\` (${s.label}): \`${s.command}\`${s.cwd ? ` in \`${s.cwd}\`` : ""}${deps}`
    }),
  ].join("\n")
}
