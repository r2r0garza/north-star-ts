import { existsSync } from "fs"
import path from "path"
import {
  validateAppLaunch,
  type AppLaunch,
} from "../../../shared/mission-control/app-launch"
import type { AppServiceShape } from "../../../shared/mission-control/workspace-analysis"
import { APP_LAUNCH_FINDING } from "./app-launch"
import type { FindingDraft } from "./draft"
import type { Complete } from "./interpret"
import type { ProjectRoot } from "./inventory"
import { checkRelativePath, checkSetupCommand } from "./policy"

// The app launch recipe, written by the model (how Mission Control's seats
// start the app). Nothing here knows a framework: the model reads the
// workspace (or, before any code exists, the feature's intent) and answers in
// the recipe's own shape, and the main process checks only what holds for any
// stack — a valid recipe, safe single commands, a port the harness controls,
// and paths that exist. The rule-based detection in app-launch.ts is passed
// in as a hint the model may confirm or overrule.

export type RecipeBasis = "code" | "intent"

const SYSTEM = `You write the "app launch recipe" for a software project: how an automated agent starts the project's app on a developer machine so it can test it in a browser or over HTTP. The project can use ANY language, framework, or combination (several services, e.g. a backend and a frontend). Work from the evidence; never assume a particular stack.
Answer with ONE JSON object and nothing else:
{
  "basis": "code" | "intent" | "none",
  "services": Array<{
    "key": string,            // short slug, unique: "web", "api", "worker"
    "label": string,          // human name, e.g. "Rails server", "Vite frontend"
    "command": string,        // ONE command, run in cwd
    "prepare"?: string,       // ONE command run to completion first (create or migrate a database, seed data); the service starts only if it succeeds
    "cwd": string,            // workspace-relative directory, "" for the root
    "port": "auto" | "none" | number,
    "portEnv"?: string,       // env var the port is passed in when port is "auto" (default "PORT")
    "env"?: Record<string, string>,
    "ready": { "http": string } | { "log": string },
    "readyTimeoutMs"?: number, // raise it for slow starts (JVM builds, first compile); max 900000
    "dependsOn"?: string[]
  }>,
  "reason": string,           // one or two sentences: why this is how the app starts
  "evidence": string[]        // workspace-relative files you relied on (empty for basis "intent")
}
Rules:
- basis "code": the workspace already contains an app; derive the recipe from its files. basis "intent": the workspace has no runnable app yet; choose how the app described in FEATURE INTENT will be started once built, using the conventional command for the stack the intent asks for (or a sensible, minimal stack if it doesn't say). The first piece of work will build the app to match. basis "none": nothing here is meant to run as a service (a library, a CLI, a one-shot script); return no services.
- Ports: several copies of the app run at once, so the harness assigns each service a free port. With port "auto", pass it the way this framework accepts a port: an environment variable (set "portEnv" when it isn't PORT) or the placeholder "{port}" in the command (e.g. "--port {port}", "-Dserver.port={port}", "127.0.0.1:{port}"). Reference another service's port with "{port:<key>}" (in command or env), and list that service in dependsOn. Use a fixed number only if this framework cannot be told its port at all. Use port "none" with a "log" readiness pattern for a service that doesn't listen.
- Bind to 127.0.0.1 or localhost when the framework lets you choose.
- One command per service: no "&&", ";", pipes, redirects, "sudo", "curl", or installs. If the app needs something done before it can serve (a database created or migrated, seed data), put that one command in "prepare". The project's own tools are on PATH when the service runs (its virtualenv's bin directory and node_modules/.bin), as in an activated shell. Dependency installs and builds already ran as worktree setup (see SETUP STEPS); start the app, don't install it. Use "cwd" instead of "cd", and "env" instead of inline variable assignments.
- Prefer the project's own entry points (its scripts, task runner, or wrapper such as ./gradlew or bin/rails) over reimplementing them. Run a dev server in a mode that doesn't watch-and-restart in a way that hides failures, when the framework offers one.
- "ready": an HTTP path that answers once the app is up (usually "/"; an API without "/" needs a real path such as "/health" or "/docs"), or a regular expression for a line the service prints when ready.
- At most 4 services: the ones needed to use the app. Leave out databases and other infrastructure the project expects to already be running.`

