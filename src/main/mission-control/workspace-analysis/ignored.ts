import path from "path"
import type { EcosystemId, ProjectRoot } from "./inventory"

// Stage 3 (plan 106.11): classify what the workspace has that a fresh
// worktree won't (`git ls-files --others --ignored --directory`). Known names
// are classified by rule; the rest are "unknown" for the model to look at.

export type IgnoredClass =
  | "environment"
  | "local-config"
  | "database"
  | "build-output"
  | "noise"
  | "unknown"

export interface IgnoredEntry {
  // Workspace-relative, no trailing slash.
  path: string
  directory: boolean
  class: IgnoredClass
  // The project root it sits in (workspace-relative).
  root: string
  // For environments: the ecosystem that creates it.
  ecosystem?: EcosystemId
  // For build outputs: whether a rebuild is heavy (native, JVM, Apple).
  heavy?: boolean
}

// Environment directories and the ecosystems that create them.
const ENVIRONMENTS: Array<{
  match: (name: string, rel: string) => boolean
  ecosystems: EcosystemId[]
}> = [
  {
    match: (n) => n === ".venv" || n === "venv" || n === "__pypackages__",
    ecosystems: ["uv", "poetry", "pipenv", "pip"],
  },
  { match: (n) => n === ".conda", ecosystems: ["conda"] },
  {
    match: (n) => n === "node_modules",
    ecosystems: ["pnpm", "npm", "yarn", "bun", "deno"],
  },
  {
    match: (_n, rel) =>
      rel === ".yarn/cache" ||
      rel === ".yarn/unplugged" ||
      rel === ".pnp.cjs" ||
      rel === ".pnp.loader.mjs" ||
      rel === ".yarn/install-state.gz",
    ecosystems: ["yarn"],
  },
  { match: (_n, rel) => rel === "vendor/bundle", ecosystems: ["bundler"] },
  { match: (n) => n === "vendor", ecosystems: ["composer", "bundler", "go"] },
  { match: (n) => n === "Pods", ecosystems: ["cocoapods"] },
  {
    match: (_n, rel) =>
      rel === "Carthage/Build" ||
      rel === "Carthage/Checkouts" ||
      rel === "Carthage",
    ecosystems: ["carthage"],
  },
  {
    match: (n) =>
      n === ".dart_tool" ||
      n === ".packages" ||
      n === ".flutter-plugins" ||
      n === ".flutter-plugins-dependencies",
    ecosystems: ["pub", "melos"],
  },
  {
    match: (n) => n === "dbt_packages" || n === "dbt_modules",
    ecosystems: ["dbt"],
  },
  { match: (n) => n === "vcpkg_installed", ecosystems: ["vcpkg"] },
  { match: (n) => n === ".bundle", ecosystems: ["bundler"] },
]

const LOCAL_CONFIG_NAMES = new Set([
  ".env",
  ".envrc",
  "local.properties",
  "local.settings.json",
  "master.key",
  ".npmrc",
  ".yarnrc",
  "gradle.properties",
  "launchSettings.json",
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
  "compose.override.yml",
  "compose.override.yaml",
  "secrets.json",
  "Secrets.xcconfig",
  "GoogleService-Info.plist",
  "google-services.json",
])

// Examples and templates are usually tracked; if ignored they aren't needed.
const TEMPLATE = /\.(example|sample|template|dist|defaults?)(\.|$)/i

const BUILD_OUTPUTS = new Set([
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  ".build",
  "DerivedData",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".vite",
  ".angular",
  ".expo",
  ".output",
  "storybook-static",
  "_build",
  "builddir",
  ".cxx",
  ".externalNativeBuild",
  ".kotlin",
  "cmake-build-debug",
  "cmake-build-release",
  "public/build",
  "bootstrap/cache",
])

const HEAVY_OUTPUTS = new Set([
  "target",
  ".build",
  "DerivedData",
  "obj",
  "bin",
  ".cxx",
  ".externalNativeBuild",
  "builddir",
])

