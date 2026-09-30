import type { ToolchainPin } from "./inventory"
import type { ToolSpec, VersionManager } from "./recipes"
import { run } from "./exec"

// Toolchains (plan 106.11): is each tool a project needs on the PATH, at the
// version the project pins? `<tool> --version` is passive: it never runs
// project code (wrappers like ./gradlew are never called here).

export interface ToolStatus {
  exe: string
  found: boolean
  version: string | null
  raw: string
}

const cache = new Map<string, Promise<ToolStatus>>()

// Tools are probed once per analysis run; the cache is reset per run.
export function resetToolCache() {
  cache.clear()
}

export function probeTool(
  spec: Pick<ToolSpec, "exe" | "versionArgs">,
  cwd: string
): Promise<ToolStatus> {
  const key = `${spec.exe} ${spec.versionArgs.join(" ")}`
  if (!cache.has(key))
    cache.set(
      key,
      run(spec.exe, spec.versionArgs, { cwd, timeoutMs: 15_000 }).then(
        (result) => {
          const raw = `${result.stdout}\n${result.stderr}`.trim()
          const found = !result.missing && (result.ok || /\d+\.\d+/.test(raw))
          return {
            exe: spec.exe,
            found,
            version: found ? extractVersion(raw) : null,
            raw: raw.slice(0, 300),
          }
        }
      )
    )
  return cache.get(key)!
}

export function extractVersion(text: string): string | null {
  // "Python 3.12.4", "v20.11.0", 'openjdk version "21.0.2"', "go version go1.22.3 darwin/arm64",
  // "rustc 1.79.0 (…)", "Xcode 15.4"
  // Go's "go1.22.3", then the first dotted version, then a bare
  // "version 21" (a JDK that reports only its feature release).
  const match =
    /\bgo(\d+\.\d+(?:\.\d+)?)/.exec(text) ??
    /(?:^|[^\w.])v?(\d+\.\d+(?:\.\d+){0,2})/.exec(text) ??
    /version\s+"?(\d+)/i.exec(text)
  return match ? match[1] : null
}