const MAX_TREE = 500
const MAX_EXCERPT = 6000
const MAX_PROMPT = 70_000

// Files that say how a project runs, whatever its stack: manifests, task
// runners, process files, container files, and docs.
const RUN_FILES =
  /(^|\/)(package\.json|pyproject\.toml|setup\.cfg|setup\.py|requirements[\w.-]*\.txt|Pipfile|manage\.py|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|go\.mod|Cargo\.toml|Gemfile|config\.ru|mix\.exs|composer\.json|artisan|[\w.-]+\.csproj|[\w.-]+\.fsproj|global\.json|deno\.jsonc?|bunfig\.toml|pubspec\.yaml|Package\.swift|build\.sbt|project\.clj|deps\.edn|stack\.yaml|[\w.-]+\.cabal|dune-project|build\.zig|CMakeLists\.txt|Procfile|Makefile|justfile|Taskfile\.ya?ml|Dockerfile|(docker-)?compose(\.[\w-]+)?\.ya?ml|\.tool-versions|\.nvmrc|\.python-version|README(\.md|\.rst|\.txt)?)$/i

// Likely entry points, by name only (any extension, any stack).
const ENTRY =
  /(^|\/)(main|app|server|index|run|wsgi|asgi|manage|Program|Startup|[A-Z]\w*Application|application|bootstrap|cli)\.[\w]+$/

function depthOf(file: string): number {
  return file.split("/").length - 1
}

function treeLines(files: string[]): string[] {
  // Shallow first: the shape of the project, not its deepest leaves.
  const sorted = [...files].sort(
    (a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b)
  )
  const shown = sorted.slice(0, MAX_TREE)
  return [
    ...shown,
    ...(files.length > shown.length
      ? [`… and ${files.length - shown.length} more files`]
      : []),
  ]
}

export function buildRecipePrompt(input: {
  files: string[]
  roots: ProjectRoot[]
  intent: string
  setupSteps: string[]
  hint: AppServiceShape[]
  excerpts: Array<{ path: string; text: string }>
}): string {
  const lines: string[] = []
  lines.push("FEATURE INTENT:", input.intent.trim().slice(0, 4000) || "(none)", "")
  lines.push(
    "PROJECT ROOTS (detected):",
    ...(input.roots.length
      ? input.roots.map((r) => `- ${r.dir || "(root)"}: ${r.ecosystems.join(", ") || "unknown"}`)
      : ["(none detected)"]),
    ""
  )
  lines.push(
    "SETUP STEPS (already run in every worktree before the app starts):",
    ...(input.setupSteps.length ? input.setupSteps.map((s) => `- ${s}`) : ["(none)"]),
    ""
  )
  if (input.hint.length)
    lines.push(
      "BUILT-IN DETECTION GUESSED (confirm, fix, or overrule):",
      ...input.hint.map((s) => `- ${s.label}: \`${s.command}\` in "${s.cwd}" (port ${s.port})`),
      ""
    )
  lines.push(
    `FILES (${input.files.length} total):`,
    ...(input.files.length ? treeLines(input.files) : ["(the workspace is empty)"]),
    ""
  )
  lines.push("FILE EXCERPTS:")
  for (const e of input.excerpts) lines.push(`--- ${e.path} ---`, e.text)
  return lines.join("\n").slice(0, MAX_PROMPT)
}

// The files worth showing the model, read and bounded.
export async function recipeExcerpts(
  files: string[],
  read: (file: string) => Promise<string | null>
): Promise<Array<{ path: string; text: string }>> {
  const pick = (re: RegExp, limit: number) =>
    files
      .filter((f) => re.test(f) && depthOf(f) <= 3)
      .sort((a, b) => depthOf(a) - depthOf(b))
      .slice(0, limit)
  const chosen = [...new Set([...pick(RUN_FILES, 24), ...pick(ENTRY, 10)])]
  const out: Array<{ path: string; text: string }> = []
  let total = 0
  for (const file of chosen) {
    const text = await read(file)
    if (!text?.trim()) continue
    const excerpt = text.slice(0, MAX_EXCERPT)
    if (total + excerpt.length > MAX_PROMPT / 2) break
    total += excerpt.length
    out.push({ path: file, text: excerpt })
  }
  return out
}

function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("The model didn't return JSON.")
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
}