const NOISE_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".idea",
  ".vscode",
  ".fleet",
  ".history",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".hypothesis",
  ".coverage",
  "coverage",
  "htmlcov",
  ".nyc_output",
  ".cache",
  ".eslintcache",
  ".stylelintcache",
  ".sass-cache",
  ".gradle",
  ".eggs",
  "logs",
  "tmp",
  "temp",
  ".terraform",
  ".vagrant",
  ".swiftpm",
  "xcuserdata",
  "captures",
])

function rootOf(roots: ProjectRoot[], rel: string): string {
  let best = ""
  for (const root of roots) {
    if (!root.dir) continue
    if (
      (rel === root.dir || rel.startsWith(`${root.dir}/`)) &&
      root.dir.length > best.length
    )
      best = root.dir
  }
  return best
}

export function classifyIgnored(
  entries: string[],
  roots: ProjectRoot[]
): IgnoredEntry[] {
  const out: IgnoredEntry[] = []
  for (const raw of entries) {
    const directory = raw.endsWith("/")
    const p = raw.replace(/\/+$/, "")
    if (!p) continue
    const name = path.posix.basename(p)
    const root = rootOf(roots, p)
    const inRoot = root ? p.slice(root.length + 1) : p
    const rootInfo = roots.find((r) => r.dir === root)
    const base = { path: p, directory, root }
    // Inside something already classified (node_modules/…): skip.
    if (out.some((e) => e.directory && p.startsWith(`${e.path}/`))) continue
    // An ignored Xcode project that Tuist or XcodeGen generates is rebuilt per
    // worktree like an environment.
    if (/\.(xcodeproj|xcworkspace)$/.test(name)) {
      const generator = (["tuist", "xcodegen"] as const).find((id) =>
        rootInfo?.ecosystems.includes(id)
      )
      if (generator) {
        out.push({ ...base, class: "environment", ecosystem: generator })
        continue
      }
    }
    const env = ENVIRONMENTS.find((e) => e.match(name, inRoot))
    if (env) {
      const ecosystem =
        env.ecosystems.find((id) => rootInfo?.ecosystems.includes(id)) ??
        // A vendor/ dir with no Composer/Bundler/Go root isn't an environment.
        (name === "vendor" ? undefined : env.ecosystems[0])
      if (ecosystem) {
        out.push({ ...base, class: "environment", ecosystem })
        continue
      }
    }
    if (
      NOISE_NAMES.has(name) ||
      /\.(log|tmp|swp|pyc|tsbuildinfo)$/.test(name) ||
      /\.egg-info$/.test(name)
    ) {
      out.push({ ...base, class: "noise" })
      continue
    }
    if (
      !TEMPLATE.test(name) &&
      (LOCAL_CONFIG_NAMES.has(name) ||
        /^\.env(\..+)?$/.test(name) ||
        /(^|\.)local\.[\w]+$/.test(name) ||
        /\.local$/.test(name) ||
        /\.(key|pem|p12|keystore|jks|xcconfig|user)$/.test(name) ||
        (/credentials/i.test(p) && !directory))
    ) {
      out.push({ ...base, class: "local-config" })
      continue
    }
    if (/\.(sqlite3?|db|db3)$/.test(name) && !directory) {
      out.push({ ...base, class: "database" })
      continue
    }
    if (
      BUILD_OUTPUTS.has(name) ||
      BUILD_OUTPUTS.has(inRoot) ||
      /^cmake-build-/.test(name) ||
      /^bazel-/.test(name)
    ) {
      out.push({
        ...base,
        class: "build-output",
        heavy:
          HEAVY_OUTPUTS.has(name) ||
          /^cmake-build-|^bazel-/.test(name) ||
          (name === "build" &&
            !!rootInfo?.ecosystems.some((e) =>
              ["cmake", "meson", "gradle"].includes(e)
            )),
      })
      continue
    }
    out.push({ ...base, class: "unknown" })
  }
  return out
}
