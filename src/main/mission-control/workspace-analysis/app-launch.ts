import { existsSync } from "fs"
import path from "path"
import {
  serviceKeyFrom,
  validateAppLaunch,
} from "../../../shared/mission-control/app-launch"
import type {
  AppServiceShape,
  Evidence,
} from "../../../shared/mission-control/workspace-analysis"
import type { FindingDraft } from "./draft"
import { git } from "./exec"
import { detectProjects, type EcosystemId, type ProjectRoot } from "./inventory"

// The app launch finding (plan 109.03): from evidence in the workspace,
// propose how Mission Control seats start the app. package.json scripts
// (`dev`, `start`, `preview`) with the framework's way of taking a port, a
// Procfile's web process, a plain Node server file that reads PORT, and
// Django's runserver. A docker-compose file is
// pointed out but not proposed: its fixed ports and container names collide
// across parallel worktrees. Like setup steps, the recipe persists commands,
// so it's always applied explicitly (never on its own at Start).

export const APP_LAUNCH_FINDING = "app-launch:recipe"
const MAX_SERVICES = 4

type Read = (file: string) => Promise<string | null>

interface Proposal {
  service: AppServiceShape
  evidence: Array<Omit<Evidence, "id">>
  confidence: "likely" | "guess"
}

const JS_MANAGERS: EcosystemId[] = ["pnpm", "yarn", "bun", "npm"]
const SCRIPTS = ["dev", "start", "preview"] as const

// Run a package script with extra arguments, the way each manager passes them.
function runScript(manager: EcosystemId, script: string, args: string) {
  const extra = args ? ` ${args}` : ""
  switch (manager) {
    case "pnpm":
      return `pnpm run ${script}${extra}`
    case "yarn":
      return `yarn ${script}${extra}`
    case "bun":
      return `bun run ${script}${extra}`
    default:
      return `npm run ${script}${extra ? ` --${extra}` : ""}`
  }
}

// How a dev server is told its port: an argument, or the PORT variable.
function portStyle(
  script: string,
  deps: Set<string>
): { args: string; framework: string | null } {
  const uses = (tool: string, pkg = tool) =>
    new RegExp(`(^|[\\s;&|(])${tool}(\\s|$)`).test(script) || deps.has(pkg)
  if (/\bnext\b/.test(script) || deps.has("next"))
    return { args: "", framework: "Next.js" } // reads PORT
  if (/\bnuxi?\b/.test(script) || deps.has("nuxt"))
    return { args: "", framework: "Nuxt" } // reads PORT
  if (/\breact-scripts\b/.test(script))
    return { args: "", framework: "Create React App" } // reads PORT
  if (uses("astro")) return { args: "--port {port}", framework: "Astro" }
  if (/\bng\s+serve\b/.test(script) || deps.has("@angular/cli"))
    return { args: "--port {port}", framework: "Angular" }
  if (uses("vite") || /\bsvelte-kit\b|\bremix\s+vite/.test(script))
    return { args: "--port {port} --strictPort", framework: "Vite" }
  return { args: "", framework: null }
}

function jsProposals(
  root: ProjectRoot,
  manifest: string | null
): Proposal | null {
  const manager = JS_MANAGERS.find((m) => root.ecosystems.includes(m))
  if (!manager || !manifest) return null
  let pkg: {
    scripts?: Record<string, unknown>
    dependencies?: Record<string, unknown>
    devDependencies?: Record<string, unknown>
  }
  try {
    pkg = JSON.parse(manifest)
  } catch {
    return null
  }
  const deps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ])
  const scripts = pkg.scripts ?? {}
  const name = SCRIPTS.find((s) => typeof scripts[s] === "string")
  if (!name) return null
  const script = String(scripts[name])
  // A desktop app isn't served over HTTP; the bundled Playwright runner
  // (109.06) launches Electron apps instead.
  if (deps.has("electron") || /\belectron(-vite|-forge)?\b/.test(script))
    return null
  const { args, framework } = portStyle(script, deps)
  const file = path.posix.join(root.dir, "package.json")
  const label = framework
    ? `${framework} ${name === "dev" ? "dev server" : "server"}`
    : `${root.dir || "App"} (${name})`
  return {
    service: {
      key: serviceKeyFrom(root.dir ? path.posix.basename(root.dir) : "web"),
      label,
      command: runScript(manager, name, args),
      cwd: root.dir,
      port: "auto",
      ready: { http: "/" },
    },
    evidence: [
      {
        kind: "manifest",
        label: `${file} has a "${name}" script: ${script.slice(0, 120)}`,
        path: file,
      },
    ],
    confidence: framework ? "likely" : "guess",
  }
}