// The executable a command runs, when it's a relative path (./gradlew,
// bin/rails, .venv/bin/app).
function localExecutable(command: string): string | null {
  const first = command.trim().split(/\s+/)[0] ?? ""
  return first.includes("/") && !path.isAbsolute(first) ? first : null
}

export interface RecipeModelResult {
  draft: FindingDraft | null
  // Why the model's answer was discarded, or why there is nothing to run.
  rejected: Array<{ title: string; reason: string }>
  // The services the model proposed when its recipe was discarded: what a
  // fallback recipe may be missing.
  proposed?: string[]
}

type Checked =
  | { ok: true; basis: RecipeBasis; recipe: AppLaunch; parsed: Record<string, unknown> }
  | { ok: false; reason: string; proposed: string[]; none?: boolean }

// What holds for any stack: a valid recipe, safe single commands, and paths
// that exist. Only paths the repository itself has are checked: a virtualenv,
// node_modules, or a build output (.venv/bin/app, target/app.jar) is
// created by worktree setup before the app starts.
function checkAnswer(
  parsed: Record<string, unknown>,
  input: { workspace: string; files: string[] }
): Checked {
  const raw = Array.isArray(parsed.services) ? parsed.services.slice(0, 4) : []
  const proposed = raw
    .map((s) => (s && typeof s === "object" ? String((s as { label?: unknown; key?: unknown }).label ?? (s as { key?: unknown }).key ?? "") : ""))
    .filter(Boolean)
  const basis = parsed.basis
  if (basis === "none")
    return { ok: false, none: true, proposed, reason: `Nothing to start: ${String(parsed.reason ?? "").slice(0, 300)}` }
  if (basis !== "code" && basis !== "intent")
    return { ok: false, proposed, reason: 'basis must be "code", "intent", or "none"' }
  const validation = validateAppLaunch({
    services: raw.map((s) => ({ ...(s as object), source: "analysis" })),
  })
  if (!validation.ok || !validation.recipe.services.length)
    return { ok: false, proposed, reason: validation.ok ? "no services" : validation.errors.join(" ") }
  const known = new Set(input.files)
  const dirs = new Set<string>(["", "."])
  for (const file of input.files) {
    let dir = path.posix.dirname(file)
    while (dir !== "." && !dirs.has(dir)) {
      dirs.add(dir)
      dir = path.posix.dirname(dir)
    }
  }
  // Only a path inside a directory the repository doesn't have at all
  // (.venv/bin/app) may be missing: worktree setup makes it. A top-level
  // file (./gradlew) or anything under a tracked directory must exist.
  const madeBySetup = (p: string) => {
    const parts = p.split("/")
    return parts.length > 1 && !dirs.has(parts[0])
  }
  for (const service of validation.recipe.services) {
    const called = `${service.label} (\`${service.command}\`)`
    if (!checkRelativePath(service.cwd).ok)
      return { ok: false, proposed, reason: `${called}: its directory leaves the workspace` }
    const unsafe = serviceCommandRefusal(service, input.workspace)
    if (unsafe) return { ok: false, proposed, reason: unsafe }
    if (basis !== "code") continue
    if (service.cwd && !dirs.has(service.cwd) && !existsSync(path.join(input.workspace, service.cwd)))
      return { ok: false, proposed, reason: `${called}: the directory "${service.cwd}" doesn't exist` }
    const exe = localExecutable(service.command)
    const exePath = exe ? path.posix.normalize(path.posix.join(service.cwd, exe)) : null
    if (exePath && !madeBySetup(exePath) && !known.has(exePath) && !existsSync(path.join(input.workspace, exePath)))
      return { ok: false, proposed, reason: `${called}: ${exePath} doesn't exist` }
  }
  return { ok: true, basis, recipe: validation.recipe, parsed }
}

// Why a service's commands (its start and prepare commands) aren't safe to
// save, or null: one command each, no chaining, pipes, or redirects, nothing
// the shell policy blocks. Every way a recipe is written checks this.
export function serviceCommandRefusal(
  service: { label: string; command: string; prepare?: string; cwd: string },
  workspace: string
): string | null {
  for (const [what, text] of [
    ["", service.command],
    ["prepare ", service.prepare ?? ""],
  ] as const) {
    if (!text) continue
    // The policy reads a runnable command, so placeholders become numbers.
    const command = text.replace(/\{port(?::[^}]*)?\}/g, "4000")
    const verdict = checkSetupCommand(command, path.join(workspace, service.cwd))
    if (!verdict.ok)
      return `${service.label}'s ${what}command (\`${text}\`): ${verdict.reason}`
  }
  return null
}