function parts(v: string): number[] {
  return v
    .split(/[.+-]/)
    .map((p) => Number.parseInt(p, 10))
    .filter((n) => Number.isFinite(n))
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

// Does an installed version satisfy a requirement? Null when the requirement
// isn't something we can judge ("stable", "lts/*", a complex range): then
// no finding is raised about the version.
export function satisfies(installed: string, required: string): boolean | null {
  const have = parts(installed)
  if (!have.length) return null
  const req = required.trim().replace(/^v/, "")
  if (/^(stable|beta|nightly|latest|lts|system|lts\/\*)/i.test(req)) return null
  const clauses = req.split(/\s*,\s*|\s+(?=[<>=^~])/).filter(Boolean)
  if (req.includes("||")) {
    const results = req.split("||").map((alt) => satisfies(installed, alt))
    return results.some((r) => r === true)
      ? true
      : results.every((r) => r === false)
        ? false
        : null
  }
  let judged = false
  for (const clause of clauses) {
    const m =
      /^(>=|<=|>|<|\^|~>|~=|~|==|=)?\s*v?(\d+(?:\.\d+){0,3})(\.x|\.\*)?$/.exec(
        clause
      )
    if (!m) return null
    judged = true
    const op = m[1] ?? ""
    const want = parts(m[2])
    const cmp = compare(have, want)
    const prefix = want.every((n, i) => have[i] === n)
    switch (op) {
      case ">=":
        if (cmp < 0) return false
        break
      case ">":
        if (cmp <= 0) return false
        break
      case "<=":
        if (cmp > 0 && !prefix) return false
        break
      case "<":
        if (cmp >= 0) return false
        break
      case "^":
        if (cmp < 0 || have[0] !== want[0]) return false
        break
      case "~":
      case "~>":
      case "~=":
        if (
          cmp < 0 ||
          have[0] !== want[0] ||
          (want.length > 2 && have[1] !== want[1])
        )
          return false
        break
      default:
        // An exact pin matches as a prefix: "3.12" is satisfied by 3.12.4.
        if (!prefix) return false
    }
  }
  return judged ? true : null
}

// Version managers present on this machine, for install commands.
export async function availableManagers(
  cwd: string
): Promise<Set<VersionManager>> {
  const probes: Array<[VersionManager, string, string[]]> = [
    ["mise", "mise", ["--version"]],
    ["asdf", "asdf", ["--version"]],
    ["pyenv", "pyenv", ["--version"]],
    ["uv", "uv", ["--version"]],
    ["fnm", "fnm", ["--version"]],
    ["volta", "volta", ["--version"]],
    ["rbenv", "rbenv", ["--version"]],
    ["rustup", "rustup", ["--version"]],
    ["fvm", "fvm", ["--version"]],
    ["corepack", "corepack", ["--version"]],
  ]
  const found = new Set<VersionManager>()
  await Promise.all(
    probes.map(async ([id, exe, args]) => {
      const status = await probeTool({ exe, versionArgs: args }, cwd)
      if (status.found) found.add(id)
    })
  )
  return found
}

// Which manager to offer for a tool, in order of preference.
const PREFERENCE: VersionManager[] = [
  "mise",
  "asdf",
  "uv",
  "pyenv",
  "fnm",
  "volta",
  "rbenv",
  "rustup",
  "fvm",
  "corepack",
]

export function managerCommand(
  spec: ToolSpec,
  managers: Set<VersionManager>,
  version: string | null
): { manager: VersionManager; command: string } | null {
  for (const manager of PREFERENCE) {
    const template = spec.managers?.[manager]
    if (!template || !managers.has(manager)) continue
    const needsVersion = template.includes("{version}")
    if (needsVersion && !version) continue
    return { manager, command: template.replace("{version}", version ?? "") }
  }
  return null
}

// The concrete version to install for a pin ("3.12", "18" from ">=18").
export function installableVersion(pin: ToolchainPin): string | null {
  if (pin.kind === "exact")
    return /^[\w.+-]+$/.test(pin.required) ? pin.required : null
  const m = /(\d+(?:\.\d+){0,2})/.exec(pin.required)
  return m ? m[1] : null
}

export interface PythonChoice {
  // The interpreter to create environments with.
  exe: string
  version: string | null
  // It meets the project's requires-python (true when there's none).
  satisfied: boolean
  // Every interpreter found, for the explanation when none fits.
  found: Array<{ exe: string; version: string }>
}

const PYTHON_CANDIDATES = [
  "python3",
  "python3.14",
  "python3.13",
  "python3.12",
  "python3.11",
  "python3.10",
  "python3.9",
]

// The Python to build a project's venv with: the default python3 when it
// meets requires-python, else the newest python3.x that does. macOS's
// /usr/bin/python3 is 3.9, which many projects no longer accept.
export async function choosePython(
  requirement: string | null,
  cwd: string
): Promise<PythonChoice> {
  const found: Array<{ exe: string; version: string }> = []
  for (const exe of PYTHON_CANDIDATES) {
    const status = await probeTool({ exe, versionArgs: ["--version"] }, cwd)
    if (status.found && status.version)
      found.push({ exe, version: status.version })
  }
  const fits = (version: string) =>
    !requirement || satisfies(version, requirement) !== false
  const preferred = found.find((f) => f.exe === "python3" && fits(f.version))
  const newest = found
    .filter((f) => f.exe !== "python3" && fits(f.version))
    .sort((a, b) => compare(parts(b.version), parts(a.version)))[0]
  const pick = preferred ?? newest
  if (pick)
    return { exe: pick.exe, version: pick.version, satisfied: true, found }
  const fallback = found.find((f) => f.exe === "python3") ?? found[0]
  return {
    exe: fallback?.exe ?? "python3",
    version: fallback?.version ?? null,
    satisfied: !requirement,
    found,
  }
}
