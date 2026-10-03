// App launch recipes (plan 109.03). How a workspace's app is started, so a
// Mission Control seat can say "start the app" and get working URLs back. The
// recipe lives on the workspace (next to its worktree setup) and lists the
// services to run. Shared by the main process (which validates, stores, and
// runs it) and the renderer (which edits it and shows the same errors).
// Everything here is pure: spawning and readiness polling are in
// src/main/mission-control/app-launch.ts.

export interface AppLaunch {
  services: AppService[]
}

export type AppServiceReady = { http: string } | { log: string }

export interface AppService {
  // Slug, unique in the recipe. Placeholders and dependsOn refer to it.
  key: string
  label: string
  // One shell command, run in `cwd`.
  command: string
  // Workspace-relative directory; "" is the workspace root.
  cwd: string
  // "auto": the harness picks a free port per run, so parallel worktrees
  // don't collide. A number is used as is. "none": the service doesn't
  // listen (a worker), so it must be ready by log.
  port: "auto" | "none" | number
  // The environment variable the port is passed in. Default PORT.
  portEnv?: string
  env?: Record<string, string>
  // Ready when an HTTP GET of this path answers below 500, or when the
  // service's output matches this regular expression.
  ready: AppServiceReady
  readyTimeoutMs?: number
  // Services started first. A `{port:<key>}` placeholder is an implicit
  // dependency too.
  dependsOn?: string[]
  // Who wrote it: the user, or an applied workspace-analysis finding.
  source: "user" | "analysis"
  findingKey?: string
}

export const DEFAULT_PORT_ENV = "PORT"
export const DEFAULT_READY_TIMEOUT_MS = 120_000
export const MAX_READY_TIMEOUT_MS = 15 * 60_000
const MIN_READY_TIMEOUT_MS = 1_000

const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PLACEHOLDER = /\{port(?::([^}]*))?\}/g

export function emptyAppLaunch(): AppLaunch {
  return { services: [] }
}