// `web: <command>` in a Procfile; it reads $PORT, which the harness sets.
function procfileProposal(
  root: ProjectRoot,
  procfile: string | null
): Proposal | null {
  const line = procfile
    ?.split("\n")
    .map((l) => /^web:\s*(.+)$/.exec(l.trim())?.[1]?.trim())
    .find(Boolean)
  if (!line || /[\n;&|<>`]|\$\(/.test(line)) return null
  const file = path.posix.join(root.dir, "Procfile")
  return {
    service: {
      key: serviceKeyFrom(root.dir ? path.posix.basename(root.dir) : "web"),
      label: "Web process (Procfile)",
      command: line,
      cwd: root.dir,
      port: "auto",
      ready: { http: "/" },
    },
    evidence: [{ kind: "file", label: `${file}: web: ${line}`, path: file }],
    confidence: line.includes("$PORT") ? "likely" : "guess",
  }
}

// A dependency-free Node server (`node server.js`) with no package script to
// start it. Only one that takes its port from PORT: a fixed port collides
// across parallel worktrees.
const NODE_ENTRIES = ["server.js", "server.mjs", "server.cjs", "index.js"]

async function nodeServerProposal(
  root: ProjectRoot,
  files: Set<string>,
  read: Read
): Promise<Proposal | null> {
  for (const name of NODE_ENTRIES) {
    const file = path.posix.join(root.dir, name)
    if (!files.has(file)) continue
    const source = await read(file)
    if (
      !source ||
      !/\.listen\s*\(/.test(source) ||
      !/process\.env\.PORT\b|process\.env\[["']PORT["']\]/.test(source)
    )
      continue
    return {
      service: {
        key: serviceKeyFrom(root.dir ? path.posix.basename(root.dir) : "web"),
        label: `Node server (${name})`,
        command: `node ${name}`,
        cwd: root.dir,
        port: "auto",
        ready: { http: "/" },
      },
      evidence: [
        {
          kind: "file",
          label: `${file} starts an HTTP server on process.env.PORT`,
          path: file,
        },
      ],
      confidence: "likely",
    }
  }
  return null
}

function djangoProposal(
  root: ProjectRoot,
  workspace: string,
  managePy: string | null
): Proposal | null {
  if (!managePy || !/django/i.test(managePy)) return null
  const venv = [".venv", "venv"].find((dir) =>
    existsSync(path.join(workspace, root.dir, dir, "bin", "python"))
  )
  const python = venv ? `${venv}/bin/python` : "python3"
  const file = path.posix.join(root.dir, "manage.py")
  return {
    service: {
      key: serviceKeyFrom(root.dir ? path.posix.basename(root.dir) : "web"),
      label: "Django dev server",
      command: `${python} manage.py runserver 127.0.0.1:{port} --noreload`,
      cwd: root.dir,
      port: "auto",
      ready: { http: "/" },
    },
    evidence: [{ kind: "file", label: `${file} runs Django`, path: file }],
    confidence: "likely",
  }
}

const COMPOSE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/

export async function appLaunchDrafts(input: {
  workspace: string
  roots: ProjectRoot[]
  files: string[]
  read: Read
}): Promise<FindingDraft[]> {
  const proposals: Proposal[] = []
  const files = new Set(input.files)
  // A workspace with no manifest at all (plain HTML and a server.js) has no
  // project root; its top level can still be an app.
  const roots: ProjectRoot[] = input.roots.length
    ? input.roots
    : [{ dir: "", ecosystems: [] } as unknown as ProjectRoot]
  for (const root of roots) {
    if (proposals.length >= MAX_SERVICES) break
    const at = (name: string) => path.posix.join(root.dir, name)
    const proposal =
      procfileProposal(root, await input.read(at("Procfile"))) ??
      jsProposals(root, await input.read(at("package.json"))) ??
      (root.ecosystems.some((e) =>
        ["pip", "uv", "poetry", "pipenv", "conda"].includes(e)
      )
        ? djangoProposal(
            root,
            input.workspace,
            await input.read(at("manage.py"))
          )
        : null) ??
      (await nodeServerProposal(root, files, input.read))
    if (proposal) proposals.push(proposal)
  }
  // Keys stay unique across roots ("web", "web-2").
  const keys = new Set<string>()
  for (const p of proposals) {
    let key = p.service.key
    for (let n = 2; keys.has(key); n++) key = `${p.service.key}-${n}`
    keys.add(key)
    p.service.key = key
  }
  const services = proposals.map((p) => p.service)
  const drafts: FindingDraft[] = []
  if (
    services.length &&
    validateAppLaunch({
      services: services.map((s) => ({ ...s, source: "analysis" })),
    }).ok
  ) {
    const names = services.map((s) => s.label).join(", ")
    drafts.push({
      key: APP_LAUNCH_FINDING,
      category: "app-launch",
      severity: "info",
      title: `Seats can't start the app yet`,
      explanation: `To test what they build, the builder and QA seats start the app through Mission Control, which gives each worktree its own ports and stops it when the step ends. This workspace looks like it runs as ${names}. Save that as the app launch recipe, then adjust it in Advanced settings → App launch if it needs more (a backend, environment variables).`,
      evidence: proposals.flatMap((p) => p.evidence),
      confidence: proposals.every((p) => p.confidence === "likely")
        ? "likely"
        : "guess",
      source: "recipe",
      fix: {
        kind: "apply-settings",
        summary: `Start ${services.map((s) => `\`${s.command}\``).join(" and ")} on a free port`,
        patch: { appLaunch: { add: services } },
      },
    })
  }
  const compose = input.files
    .filter((f) => COMPOSE.test(f))
    .filter(
      (f) => !f.split("/").some((s) => ["node_modules", "vendor"].includes(s))
    )
    .slice(0, 2)
  if (compose.length)
    drafts.push({
      key: "app-launch:compose",
      category: "app-launch",
      severity: "info",
      title: "Containers aren't started for seats",
      explanation: `${compose.join(", ")} defines services with fixed ports and container names, which collide when parallel worktrees start them. If the app needs them, add them to the app launch recipe by hand with a port placeholder (for example \`docker compose -p story-{port} up\` and a published port of \`{port}\`), or keep them running yourself outside Mission Control.`,
      evidence: compose.map((f) => ({
        kind: "file" as const,
        label: `${f} exists`,
        path: f,
      })),
      confidence: "guess",
      source: "rule",
      fix: {
        kind: "manual",
        summary: "Add container services by hand",
        steps: [
          "In Advanced settings → App launch, add a service per container the app needs, with a project name and published port that use {port}.",
        ],
      },
    })
  return drafts
}

const MAX_REF_FILES = 20_000

// The app launch drafts for a branch's tip rather than the checkout (plan
// 109.07): a milestone's earlier stories land on its integration branch, so
// the app a later story tests may exist only there. Workspace-relative, like
// the checkout's analysis. Empty when the ref can't be read.
export async function appLaunchDraftsAtRef(input: {
  workspace: string
  ref: string
}): Promise<FindingDraft[]> {
  const listed = await git(
    input.workspace,
    ["ls-tree", "-r", "-z", "--name-only", input.ref],
    30_000
  )
  if (!listed.ok) return []
  const files = listed.stdout
    .split("\0")
    .filter(Boolean)
    .slice(0, MAX_REF_FILES)
  const known = new Set(files)
  const read = async (file: string) => {
    if (!known.has(file)) return null
    const shown = await git(input.workspace, ["show", `${input.ref}:./${file}`])
    return shown.ok ? shown.stdout : null
  }
  const inventory = await detectProjects(files, read)
  return appLaunchDrafts({
    workspace: input.workspace,
    roots: inventory.roots,
    files,
    read,
  })
}