export async function modelRecipe(input: {
  workspace: string
  files: string[]
  roots: ProjectRoot[]
  intent: string
  setupSteps: string[]
  hint: AppServiceShape[]
  read: (file: string) => Promise<string | null>
  complete: Complete
  signal: AbortSignal
  // Start the recipe for real (the environment is set up): null when every
  // service became ready, or what went wrong with the services' output.
  // Without it, the recipe is only checked on paper.
  tryStart?: (recipe: AppLaunch) => Promise<string | null>
}): Promise<RecipeModelResult> {
  const excerpts = await recipeExcerpts(input.files, input.read)
  const user = buildRecipePrompt({ ...input, excerpts })
  const title = "App launch recipe"
  // Up to two retries, each told what went wrong: a check it failed, or what
  // the app printed when it was started. A recipe is usually one detail away
  // from working, and giving up drops everything it found.
  const ask = async (feedback: string | null) =>
    checkAnswer(
      extractJson(
        await input.complete(
          SYSTEM,
          feedback
            ? `${user}\n\nYOUR PREVIOUS ANSWER DIDN'T WORK: ${feedback}\nAnswer again with the whole recipe, fixed. Keep every service the app needs.`
            : user,
          input.signal
        )
      ),
      input
    )
  let checked = await ask(null)
  let started: boolean | null = null
  for (let retry = 0; ; retry++) {
    let problem: string | null = null
    if (!checked.ok) problem = checked.none ? null : `it was rejected: ${checked.reason}`
    else if (input.tryStart && checked.basis === "code") {
      const failed = await input.tryStart(checked.recipe)
      started = !failed
      if (failed) problem = `it was started in the workspace and failed:\n${failed.slice(0, 4000)}`
    }
    if (!problem || retry >= 2) break
    checked = await ask(problem)
  }
  if (!checked.ok)
    return {
      draft: null,
      rejected: [{ title, reason: checked.reason }],
      ...(checked.none ? {} : { proposed: checked.proposed }),
    }
  if (started === false)
    return {
      draft: null,
      rejected: [{ title, reason: "The recipe didn't start the app after three tries." }],
      proposed: checked.recipe.services.map((s) => s.label),
    }
  const { basis, recipe: validated, parsed } = checked
  const known = new Set(input.files)
  const validation = { recipe: validated }

  const services: AppServiceShape[] = validation.recipe.services.map(
    ({ source: _source, findingKey: _key, ...service }) =>
      basis === "intent" ? { ...service, provisional: true } : service
  )
  const cited = (Array.isArray(parsed.evidence) ? parsed.evidence : [])
    .filter((f): f is string => typeof f === "string" && known.has(f))
    .slice(0, 6)
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 400) : ""
  const names = services.map((s) => s.label).join(", ")
  return {
    draft: {
      key: APP_LAUNCH_FINDING,
      category: "app-launch",
      severity: "info",
      title:
        basis === "intent"
          ? "How the app will start (planned from the intent)"
          : "How seats start the app",
      explanation:
        basis === "intent"
          ? `There's no app here yet. From the feature's intent, it will run as ${names}; the first story builds it to start this way, and the first successful start confirms it. ${reason}`.trim()
          : `Builder and QA seats start ${names} through Mission Control, which gives each worktree its own ports and stops it when the step ends.${started ? " It was started in the workspace and came up." : ""} ${reason}`.trim(),
      evidence: cited.length
        ? cited.map((f) => ({ kind: "file" as const, label: `${f} (read by the model)`, path: f }))
        : [{ kind: "doc" as const, label: basis === "intent" ? "The feature's intent" : "The workspace's files" }],
      confidence: basis === "intent" ? "guess" : started ? "verified" : "likely",
      source: "model",
      fix: {
        kind: "apply-settings",
        summary: services
          .map((s) => `Start \`${s.command}\`${s.cwd ? ` in ${s.cwd}` : ""}`)
          .join("; "),
        patch: { appLaunch: { add: services } },
      },
    },
    rejected: [],
  }
}