// A key from a label: "Web app" → "web-app".
export function serviceKeyFrom(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "app"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// A workspace-relative directory, or null when it would leave the workspace.
function relativeDir(value: string): string | null {
  const p = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")
  if (p === "." || p === "") return ""
  if (/^[a-zA-Z]:/.test(p) || p.split("/").includes("..")) return null
  return p
}

// The service keys a text's `{port:<key>}` placeholders name. A bare
// `{port}` is the service's own port and isn't listed.
export function placeholderKeys(text: string): string[] {
  const keys: string[] = []
  for (const match of text.matchAll(PLACEHOLDER))
    if (match[1] !== undefined) keys.push(match[1].trim())
  return keys
}

// Replace `{port}` with the service's own port and `{port:<key>}` with
// another service's. Throws on a key with no port: the recipe validator
// refuses those, so this only fires on a recipe that bypassed it.
export function substitutePorts(
  text: string,
  own: number | null,
  ports: Record<string, number | null>
): string {
  return text.replace(PLACEHOLDER, (_all, key: string | undefined) => {
    const port = key === undefined ? own : ports[key.trim()]
    if (port === null || port === undefined)
      throw new Error(
        key === undefined
          ? "`{port}` is used, but this service has no port"
          : `\`{port:${key}}\` names a service with no port`
      )
    return String(port)
  })
}

// What a service needs started before it: dependsOn plus the services its
// command and env refer to.
export function dependenciesOf(service: AppService): string[] {
  const refs = [
    ...placeholderKeys(service.command),
    ...Object.values(service.env ?? {}).flatMap(placeholderKeys),
  ]
  return [...new Set([...(service.dependsOn ?? []), ...refs])].filter(
    (key) => key !== service.key
  )
}

// The services to start for `wanted` (default: all), dependencies first, in
// recipe order otherwise. Throws on an unknown key or a cycle; a validated
// recipe has neither.
export function startOrder(recipe: AppLaunch, wanted?: string[]): AppService[] {
  const byKey = new Map(recipe.services.map((s) => [s.key, s]))
  const order: AppService[] = []
  const state = new Map<string, "visiting" | "done">()
  const visit = (key: string, path: string[]) => {
    const service = byKey.get(key)
    if (!service)
      throw new Error(
        `No service "${key}" in the app launch recipe. Services: ${recipe.services.map((s) => s.key).join(", ") || "none"}.`
      )
    if (state.get(key) === "done") return
    if (state.get(key) === "visiting")
      throw new Error(
        `The services depend on each other in a cycle: ${[...path.slice(path.indexOf(key)), key].join(" → ")}.`
      )
    state.set(key, "visiting")
    for (const dep of dependenciesOf(service)) visit(dep, [...path, key])
    state.set(key, "done")
    order.push(service)
  }
  for (const key of wanted?.length ? wanted : recipe.services.map((s) => s.key))
    visit(key, [])
  return order
}

// Does a readiness log pattern match this output? An invalid pattern never
// matches (the validator refuses those).
export function logReady(pattern: string, output: string): boolean {
  try {
    return new RegExp(pattern, "m").test(output)
  } catch {
    return false
  }
}

export type AppLaunchValidation =
  | { ok: true; recipe: AppLaunch }
  | { ok: false; errors: string[]; recipe: AppLaunch }

// Validate a recipe for saving: well-formed services, unique keys, known
// dependencies and placeholders, no cycles. `recipe` is the normalized
// recipe either way (with the invalid services dropped when not ok), which
// is what a stored value is read as.
export function validateAppLaunch(value: unknown): AppLaunchValidation {
  const errors: string[] = []
  const raw =
    isRecord(value) && Array.isArray(value.services) ? value.services : []
  if (value !== undefined && value !== null && !isRecord(value))
    errors.push("The app launch recipe must be an object with a services list.")
  const services: AppService[] = []
  const keys = new Set<string>()
  raw.forEach((item, index) => {
    const name = `Service ${index + 1}`
    if (!isRecord(item)) {
      errors.push(`${name} isn't an object.`)
      return
    }
    const label = typeof item.label === "string" ? item.label.trim() : ""
    const key =
      typeof item.key === "string" && item.key.trim()
        ? item.key.trim()
        : serviceKeyFrom(label)
    const called = `${name} (${key})`
    if (!KEY.test(key)) {
      errors.push(
        `${name}: its key "${key}" must be lowercase letters, digits, and dashes (up to 32).`
      )
      return
    }
    if (keys.has(key)) {
      errors.push(`Two services have the key "${key}".`)
      return
    }
    const command = typeof item.command === "string" ? item.command.trim() : ""
    if (!command) {
      errors.push(`${called} needs a command.`)
      return
    }
    if (/[\n\r]/.test(command)) {
      errors.push(`${called}: the command must be one line.`)
      return
    }
    const cwd = relativeDir(typeof item.cwd === "string" ? item.cwd : "")
    if (cwd === null) {
      errors.push(`${called}: its directory must be inside the workspace.`)
      return
    }
    let port: AppService["port"]
    if (item.port === "auto" || item.port === undefined || item.port === null)
      port = "auto"
    else if (item.port === "none") port = "none"
    else if (
      typeof item.port === "number" &&
      Number.isInteger(item.port) &&
      item.port > 0 &&
      item.port < 65536
    )
      port = item.port
    else {
      errors.push(
        `${called}: the port must be "auto", "none", or a number from 1 to 65535.`
      )
      return
    }
    const portEnv =
      typeof item.portEnv === "string" && item.portEnv.trim()
        ? item.portEnv.trim()
        : DEFAULT_PORT_ENV
    if (!ENV_NAME.test(portEnv)) {
      errors.push(`${called}: "${portEnv}" isn't an environment variable name.`)
      return
    }
    const env: Record<string, string> = {}
    if (isRecord(item.env)) {
      for (const [k, v] of Object.entries(item.env)) {
        if (!ENV_NAME.test(k) || typeof v !== "string") {
          errors.push(
            `${called}: the environment variable "${k}" needs a valid name and a text value.`
          )
          return
        }
        env[k] = v
      }
    }
    const readyRaw = isRecord(item.ready) ? item.ready : {}
    let ready: AppServiceReady
    if (typeof readyRaw.log === "string" && readyRaw.log.trim()) {
      try {
        new RegExp(readyRaw.log)
      } catch {
        errors.push(
          `${called}: the readiness pattern "${readyRaw.log}" isn't a valid regular expression.`
        )
        return
      }
      ready = { log: readyRaw.log }
    } else {
      const http =
        typeof readyRaw.http === "string" && readyRaw.http.trim()
          ? readyRaw.http.trim()
          : "/"
      if (!http.startsWith("/")) {
        errors.push(
          `${called}: the readiness path must start with "/" (it's a path on the service).`
        )
        return
      }
      ready = { http }
    }
    if ("http" in ready && port === "none") {
      errors.push(
        `${called} has no port, so it can't be checked over HTTP. Wait for a log line instead.`
      )
      return
    }
    let readyTimeoutMs: number | undefined
    if (item.readyTimeoutMs !== undefined && item.readyTimeoutMs !== null) {
      if (
        typeof item.readyTimeoutMs !== "number" ||
        !Number.isFinite(item.readyTimeoutMs) ||
        item.readyTimeoutMs < MIN_READY_TIMEOUT_MS ||
        item.readyTimeoutMs > MAX_READY_TIMEOUT_MS
      ) {
        errors.push(
          `${called}: the readiness timeout must be between ${MIN_READY_TIMEOUT_MS / 1000} seconds and ${MAX_READY_TIMEOUT_MS / 60_000} minutes.`
        )
        return
      }
      readyTimeoutMs = Math.round(item.readyTimeoutMs)
    }
    const dependsOn = Array.isArray(item.dependsOn)
      ? [
          ...new Set(
            item.dependsOn
              .filter((d): d is string => typeof d === "string")
              .map((d) => d.trim())
              .filter(Boolean)
          ),
        ]
      : []
    keys.add(key)
    services.push({
      key,
      label: label || key,
      command,
      cwd,
      port,
      ...(portEnv !== DEFAULT_PORT_ENV ? { portEnv } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ready,
      ...(readyTimeoutMs !== undefined ? { readyTimeoutMs } : {}),
      ...(dependsOn.length ? { dependsOn } : {}),
      source: item.source === "analysis" ? "analysis" : "user",
      ...(typeof item.findingKey === "string" && item.findingKey
        ? { findingKey: item.findingKey }
        : {}),
    })
  })

  // References between services: known keys, ports where a port is used.
  const byKey = new Map(services.map((s) => [s.key, s]))
  const valid = services.filter((service) => {
    const before = errors.length
    for (const dep of service.dependsOn ?? [])
      if (dep === service.key)
        errors.push(`${service.key} can't depend on itself.`)
      else if (!byKey.has(dep))
        errors.push(
          `${service.key} depends on "${dep}", which isn't a service.`
        )
    const texts = [service.command, ...Object.values(service.env ?? {})]
    for (const text of texts) {
      for (const ref of placeholderKeys(text)) {
        const other = byKey.get(ref)
        if (!other)
          errors.push(
            `${service.key} uses {port:${ref}}, but there's no service "${ref}".`
          )
        else if (other.port === "none")
          errors.push(
            `${service.key} uses {port:${ref}}, but ${ref} has no port.`
          )
      }
      if (service.port === "none" && /\{port\}/.test(text))
        errors.push(`${service.key} uses {port}, but it has no port.`)
    }
    return errors.length === before
  })
  const recipe: AppLaunch = { services: valid }
  try {
    startOrder(recipe)
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err))
    return { ok: false, errors, recipe: { services: [] } }
  }
  return errors.length ? { ok: false, errors, recipe } : { ok: true, recipe }
}

// A stored recipe, read leniently: what validates is kept. A recipe with a
// cycle (which can't be saved) reads as empty.
export function normalizeAppLaunch(value: unknown): AppLaunch {
  return validateAppLaunch(value).recipe
}

// The URL a service is reached at.
export function serviceUrl(port: number): string {
  return `http://localhost:${port}`
}
