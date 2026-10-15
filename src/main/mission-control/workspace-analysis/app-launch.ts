import { existsSync } from "fs"
import path from "path"
import {
  serviceKeyFrom,
  validateAppLaunch,
  type AppLaunch,
  type AppService,
} from "../../../shared/mission-control/app-launch"
import {
  describeRecipeState,
  type AppRecipeState,
} from "../../../shared/mission-control/app-recipe"
import type { Evidence } from "../../../shared/mission-control/workspace-analysis"
import type { FindingDraft } from "./draft"
import { git } from "./exec"
import { detectProjects, type EcosystemId, type ProjectRoot } from "./inventory"

// The app launch detectors (plan 112.3, ported from backup:109.03): from
// evidence in the workspace, draft how Mission Control seats start the app.
// package.json scripts (`dev`, `start`, `preview`) with the framework's way
// of taking a port, a Procfile's web process, a plain Node server file that
// reads PORT, and Django's runserver. A docker-compose file is pointed out
// but never used automatically: its fixed ports and container names collide
// across parallel worktrees.
//
// What changed from the backup: the draft no longer waits for the user's
// Apply. It's saved as the recipe (`source: "detector"`, unverified), the
// builder completes it, and verification decides whether it works. The
// analysis finding only says how the app is started and whether it does.

export const APP_LAUNCH_FINDING = "app-launch:recipe"
export const APP_LAUNCH_COMPOSE_FINDING = "app-launch:compose"
const MAX_SERVICES = 4

type Read = (file: string) => Promise<string | null>
type DraftService = Omit<AppService, "source">

interface Proposal {
  service: DraftService
  evidence: Array<Omit<Evidence, "id">>
  confidence: "likely" | "guess"
}

export interface AppLaunchDetection {
  // The drafted recipe, or null when nothing in the workspace serves an app.
  recipe: AppLaunch | null
  evidence: Array<Omit<Evidence, "id">>
  confidence: "likely" | "guess"
  // Compose files: pointed out, never used automatically.
  compose: string[]
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

function jsProposal(
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
  // A desktop app isn't served over HTTP.
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
const PYTHON: EcosystemId[] = ["pip", "uv", "poetry", "pipenv", "conda"]

export async function detectAppLaunch(input: {
  workspace: string
  roots: ProjectRoot[]
  files: string[]
  read: Read
}): Promise<AppLaunchDetection> {
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
      jsProposal(root, await input.read(at("package.json"))) ??
      (root.ecosystems.some((e) => PYTHON.includes(e))
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
  const compose = input.files
    .filter((f) => COMPOSE.test(f))
    .filter(
      (f) => !f.split("/").some((s) => ["node_modules", "vendor"].includes(s))
    )
    .slice(0, 2)
  const validation = validateAppLaunch({
    services: proposals.map((p) => ({ ...p.service, source: "detector" })),
  })
  const recipe =
    proposals.length && validation.ok && validation.recipe.services.length
      ? validation.recipe
      : null
  return {
    recipe,
    evidence: recipe ? proposals.flatMap((p) => p.evidence) : [],
    confidence: proposals.every((p) => p.confidence === "likely")
      ? "likely"
      : "guess",
    compose,
  }
}

// The compose note: informational, never applied.
export function composeDraft(compose: string[]): FindingDraft | null {
  if (!compose.length) return null
  return {
    key: APP_LAUNCH_COMPOSE_FINDING,
    category: "app-launch",
    severity: "info",
    title: "Containers aren't started for seats automatically",
    explanation: `${compose.join(", ")} defines services with fixed ports and container names, which collide when parallel worktrees start them. If the app needs them, a builder can add them to how the app starts with a port per worktree, or you can keep them running yourself.`,
    evidence: compose.map((f) => ({
      kind: "file" as const,
      label: `${f} exists`,
      path: f,
    })),
    confidence: "guess",
    source: "rule",
    fix: {
      kind: "manual",
      summary:
        "Keep the containers running yourself, or let a builder add them",
      steps: [
        "Start the containers the app needs before running stories, or leave it to the builder: it adds them with a port per worktree when the app can't start without them.",
      ],
    },
  }
}

// "How Mission Control starts the app" (plan 112.3): the recipe's services
// and its verified state, computed live like the test browser finding.
// Never a blocker: a story starts anyway, and the builder or recipe repair
// takes over.
export function appLaunchDraft(input: {
  recipe: AppLaunch
  state: AppRecipeState | null
  checking: boolean
  // The feature's work is only on this integration branch so far: the
  // checkout doesn't have the app to check (plan 112.3).
  notInCheckout?: string | null
}): FindingDraft {
  const { recipe, checking } = input
  const pending = input.notInCheckout ?? null
  // A state recorded before the work landed says nothing about it.
  const state = pending ? null : input.state
  const services = recipe.services
  const name = state?.state ?? (services.length ? "unverified" : "absent")
  const how = services.length
    ? `Mission Control starts ${services.map((s) => `${s.label} (\`${s.command}\`${s.cwd ? ` in ${s.cwd}` : ""})`).join(", ")}${recipe.setup?.length ? `, after ${recipe.setup.map((s) => `\`${s.command}\``).join(", ")}` : ""}.`
    : "No way to start the app was found in the project. When a story makes the app runnable, its builder records how to start it."
  const sources = new Set(services.map((s) => s.source))
  const by = sources.has("user")
    ? "You wrote it."
    : sources.has("seat")
      ? "A builder wrote it after starting the app."
      : sources.has("detector")
        ? "Drafted from the project's files; the builder completes it when the app needs more."
        : ""
  return {
    key: APP_LAUNCH_FINDING,
    category: "app-launch",
    severity: name === "broken" ? "warning" : "info",
    title: "How Mission Control starts the app",
    explanation: [
      how,
      by,
      pending
        ? `The feature's work isn't in your checkout yet: it's on ${pending}. Mission Control checks the app here once the milestone lands; until then, each story checks it in its own worktree.`
        : checking
          ? "Checking that it starts now."
          : describeRecipeState({
              state: name,
              failure: state?.failure ?? null,
            }),
      state?.question ? `Waiting on you: ${state.question.question}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    evidence: [
      ...services.map((s) => ({
        kind: "setting" as const,
        label: `${s.key}: ${s.command}${s.cwd ? ` (in ${s.cwd})` : ""}`,
        ...(s.cwd ? { path: s.cwd } : {}),
      })),
      ...(state?.failure?.logs
        ? [
            {
              kind: "probe" as const,
              label: "The end of its output",
              detail: state.failure.logs.slice(-600),
            },
          ]
        : []),
    ],
    confidence:
      name === "verified" || name === "broken" ? "verified" : "likely",
    source: "probe",
    // A pending question is answered right here, whatever the feature's
    // status: its first choice is the fix, the rest are alternatives.
    ...(state?.question && !checking
      ? {
          alternatives: state.question.choices.slice(1).map((c) => ({
            kind: "answer-app-question" as const,
            summary: c.label,
            questionId: state.question!.id,
            choiceId: c.id,
          })),
        }
      : {}),
    fix:
      state?.question?.choices.length && !checking
        ? {
            kind: "answer-app-question",
            summary: state.question.choices[0].label,
            questionId: state.question.id,
            choiceId: state.question.choices[0].id,
          }
        : pending
          ? {
              kind: "manual",
              summary: "Checked after the milestone lands",
              steps: [
                "Nothing to do now: the app is checked here once the milestone's work lands in this branch.",
              ],
            }
          : services.length
            ? {
                kind: "verify-app",
                summary:
                  name === "broken"
                    ? "Try to fix it and check again"
                    : "Check that the app starts",
              }
            : {
                kind: "manual",
                summary: "Nothing to do",
                steps: [
                  "The story that makes the app runnable records how to start it.",
                ],
              },
    ...(name === "verified" && !checking
      ? { resolution: "The app starts and loads" }
      : {}),
  }
}

const MAX_REF_FILES = 20_000

// The detection at a branch's tip rather than the checkout: a milestone's
// earlier stories land on its integration branch, so the app a later story
// tests may exist only there. Workspace-relative, like the checkout's
// analysis. Null when the ref can't be read.
export async function detectAppLaunchAtRef(input: {
  workspace: string
  ref: string
}): Promise<AppLaunchDetection | null> {
  const listed = await git(
    input.workspace,
    ["ls-tree", "-r", "-z", "--name-only", input.ref],
    30_000
  )
  if (!listed.ok) return null
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
  return detectAppLaunch({
    workspace: input.workspace,
    roots: inventory.roots,
    files,
    read,
  })
}
