import { createHash } from "crypto"
import { existsSync, readdirSync, statSync } from "fs"
import { open, readFile } from "fs/promises"
import path from "path"
import type {
  CommandSpec,
  Fix,
  ProbeSpec,
  SetupStepShape,
} from "../../../shared/mission-control/workspace-analysis"
import { databaseFindings } from "./database"
import type { FindingDraft } from "./draft"
import { outputTail, run, runShellLine } from "./exec"
import { discoverGenerated, type GeneratedGroup } from "./generated"
import {
  gitFacts,
  listIgnoredPresent,
  listProjectFiles,
  listTrackedFiles,
  recentChanges,
  type GitFacts,
} from "./git-facts"
import { classifyIgnored, type IgnoredEntry } from "./ignored"
import {
  detectProjects,
  ECOSYSTEM_INFO,
  languageOf,
  type EcosystemId,
  type Inventory,
  type ProjectRoot,
  type ToolchainPin,
} from "./inventory"
import { checkGeneratedCommand } from "./policy"
import { warmShellPath } from "./tool-env"
import {
  APPLE_ONLY,
  installsEditable,
  RECIPES,
  venvDir,
  type ProbeDef,
  type ProbeOutcome,
  type Recipe,
  type RecipeContext,
  type ToolSpec,
} from "./recipes"
import {
  availableManagers,
  choosePython,
  extractVersion,
  installableVersion,
  managerCommand,
  probeTool,
  resetToolCache,
  satisfies,
} from "./toolchains"

// The deterministic pipeline (plan 106.11 stages 1–6): Git facts, inventory,
// ignored-but-present scan, generated files, recipes and probes. Returns
// finding drafts; assembly (resolving against current settings) is separate.

export interface CurrentSettings {
  linkPaths: string[]
  // Who wrote each step matters: analysis steps may be replaced by a faster
  // link; the user's never are.
  steps: Array<SetupStepShape & { source?: "user" | "analysis" }>
  generatedFiles: Array<{ paths: string[]; command: string }>
  overlapPolicy: "wait" | "parallel"
}

// Results of probes that execute project code, run on the user's approval
// ("Run checks") and reused while the fingerprint holds.
export type CheckResults = Record<
  string,
  { ok: boolean; detail: string; at: number; fingerprint: string }
>

export interface AnalyzeInput {
  workspace: string
  settings: CurrentSettings
  checkResults: CheckResults
  platform?: NodeJS.Platform
  signal?: AbortSignal
  onStage?: (stage: string) => void
}

export interface AnalysisFacts {
  git: GitFacts
  inventory: Inventory
  ignored: IgnoredEntry[]
  generated: GeneratedGroup[]
  drafts: FindingDraft[]
  fingerprint: string
  // Unknown ignored entries and unsupported ecosystems, for the model.
  unknownIgnored: string[]
  unsupported: Array<{ file: string; ecosystem: string }>
  // Setup-relevant file excerpts for the model (bounded).
  excerpts: Array<{ path: string; text: string }>
}

const MAX_FILES = 60_000
const READ_LIMIT = 256 * 1024

const UNSUPPORTED_MARKERS: Array<{ re: RegExp; ecosystem: string }> = [
  { re: /(^|\/)mix\.exs$/, ecosystem: "Elixir (mix)" },
  { re: /(^|\/)build\.sbt$/, ecosystem: "Scala (sbt)" },
  { re: /(^|\/)stack\.yaml$/, ecosystem: "Haskell (Stack)" },
  { re: /(^|\/)[\w-]+\.cabal$/, ecosystem: "Haskell (Cabal)" },
  { re: /(^|\/)Project\.toml$/, ecosystem: "Julia" },
  { re: /(^|\/)renv\.lock$/, ecosystem: "R (renv)" },
  { re: /(^|\/)rebar\.config$/, ecosystem: "Erlang (rebar3)" },
  { re: /(^|\/)build\.zig$/, ecosystem: "Zig" },
  { re: /(^|\/)dune-project$/, ecosystem: "OCaml (dune)" },
  { re: /(^|\/)elm\.json$/, ecosystem: "Elm" },
  { re: /(^|\/)shard\.yml$/, ecosystem: "Crystal (shards)" },
  { re: /(^|\/)deps\.edn$|(^|\/)project\.clj$/, ecosystem: "Clojure" },
  { re: /(^|\/)cpanfile$/, ecosystem: "Perl (cpanm)" },
  { re: /(^|\/)Package\.resolved$/, ecosystem: "" },
]

function reader(workspace: string) {
  return async (file: string): Promise<string | null> => {
    const full = path.join(workspace, file)
    try {
      const handle = await open(full, "r")
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) return null
        const size = Math.min(stat.size, READ_LIMIT)
        const buffer = Buffer.alloc(size)
        await handle.read(buffer, 0, size, 0)
        return buffer.toString("utf8")
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }
}

// Non-repositories: a bounded walk that skips the usual heavy directories.
function walk(workspace: string, limit: number): string[] {
  const out: string[] = []
  const skip = new Set([
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "vendor",
    "target",
    "build",
    "dist",
    ".build",
    "Pods",
    ".dart_tool",
    "__pycache__",
  ])
  const visit = (dir: string, rel: string, depth: number) => {
    if (depth > 6 || out.length >= limit) return
    let entries: import("fs").Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!skip.has(entry.name))
          visit(path.join(dir, entry.name), childRel, depth + 1)
      } else out.push(childRel)
    }
  }
  visit(workspace, "", 0)
  return out
}

function draftId(prefix: string, ...parts: string[]) {
  return [prefix, ...parts.map((p) => p || ".")].join(":")
}

function stepId(key: string, index: number) {
  return `analysis:${key}:${index}`
}

function toSteps(
  key: string,
  root: string,
  commands: CommandSpec[]
): SetupStepShape[] {
  return commands.map((c, i) => ({
    id: stepId(key, i),
    label: c.label,
    command: c.command,
    cwd: path.posix.join(root, c.cwd).replace(/^\.$/, ""),
  }))
}

// The steps a worktree runs for an environment. A pip project installed in
// editable mode gets the built-in shared venv: a thin venv of its own that
// reuses this checkout's installed packages (about a second, nothing
// downloaded), with the full setup as its fallback and the install as its
// refresh when a story changes the dependencies.
function worktreeSteps(
  id: EcosystemId,
  ctx: RecipeContext,
  root: string
): { steps: SetupStepShape[]; shared: boolean } {
  const setup = RECIPES[id].setup(ctx, "worktree")
  const key = draftId("env", root, id)
  if (id === "pip" && installsEditable(ctx)) {
    const venv = venvDir(ctx)
    const install = setup.filter(
      (c) =>
        /\bpip install\b/.test(c.command) && !/--upgrade pip/.test(c.command)
    )
    return {
      shared: true,
      steps: [
        {
          id: `analysis:${key}:shared`,
          label: `Reuse this checkout's ${venv} packages`,
          command: `reuse ${venv} packages from the main checkout`,
          cwd: root,
          kind: "python-shared-venv",
          venv,
          fallback: setup.map((c) => ({ label: c.label, command: c.command })),
          refresh: install.map((c) => ({ label: c.label, command: c.command })),
        },
      ],
    }
  }
  return { shared: false, steps: toSteps(key, root, setup) }
}

function inWorkspace(root: string, commands: CommandSpec[]): CommandSpec[] {
  return commands.map((c) => ({
    ...c,
    cwd: path.posix.join(root, c.cwd).replace(/^\.$/, ""),
  }))
}

const where = (root: string) => (root ? ` in ${root}/` : "")

export async function analyzeWorkspace(
  input: AnalyzeInput
): Promise<AnalysisFacts> {
  const workspace = input.workspace
  const platform = input.platform ?? process.platform
  const stage = (s: string) => {
    if (input.signal?.aborted) throw new Error("Analysis was cancelled.")
    input.onStage?.(s)
  }
  resetToolCache()
  await warmShellPath()
  const read = reader(workspace)
  const drafts: FindingDraft[] = []

  // ── 1. Git facts ──────────────────────────────────────────────────────────
  stage("Checking Git")
  const git = await gitFacts(workspace)
  drafts.push(...gitDrafts(git))

  // ── 2. Inventory ──────────────────────────────────────────────────────────
  stage("Finding projects")
  const listed = git.isRepo
    ? await listProjectFiles(workspace, MAX_FILES)
    : null
  const files = listed?.files ?? walk(workspace, MAX_FILES)
  const inventory = await detectProjects(files, read)
  if (inventory.truncatedRoots)
    drafts.push({
      key: "project-state:many-roots",
      category: "project-state",
      severity: "info",
      title: `${inventory.truncatedRoots} more projects weren't analyzed`,
      explanation:
        "The workspace has more project roots than one analysis covers. The first ones were analyzed; set up the rest in Advanced settings if they need it.",
      evidence: [
        {
          kind: "manifest",
          label: `${inventory.roots.length + inventory.truncatedRoots} project roots found`,
        },
      ],
      confidence: "verified",
      source: "rule",
      fix: {
        kind: "manual",
        summary: "Set up the remaining projects",
        steps: [
          "Add worktree setup steps for the other projects in Advanced settings.",
        ],
      },
    })

  // ── 3. Ignored-but-present ────────────────────────────────────────────────
  stage("Comparing the workspace with a fresh checkout")
  const ignoredRaw = git.isRepo ? await listIgnoredPresent(workspace) : []
  const ignored = classifyIgnored(
    expandIgnored(workspace, ignoredRaw, inventory.roots),
    inventory.roots
  )
  // Setup-relevant inputs only: a code change doesn't invalidate the result.
  // Checks that ran project code stay valid while it holds.
  const fingerprint = await computeFingerprint(
    workspace,
    git,
    inventory,
    ignoredRaw
  )
  const checkResults: CheckResults = Object.fromEntries(
    Object.entries(input.checkResults).filter(
      ([, r]) => r.fingerprint === fingerprint
    )
  )

  const contexts = new Map<string, RecipeContext>()
  for (const root of inventory.roots)
    contexts.set(root.dir, {
      root,
      rootAbs: path.join(workspace, root.dir),
      workspaceAbs: workspace,
      ignored: ignored.filter((e) => e.root === root.dir),
      platform,
    })

  // ── 5/6. Toolchains, recipes, probes ──────────────────────────────────────
  stage("Checking toolchains")
  const managers = await availableManagers(workspace)
  // Python roots get an interpreter that meets requires-python.
  for (const root of inventory.roots) {
    if (
      !root.ecosystems.some(
        (e) => e === "pip" || e === "pipenv" || e === "poetry"
      )
    )
      continue
    const ctx = contexts.get(root.dir)!
    const pin = inventory.pins.find(
      (p) =>
        p.tool === "python" &&
        p.kind === "range" &&
        p.file === path.posix.join(root.dir, "pyproject.toml")
    )
    ctx.requiresPython = pin?.required ?? null
    const choice = await choosePython(ctx.requiresPython, ctx.rootAbs)
    ctx.python = choice
    if (choice.satisfied || !pin) continue
    drafts.push(pythonVersionDraft(root.dir, pin, choice, managers))
  }
  const toolFindings = await toolchainDrafts(
    inventory,
    contexts,
    managers,
    platform,
    workspace
  )
  drafts.push(...toolFindings.drafts)

  stage("Checking project environments")
  for (const root of inventory.roots) {
    const ctx = contexts.get(root.dir)!
    for (const id of root.ecosystems) {
      if (APPLE_ONLY.has(id) && platform !== "darwin") continue
      drafts.push(
        ...(await environmentDrafts(
          root,
          id,
          ctx,
          checkResults,
          toolFindings.missing.has(id),
          input.signal
        ))
      )
    }
  }
  drafts.push(...worktreeDrafts(inventory, ignored, contexts, input.settings))
  drafts.push(...localConfigDrafts(ignored))
  drafts.push(...buildCostDrafts(inventory, contexts))

  // ── 4. Generated files ────────────────────────────────────────────────────
  stage("Looking for generated files")
  const tracked = git.isRepo
    ? await listTrackedFiles(workspace, MAX_FILES)
    : files
  const history =
    git.isRepo && !git.unborn ? await recentChanges(workspace) : []
  const generated = await discoverGenerated({
    tracked,
    roots: inventory.roots,
    read,
    history,
    contexts,
  })
  drafts.push(...generatedDrafts(generated, workspace))

  stage("Checking databases")
  drafts.push(
    ...(await databaseFindings({
      tracked,
      roots: inventory.roots,
      ignored,
      read,
    }))
  )

  // Unsupported ecosystems: never an empty result.
  const unsupported = files
    .flatMap((file) => {
      const marker = UNSUPPORTED_MARKERS.find((m) => m.re.test(file))
      return marker && marker.ecosystem
        ? [{ file, ecosystem: marker.ecosystem }]
        : []
    })
    .filter(
      (u) =>
        !u.file
          .split("/")
          .some((s) =>
            ["node_modules", "vendor", "fixtures", "testdata"].includes(s)
          )
    )
    .slice(0, 8)
  for (const u of unsupported)
    drafts.push({
      key: draftId("toolchain:unsupported", u.file),
      category: "toolchain",
      severity: "warning",
      title: `${u.ecosystem} isn't covered by a built-in recipe`,
      explanation: `North Star found ${u.file} but has no recipe for ${u.ecosystem} yet, so it can't check or set up that environment itself. Add the setup steps you'd run by hand so every worktree gets them.`,
      evidence: [{ kind: "manifest", label: `${u.file} exists`, path: u.file }],
      confidence: "guess",
      source: "rule",
      root:
        path.posix.dirname(u.file) === "." ? "" : path.posix.dirname(u.file),
      fix: {
        kind: "manual",
        summary: "Add setup steps by hand",
        steps: [
          `Install ${u.ecosystem} and the project's dependencies in the workspace the way its README describes.`,
          "Add the install command as a worktree setup step in Advanced settings.",
        ],
      },
    })

  const unknownIgnored = ignored
    .filter((e) => e.class === "unknown")
    .map((e) => e.path)
  const excerpts = await setupExcerpts(files, read)
  return {
    git,
    inventory,
    ignored,
    generated,
    drafts,
    fingerprint,
    unknownIgnored,
    unsupported,
    excerpts,
  }
}

// Git collapses a directory whose contents are all ignored into one entry
// ("config/" for an ignored config/master.key). Look inside directories that
// aren't a known environment or build output, a couple of levels deep.
function expandIgnored(
  workspace: string,
  raw: string[],
  roots: ProjectRoot[]
): string[] {
  const out: string[] = []
  for (const entry of raw) {
    if (!entry.endsWith("/")) {
      out.push(entry)
      continue
    }
    const [probe] = classifyIgnored([entry], roots)
    if (!probe || probe.class !== "unknown") {
      out.push(entry)
      continue
    }
    const children: string[] = []
    const visit = (rel: string, depth: number) => {
      let names: import("fs").Dirent[] = []
      try {
        names = readdirSync(path.join(workspace, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const d of names) {
        if (children.length >= 40) return
        const child = `${rel}${d.name}${d.isDirectory() ? "/" : ""}`
        const [kind] = classifyIgnored([child], roots)
        if (d.isDirectory() && depth < 2 && kind?.class === "unknown")
          visit(child, depth + 1)
        else children.push(child)
      }
    }
    visit(entry, 0)
    out.push(...(children.length && children.length < 40 ? children : [entry]))
  }
  return out
}

// ── Git ─────────────────────────────────────────────────────────────────────

function gitDrafts(git: GitFacts): FindingDraft[] {
  const out: FindingDraft[] = []
  if (git.gitMissing) {
    out.push({
      key: "git-isolation:git-missing",
      category: "git-isolation",
      severity: "warning",
      title: "Git isn't installed",
      explanation:
        "Without Git, Mission Control can't give stories their own worktrees, so they run one at a time directly in the workspace.",
      evidence: [{ kind: "git", label: "`git` wasn't found on the PATH" }],
      confidence: "verified",
      source: "rule",
      fix: {
        kind: "manual",
        summary: "Install Git",
        steps: [
          "On macOS run xcode-select --install (or brew install git), then re-analyze.",
        ],
        link: "https://git-scm.com/downloads",
      },
    })
    return out
  }
  if (!git.isRepo) {
    out.push({
      key: "git-isolation:not-a-repo",
      category: "git-isolation",
      severity: "warning",
      title: "This folder isn't a Git repository",
      explanation:
        "Mission Control isolates each story in its own Git worktree. Without a repository, stories run one at a time directly in this folder, and there's no branch history to review or undo.",
      evidence: [
        { kind: "git", label: "git rev-parse: not inside a work tree" },
      ],
      confidence: "verified",
      source: "rule",
      fix: {
        kind: "manual",
        summary: "Initialize Git yourself",
        steps: [
          "In a terminal in this folder: git init",
          "Add a .gitignore for build outputs and environments (node_modules, .venv, …).",
          'git add -A && git commit -m "Initial commit"',
          "Then analyze the workspace again.",
        ],
      },
    })
    return out
  }
  if (git.unborn) {
    out.push({
      key: "git-isolation:unborn",
      category: "git-isolation",
      severity: "warning",
      title: "The repository has no commits yet",
      explanation:
        "Worktrees start from a commit, so until there's a first one, stories can't get their own worktrees.",
      evidence: [
        {
          kind: "git",
          label: `HEAD is unborn${git.branch ? ` on ${git.branch}` : ""}`,
        },
      ],
      confidence: "verified",
      source: "rule",
      fix: {
        kind: "manual",
        summary: "Make a first commit",
        steps: [
          'git add -A && git commit -m "Initial commit"',
          "Then analyze the workspace again.",
        ],
      },
    })
    return out
  }
  if (git.dirtyCount)
    out.push({
      key: "project-state:dirty",
      category: "project-state",
      severity: "warning",
      title: `${git.dirtyCount} uncommitted change${git.dirtyCount === 1 ? "" : "s"} won't be visible to agents`,
      explanation:
        "Each story's worktree starts from your last commit. Changes you haven't committed stay in this workspace only, so agents won't see them and may redo or conflict with them.",
      evidence: git.dirty.slice(0, 6).map((line) => ({
        kind: "git" as const,
        label: line.trim(),
        path: line.slice(3).trim(),
      })),
      confidence: "verified",
      source: "rule",
      fix: {
        kind: "manual",
        summary: "Commit or stash what agents should see",
        steps: [
          "Commit the changes agents should build on (or stash the ones they shouldn't), then analyze again.",
        ],
      },
    })
  if (git.linkedWorktree)
    out.push({
      key: "project-state:linked-worktree",
      category: "project-state",
      severity: "info",
      title: "This workspace is itself a linked worktree",
      explanation:
        "That works: stories branch from this worktree's current commit. Links and setup steps are taken from this checkout, not the repository's main one.",
      evidence: [
        {
          kind: "git",
          label:
            "Its git directory differs from the repository's common directory",
        },
      ],
      confidence: "verified",
      source: "rule",
      fix: {
        kind: "manual",
        summary: "Nothing to do",
        steps: ["No action needed."],
      },
    })
  out.push({
    key: "git-isolation:parallel",
    category: "git-isolation",
    severity: "info",
    title: "Stories can run in parallel",
    explanation: `The workspace is in a Git repository${git.subpath ? ` (at ${git.subpath}/)` : ""} with a commit to branch from, so each story gets its own worktree and branch. Overlapping stories can run together once their worktrees get a working environment.`,
    evidence: [
      { kind: "git", label: `Repository root: ${git.root}` },
      { kind: "git", label: `On ${git.branch ?? "a detached HEAD"}` },
      ...(git.mcBranches.length
        ? [
            {
              kind: "git" as const,
              label: `${git.mcBranches.length} existing Mission Control branches (mc/…) are kept separate per feature`,
            },
          ]
        : []),
    ],
    confidence: "verified",
    source: "rule",
    fix: {
      kind: "apply-settings",
      summary: "Run overlapping stories in parallel",
      patch: { overlapPolicy: "parallel" },
    },
  })
  return out
}

// ── Toolchains ──────────────────────────────────────────────────────────────

const PIN_TOOLS: Record<
  ToolchainPin["tool"],
  { exe: string; args: string[]; label: string; perRoot?: boolean }
> = {
  python: {
    exe: "python3",
    args: ["--version"],
    label: "Python",
    perRoot: true,
  },
  node: { exe: "node", args: ["--version"], label: "Node.js" },
  java: { exe: "java", args: ["-version"], label: "Java" },
  ruby: { exe: "ruby", args: ["--version"], label: "Ruby", perRoot: true },
  rust: { exe: "rustc", args: ["--version"], label: "Rust", perRoot: true },
  go: { exe: "go", args: ["version"], label: "Go" },
  dotnet: {
    exe: "dotnet",
    args: ["--version"],
    label: ".NET SDK",
    perRoot: true,
  },
  flutter: { exe: "flutter", args: ["--version"], label: "Flutter" },
  dart: { exe: "dart", args: ["--version"], label: "Dart" },
  php: { exe: "php", args: ["--version"], label: "PHP" },
  xcode: { exe: "xcodebuild", args: ["-version"], label: "Xcode" },
  swift: { exe: "swift", args: ["--version"], label: "Swift" },
  pnpm: { exe: "pnpm", args: ["--version"], label: "pnpm", perRoot: true },
  yarn: { exe: "yarn", args: ["--version"], label: "Yarn", perRoot: true },
  bun: { exe: "bun", args: ["--version"], label: "Bun" },
  cmake: { exe: "cmake", args: ["--version"], label: "CMake" },
}

function toolVerify(
  spec: Pick<ToolSpec, "exe" | "versionArgs" | "label">
): ProbeSpec {
  return {
    id: `tool:${spec.exe}`,
    label: `${spec.label} is on the PATH`,
    cwd: "",
    class: "passive",
    command: [spec.exe, ...spec.versionArgs].join(" "),
  }
}

function installFix(
  spec: ToolSpec,
  managers: Awaited<ReturnType<typeof availableManagers>>,
  version: string | null,
  root: string
): { fix: Fix; alternatives: Fix[] } {
  const manual: Fix = {
    kind: "manual",
    summary: `Install ${spec.label}`,
    steps: [...spec.install.steps, "Then analyze the workspace again."],
    ...(spec.install.link ? { link: spec.install.link } : {}),
  }
  const managed = managerCommand(spec, managers, version)
  if (!managed) return { fix: manual, alternatives: [] }
  return {
    fix: {
      kind: "run-command",
      summary: `Install ${spec.label}${version ? ` ${version}` : ""} with ${managed.manager}`,
      commands: [
        {
          label: `Install ${spec.label}${version ? ` ${version}` : ""}`,
          command: managed.command,
          cwd: root,
        },
      ],
      verify: [toolVerify(spec)],
    },
    alternatives: [manual],
  }
}

async function toolchainDrafts(
  inventory: Inventory,
  contexts: Map<string, RecipeContext>,
  managers: Awaited<ReturnType<typeof availableManagers>>,
  platform: NodeJS.Platform,
  workspace: string
): Promise<{ drafts: FindingDraft[]; missing: Set<EcosystemId> }> {
  const drafts: FindingDraft[] = []
  const missing = new Set<EcosystemId>()
  const seen = new Set<string>()
  for (const root of inventory.roots) {
    const ctx = contexts.get(root.dir)!
    for (const id of root.ecosystems) {
      if (APPLE_ONLY.has(id) && platform !== "darwin") {
        const key = draftId("toolchain:apple", id)
        if (!seen.has(key)) {
          seen.add(key)
          drafts.push({
            key,
            category: "toolchain",
            severity: "info",
            title: `${ECOSYSTEM_INFO[id].manager} needs macOS`,
            explanation: `${root.dir || "The workspace"} uses ${ECOSYSTEM_INFO[id].manager}, which only runs on macOS. Agents on this machine can't build that part.`,
            evidence: [
              {
                kind: "manifest",
                label: `${ECOSYSTEM_INFO[id].manager} project${where(root.dir)}`,
              },
            ],
            confidence: "verified",
            source: "rule",
            fix: {
              kind: "manual",
              summary: "Build Apple targets on a Mac",
              steps: [
                "Run this Feature on a Mac for the Apple parts, or leave them out of scope.",
              ],
            },
          })
        }
        continue
      }
      const spec = RECIPES[id].tool(ctx)
      const status = await probeTool(spec, ctx.rootAbs)
      if (status.found) continue
      missing.add(id)
      const key = draftId("toolchain", spec.exe)
      if (seen.has(key)) continue
      seen.add(key)
      const pin = inventory.pins.find((p) => p.tool === spec.pin)
      const version = pin ? installableVersion(pin) : null
      const { fix, alternatives } = installFix(
        spec,
        managers,
        version,
        root.dir
      )
      drafts.push({
        key,
        category: "toolchain",
        severity: RECIPES[id].missingSeverity,
        title: `${spec.label} isn't installed`,
        explanation: `${languageOf(root, id)}${where(root.dir)} is built with ${ECOSYSTEM_INFO[id].manager}, which needs ${spec.label}. It isn't on the PATH North Star sees, so nothing for that project can be set up or checked yet.`,
        evidence: [
          {
            kind: "probe",
            label: `\`${spec.exe} ${spec.versionArgs.join(" ")}\`: not found`,
          },
          {
            kind: "manifest",
            label: `${ECOSYSTEM_INFO[id].manager} project${where(root.dir)}`,
            path: root.dir || undefined,
          },
        ],
        confidence: "verified",
        source: "probe",
        root: root.dir,
        fix,
        alternatives,
      })
    }
  }

  // Pinned versions.
  const uvRoots = inventory.roots.some((r) => r.ecosystems.includes("uv"))
  for (const pin of inventory.pins) {
    if (pin.tool === "python" && uvRoots) continue // uv installs the pinned Python itself
    if (pin.tool === "python" && pin.kind === "range") continue // chosen per root above
    if (pin.tool === "go") continue // Go downloads the toolchain go.mod asks for
    const tool = PIN_TOOLS[pin.tool]
    if (!tool) continue
    if (pin.tool === "xcode" && platform !== "darwin") continue
    const dir =
      path.posix.dirname(pin.file) === "." ? "" : path.posix.dirname(pin.file)
    const cwd = path.join(workspace, dir)
    const result = tool.perRoot
      ? await run(tool.exe, tool.args, { cwd, timeoutMs: 20_000 })
      : null
    const status = result
      ? {
          found: !result.missing,
          raw: `${result.stdout}\n${result.stderr}`,
          version: extractVersion(`${result.stdout}\n${result.stderr}`),
          ok: result.ok,
        }
      : await probeTool({ exe: tool.exe, versionArgs: tool.args }, cwd).then(
          (s) => ({ ...s, ok: s.found })
        )
    if (!status.found) continue // the missing-tool finding covers it
    const specFor = inventory.roots
      .flatMap((r) =>
        r.ecosystems.map((e) => RECIPES[e].tool(contexts.get(r.dir)!))
      )
      .find((s) => s.pin === pin.tool)
    // The pinned tool itself (Node.js, not npm), with the recipe's install
    // advice and version-manager commands when a recipe knows them.
    const spec: ToolSpec = {
      install: { steps: [`Install ${tool.label} ${pin.required}.`] },
      ...specFor,
      exe: tool.exe,
      versionArgs: tool.args,
      label: tool.label,
    }
    // .NET refuses to run when global.json's SDK is missing.
    const dotnetRefused =
      pin.tool === "dotnet" &&
      !status.ok &&
      /global\.json|compatible .*SDK/i.test(status.raw)
    const ok = dotnetRefused
      ? false
      : status.version
        ? satisfies(status.version, pin.required)
        : null
    if (ok !== false) continue
    const version = installableVersion(pin)
    const { fix, alternatives } = installFix(spec, managers, version, dir)
    drafts.push({
      key: draftId("toolchain:pin", pin.tool, pin.file),
      category: "toolchain",
      severity: "warning",
      title: `${tool.label} ${pin.required} is pinned, but ${status.version ?? "another version"} is installed`,
      explanation: `${pin.file} asks for ${tool.label} ${pin.required}. Agents would build and test with ${status.version ?? "a different version"}, which can fail in ways that look like code problems.`,
      evidence: [
        { kind: "file", label: `${pin.file}: ${pin.required}`, path: pin.file },
        {
          kind: "probe",
          label: `\`${tool.exe} ${tool.args.join(" ")}\`: ${status.raw.trim().split("\n")[0]?.slice(0, 120) ?? ""}`,
        },
      ],
      confidence: "verified",
      source: "probe",
      root: dir,
      fix,
      alternatives,
    })
  }
  return { drafts, missing }
}

// No installed Python meets the project's requires-python.
function pythonVersionDraft(
  root: string,
  pin: ToolchainPin,
  choice: Awaited<ReturnType<typeof choosePython>>,
  managers: Awaited<ReturnType<typeof availableManagers>>
): FindingDraft {
  const version = /(\d+\.\d+)/.exec(pin.required)?.[1] ?? null
  const spec: ToolSpec = {
    exe: `python${version ?? "3"}`,
    versionArgs: ["--version"],
    label: "Python",
    install: {
      steps: [
        `Install Python ${version ?? pin.required} (on macOS: brew install python@${version ?? "3.12"}).`,
        "Then analyze the workspace again; North Star picks the interpreter that fits.",
      ],
      link: "https://www.python.org/downloads/",
    },
    managers: {
      uv: "uv python install {version}",
      pyenv: "pyenv install -s {version}",
      mise: "mise install python@{version}",
      asdf: "asdf install python {version}",
    },
  }
  const { fix, alternatives } = installFix(spec, managers, version, root)
  const found = choice.found.map((f) => `${f.exe} ${f.version}`)
  return {
    key: draftId("toolchain:python", root),
    category: "toolchain",
    severity: "blocker",
    title: `Python ${pin.required} is required, but no installed Python fits`,
    explanation: `${pin.file} requires Python ${pin.required}. ${found.length ? `The interpreters North Star can see are ${found.join(", ")}.` : "North Star can't see any Python interpreter."} A virtual environment built with an older Python can't install the project.`,
    evidence: [
      {
        kind: "file",
        label: `${pin.file}: requires-python ${pin.required}`,
        path: pin.file,
      },
      ...choice.found.map((f) => ({
        kind: "probe" as const,
        label: `\`${f.exe} --version\`: ${f.version}`,
      })),
    ],
    confidence: "verified",
    source: "probe",
    root,
    fix,
    alternatives,
  }
}

// ── Main environment ────────────────────────────────────────────────────────

const ENV_NOUN: Partial<Record<EcosystemId, string>> = {
  uv: "Python environment",
  poetry: "Python environment",
  pipenv: "Python environment",
  pip: "Python environment",
  conda: "conda environment",
  pnpm: "JavaScript dependencies",
  npm: "JavaScript dependencies",
  yarn: "JavaScript dependencies",
  bun: "JavaScript dependencies",
  composer: "PHP dependencies (vendor/)",
  bundler: "Ruby gems",
  pub: "Dart packages",
  cocoapods: "CocoaPods dependencies",
  carthage: "Carthage dependencies",
  tuist: "Generated Xcode project",
  xcodegen: "Generated Xcode project",
  go: "Go modules",
  cargo: "Rust crates",
  dotnet: "NuGet packages",
  maven: "Maven dependencies",
  gradle: "Gradle build",
  cmake: "CMake build",
  meson: "Meson build",
  autotools: "configured build",
  dbt: "dbt packages",
  swiftpm: "Swift packages",
  deno: "Deno dependencies",
}

async function runProbe(
  probe: ProbeDef,
  ctx: RecipeContext,
  signal?: AbortSignal
): Promise<ProbeOutcome & { ran: boolean }> {
  if (probe.fs) return { ...probe.fs(ctx), ran: true }
  if (!probe.command) return { ok: true, detail: "", ran: false }
  const result = await runShellLine(probe.command, {
    cwd: ctx.rootAbs,
    timeoutMs: 45_000,
    signal,
  })
  const text = outputTail(result, 600)
  if (result.missing || (probe.unsupported && probe.unsupported.test(text)))
    return { ok: false, detail: text, unsupported: true, ran: true }
  if (result.timedOut)
    return { ok: false, detail: "timed out", unsupported: true, ran: true }
  return {
    ok: result.ok,
    detail: text || (result.ok ? "passed" : `exit ${result.exitCode}`),
    ran: true,
  }
}

export function probeKey(root: string, probeId: string) {
  return `${root || "."}:${probeId}`
}

function probeSpecs(
  recipe: Recipe,
  ctx: RecipeContext,
  root: string
): ProbeSpec[] {
  return recipe.probes(ctx).map((p) => ({
    id: probeKey(root, p.id),
    label: p.label,
    cwd: root,
    class: p.class,
    ...(p.command ? { command: p.command } : {}),
  }))
}

async function environmentDrafts(
  root: ProjectRoot,
  id: EcosystemId,
  ctx: RecipeContext,
  checks: CheckResults,
  toolMissing: boolean,
  signal?: AbortSignal
): Promise<FindingDraft[]> {
  const recipe = RECIPES[id]
  const setup = recipe.setup(ctx)
  const noun = ENV_NOUN[id] ?? `${ECOSYSTEM_INFO[id].manager} setup`
  const language = languageOf(root, id)
  const key = draftId("main-env", root.dir, id)
  const commands = inWorkspace(root.dir, setup)
  const specs = probeSpecs(recipe, ctx, root.dir)
  const verify = specs.filter((s) => s.class === "passive")
  const install: Fix | null = commands.length
    ? {
        kind: "run-command",
        summary: commands.map((c) => c.command).join(", then "),
        commands,
        verify,
      }
    : null
  const base = {
    key,
    category: "main-environment" as const,
    source: "recipe" as const,
    root: root.dir,
  }
  const lockNote = recipe.lockfiles.find((l) => root.files.includes(l))
  const evidenceBase = [
    {
      kind: "manifest" as const,
      label: `${ECOSYSTEM_INFO[id].manager} project${where(root.dir)}${lockNote ? ` (${lockNote})` : ""}`,
      ...(lockNote ? { path: path.posix.join(root.dir, lockNote) } : {}),
    },
  ]
  const toolNote = toolMissing
    ? " Install the toolchain first (see Toolchains)."
    : ""

  const state = recipe.envState?.(ctx) ?? null
  if (state && !state.present) {
    if (!install) return []
    return [
      {
        ...base,
        severity: recipe.missingSeverity,
        title: `${noun} missing${where(root.dir)}`,
        explanation: `${language}${where(root.dir)} uses ${ECOSYSTEM_INFO[id].manager}, but ${state.evidence.replace(/^No /, "there's no ")}. Agents couldn't run the project or its checks.${toolNote}`,
        evidence: [...evidenceBase, { kind: "file", label: state.evidence }],
        confidence: "verified",
        fix: install,
      },
    ]
  }
  if (state?.staleAgainst && install)
    return [
      {
        ...base,
        severity: "blocker",
        title: `${noun}${where(root.dir)} is out of date`,
        explanation: `${state.staleAgainst} changed after the environment was last installed, so installed packages may not match what the project expects.${toolNote}`,
        evidence: [
          ...evidenceBase,
          {
            kind: "file",
            label: `${state.staleAgainst} is newer than the environment`,
            path: path.posix.join(root.dir, state.staleAgainst),
          },
        ],
        confidence: "likely",
        fix: install,
      },
    ]

  // Passive probes decide; project-code probes only from stored results.
  const probes = recipe.probes(ctx)
  const failures: string[] = []
  const passes: string[] = []
  for (const probe of probes) {
    if (probe.class === "executes-project-code") {
      const stored = checks[probeKey(root.dir, probe.id)]
      if (!stored) continue
      ;(stored.ok ? passes : failures).push(
        `${probe.label}: ${stored.detail || (stored.ok ? "passed" : "failed")}`
      )
      continue
    }
    if (toolMissing && probe.command) continue
    const outcome = await runProbe(probe, ctx, signal)
    if (!outcome.ran || outcome.unsupported) continue
    ;(outcome.ok ? passes : failures).push(`${probe.label}: ${outcome.detail}`)
  }
  if (failures.length && install)
    return [
      {
        ...base,
        severity: state ? "blocker" : recipe.missingSeverity,
        title: state
          ? `${noun}${where(root.dir)} doesn't match the project`
          : `${noun}${where(root.dir)} aren't ready`,
        explanation: `A readiness check failed, so the installed dependencies don't match what the project declares.${toolNote}`,
        evidence: [
          ...evidenceBase,
          ...failures.map((f) => ({
            kind: "probe" as const,
            label: f.split(":")[0],
            detail: f
              .slice(f.indexOf(":") + 1)
              .trim()
              .slice(0, 400),
          })),
        ],
        confidence: "verified",
        fix: install,
      },
    ]
  if (passes.length)
    return [
      {
        ...base,
        severity: "info",
        title: `${noun}${where(root.dir)} ${/s$|dependencies|packages|crates|modules|gems/.test(noun) ? "are" : "is"} ready`,
        explanation: "The readiness checks passed.",
        evidence: [
          ...evidenceBase,
          ...passes.map((p) => ({
            kind: "probe" as const,
            label: p.split(":")[0],
            detail: p
              .slice(p.indexOf(":") + 1)
              .trim()
              .slice(0, 200),
          })),
        ],
        confidence: "verified",
        fix: {
          kind: "manual",
          summary: "Nothing to do",
          steps: ["No action needed."],
        },
        resolution: "Checks passed",
      },
    ]
  // Nothing conclusive: offer the project-code checks, or say what's unverified.
  const projectChecks = specs.filter((s) => s.class === "executes-project-code")
  if (projectChecks.length && !toolMissing)
    return [
      {
        ...base,
        severity: "info",
        title: `Can't confirm the ${noun}${where(root.dir)} without running the project's build scripts`,
        explanation: `Checking ${ECOSYSTEM_INFO[id].manager} means running ${language} build code, which North Star only does when you ask. Run the checks, or run the setup to make sure.`,
        evidence: evidenceBase,
        confidence: "likely",
        fix: {
          kind: "run-checks",
          summary: `Run ${projectChecks.map((p) => `\`${p.command}\``).join(", ")}`,
          probes: projectChecks,
        },
        alternatives: install ? [install] : [],
      },
    ]
  if (state?.present && install)
    return [
      {
        ...base,
        severity: "info",
        title: `${noun}${where(root.dir)} found, not verified`,
        explanation: `${state.evidence}. North Star has no check that confirms it matches the project${toolMissing ? " (the toolchain is missing)" : ""}, so it isn't reported as ready. Running the setup again is safe.`,
        evidence: [...evidenceBase, { kind: "file", label: state.evidence }],
        confidence: "likely",
        fix: install,
      },
    ]
  return []
}

// ── Worktree environment ────────────────────────────────────────────────────

function worktreeDrafts(
  inventory: Inventory,
  ignored: IgnoredEntry[],
  contexts: Map<string, RecipeContext>,
  settings: CurrentSettings
): FindingDraft[] {
  const out: FindingDraft[] = []
  const handled = new Set<string>()
  // Environments present in the main checkout.
  for (const entry of ignored.filter(
    (e) => e.class === "environment" && e.ecosystem
  )) {
    const root = inventory.roots.find((r) => r.dir === entry.root)
    const ctx = contexts.get(entry.root)
    const recipe = RECIPES[entry.ecosystem!]
    if (!root || !ctx) continue
    const setup = recipe.setup(ctx, "worktree")
    const decision = recipe.link?.(ctx, entry) ?? {
      link: false,
      reason:
        "Its contents are tied to this checkout, so each worktree builds its own.",
      verified: false,
    }
    const noun = entry.path
    if (decision.link) {
      const key = draftId("worktree-env:link", entry.path)
      handled.add(`${entry.root}|${entry.ecosystem}`)
      const alt: Fix[] = setup.length
        ? [
            {
              kind: "apply-settings",
              summary: `Instead, run ${setup.map((s) => s.command).join(", then ")} in each worktree`,
              patch: {
                worktreeSetupSteps: {
                  add: toSteps(
                    draftId("env", entry.root, entry.ecosystem!),
                    entry.root,
                    setup
                  ),
                },
              },
            },
          ]
        : []
      out.push({
        key,
        category: "worktree-environment",
        severity: "warning",
        title: `New worktrees won't have ${noun}`,
        explanation: `${noun} is ignored by Git, so every story's worktree starts without it and agents can't run the project. ${decision.reason} Link it from this checkout (instant, nothing to install).`,
        evidence: [
          {
            kind: "file",
            label: `${noun} exists here and is ignored`,
            path: entry.path,
          },
          {
            kind: decision.verified ? "file" : "manifest",
            label: decision.reason,
          },
        ],
        confidence: decision.verified ? "verified" : "likely",
        source: "rule",
        root: entry.root,
        fix: {
          kind: "apply-settings",
          summary: `Link ${noun} into each worktree`,
          patch: { worktreeLinkPaths: { add: [entry.path] } },
        },
        alternatives: alt,
      })
      continue
    }
    if (!setup.length) continue
    const groupKey = `${entry.root}|${entry.ecosystem}`
    if (handled.has(groupKey)) continue
    handled.add(groupKey)
    const key = draftId("worktree-env:setup", entry.root, entry.ecosystem!)
    const { steps, shared } = worktreeSteps(entry.ecosystem!, ctx, entry.root)
    const userLinked = settings.linkPaths.includes(entry.path)
    const cheap = shared
      ? " Each worktree gets a thin environment of its own that reuses this checkout's installed packages, so it's ready in about a second with nothing to download; it installs only what a story adds."
      : recipe.cheap
        ? ` ${ECOSYSTEM_INFO[entry.ecosystem!].manager} keeps a shared cache, so this is quick.`
        : ""
    out.push({
      key,
      category: "worktree-environment",
      severity: "warning",
      title: userLinked
        ? `Linked ${noun} would run the main checkout's code`
        : `New worktrees won't have ${noun}`,
      explanation: userLinked
        ? `${decision.reason} Replace the link with a setup step that builds each worktree its own.${cheap}`
        : `${noun} is ignored by Git, so every story's worktree starts without it. ${decision.reason} Each worktree needs its own, so run the setup there.${cheap}`,
      evidence: [
        {
          kind: "file",
          label: `${noun} exists here and is ignored`,
          path: entry.path,
        },
        {
          kind: decision.verified ? "file" : "manifest",
          label: decision.reason,
        },
        ...(userLinked
          ? [
              {
                kind: "setting" as const,
                label: `Advanced settings link ${entry.path}`,
              },
            ]
          : []),
      ],
      confidence: decision.verified ? "verified" : "likely",
      source: "rule",
      root: entry.root,
      replacesUserSetting: userLinked,
      fix: {
        kind: "apply-settings",
        summary: shared
          ? `Give each new worktree its own ${steps[0].venv} that reuses this checkout's packages${entry.root ? ` (in ${entry.root}/)` : ""}`
          : `Run ${steps.map((s) => `\`${s.command}\``).join(", then ")} in each new worktree${entry.root ? ` (in ${entry.root}/)` : ""}`,
        patch: {
          worktreeSetupSteps: { add: steps },
          ...(userLinked
            ? { worktreeLinkPaths: { remove: [entry.path] } }
            : {}),
        },
      },
    })
  }
  // Environments not installed here yet: worktrees will need them too. The
  // safe choice without evidence is a setup step.
  for (const root of inventory.roots) {
    const ctx = contexts.get(root.dir)!
    for (const id of root.ecosystems) {
      const recipe = RECIPES[id]
      if (!recipe.envState || handled.has(`${root.dir}|${id}`)) continue
      const state = recipe.envState(ctx)
      if (state.present) continue
      const setup = recipe.setup(ctx, "worktree")
      if (!setup.length) continue
      const { steps } = worktreeSteps(id, ctx, root.dir)
      out.push({
        key: draftId("worktree-env:setup", root.dir, id),
        category: "worktree-environment",
        severity: "warning",
        title: `Worktrees will need the ${ENV_NOUN[id] ?? ECOSYSTEM_INFO[id].manager}${where(root.dir)}`,
        explanation: `Stories run in fresh worktrees that only have tracked files. Run the same setup there so agents can run the project.${recipe.cheap ? ` ${ECOSYSTEM_INFO[id].manager} keeps a shared cache, so this is quick.` : ""}`,
        evidence: [
          {
            kind: "manifest",
            label: `${ECOSYSTEM_INFO[id].manager} project${where(root.dir)}`,
          },
        ],
        confidence: "likely",
        source: "recipe",
        root: root.dir,
        fix: {
          kind: "apply-settings",
          summary: `Run ${steps.map((s) => `\`${s.command}\``).join(", then ")} in each new worktree`,
          patch: { worktreeSetupSteps: { add: steps } },
        },
      })
    }
  }
  return out
}

function localConfigDrafts(ignored: IgnoredEntry[]): FindingDraft[] {
  return ignored
    .filter((e) => e.class === "local-config")
    .slice(0, 12)
    .map((entry) => ({
      key: draftId("local-config", entry.path),
      category: "local-config" as const,
      severity: "warning" as const,
      title: `New worktrees won't have ${entry.path}`,
      explanation: `${entry.path} is ignored local configuration (often secrets or machine paths). Worktrees start without it, so the project may fail to start or connect. Link it from this checkout; North Star never reads its contents.`,
      evidence: [
        {
          kind: "file" as const,
          label: `${entry.path} exists and is ignored`,
          path: entry.path,
        },
      ],
      confidence: "verified" as const,
      source: "rule" as const,
      root: entry.root,
      fix: {
        kind: "apply-settings" as const,
        summary: `Link ${entry.path} into each worktree`,
        patch: { worktreeLinkPaths: { add: [entry.path] } },
      },
    }))
}

function buildCostDrafts(
  inventory: Inventory,
  contexts: Map<string, RecipeContext>
): FindingDraft[] {
  const out: FindingDraft[] = []
  for (const root of inventory.roots) {
    const heavy = root.ecosystems.filter((id) => RECIPES[id].heavy?.length)
    if (!heavy.length) continue
    const advice = [...new Set(heavy.flatMap((id) => RECIPES[id].heavy!))]
    const names = heavy.map((id) => ECOSYSTEM_INFO[id].manager).join(", ")
    const outputs = contexts
      .get(root.dir)!
      .ignored.filter((e) => e.class === "build-output" && e.heavy)
    out.push({
      key: draftId("build-cost", root.dir),
      category: "build-cost",
      severity: "info",
      title: `Builds${where(root.dir)} start from scratch in each worktree`,
      explanation: `${names} build outputs aren't shared between worktrees (and must not be linked: concurrent builds would corrupt them). The first build in each story's worktree is a full one.`,
      evidence: [
        { kind: "manifest", label: `${names} project${where(root.dir)}` },
        ...outputs.slice(0, 3).map((o) => ({
          kind: "file" as const,
          label: `${o.path} is a build output here`,
          path: o.path,
        })),
      ],
      confidence: "verified",
      source: "recipe",
      root: root.dir,
      fix: {
        kind: "manual",
        summary: "Share caches, not outputs",
        steps: advice,
      },
    })
  }
  return out
}

function generatedDrafts(
  groups: GeneratedGroup[],
  workspace: string
): FindingDraft[] {
  return groups.map((group) => {
    const verdict = group.command
      ? checkGeneratedCommand(group.command, workspace)
      : null
    const command = verdict?.ok ? group.command : null
    const title = group.lockfile
      ? `${group.label.split(" ")[0]} will conflict when parallel stories change dependencies`
      : `Generated ${group.label} will cause merge conflicts`
    const paths = group.paths.join(", ")
    // "dir/**" and "*.g.dart" name many files.
    const one = group.paths.length === 1 && !group.paths[0].includes("*")
    return {
      key: group.key,
      category: "generated-files" as const,
      severity: "warning" as const,
      title,
      explanation: command
        ? `${paths} ${one ? "is" : "are"} generated. When two stories both change ${group.lockfile ? "dependencies" : one ? "it" : "them"}, the merge would conflict on generated text. Regenerate after merging instead${group.needs ? ` (this command needs ${group.needs})` : ""}.`
        : `${paths} ${one ? "looks" : "look"} generated, but North Star couldn't tell which command regenerates ${one ? "it" : "them"}${verdict && !verdict.ok ? ` (the likely command isn't allowed: ${verdict.reason})` : ""}. Add the command so merges regenerate instead of conflicting.`,
      evidence: group.evidence,
      confidence: group.confidence,
      source: "rule" as const,
      root: group.root,
      fix: command
        ? {
            kind: "apply-settings" as const,
            summary: `Regenerate with \`${command}\` after merging`,
            patch: {
              generatedFiles: { add: [{ paths: group.paths, command }] },
            },
          }
        : {
            kind: "manual" as const,
            summary: "Add the regeneration command",
            steps: [
              `In Advanced settings → Generated files, add a rule for ${paths} with the command that rebuilds ${group.paths.length === 1 ? "it" : "them"}.`,
            ],
          },
    }
  })
}

// ── Fingerprint and excerpts ────────────────────────────────────────────────

const FINGERPRINT_NAMES =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(\.lock)?|requirements[^/]*\.txt|environment\.ya?ml|Cargo\.(toml|lock)|go\.(mod|sum|work)|composer\.(json|lock)|Gemfile(\.lock)?|pubspec\.(yaml|lock)|Podfile(\.lock)?|Package\.(swift|resolved)|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|[^/]+\.(csproj|sln|slnx)|global\.json|CMakeLists\.txt|CMakePresets\.json|meson\.build|configure\.ac|vcpkg\.json|conanfile\.(txt|py)|\.gitignore|\.gitattributes|\.python-version|\.nvmrc|\.node-version|\.tool-versions|mise\.toml|\.java-version|\.ruby-version|rust-toolchain(\.toml)?|\.fvmrc|buf\.gen\.ya?ml|codegen\.(ya?ml|ts|json)|sqlc\.ya?ml|schema\.prisma|swiftgen\.yml|openapitools\.json|project\.yml|Project\.swift|deno\.jsonc?|dbt_project\.yml|packages\.yml|(docker-)?compose[^/]*\.ya?ml)$/

async function computeFingerprint(
  workspace: string,
  git: GitFacts,
  inventory: Inventory,
  ignoredRaw: string[]
): Promise<string> {
  const hash = createHash("sha256")
  hash.update(
    JSON.stringify({
      repo: git.isRepo,
      root: git.root,
      sub: git.subpath,
      unborn: git.unborn,
      branch: git.branch,
    })
  )
  const files = inventory.roots.flatMap((r) =>
    r.files.map((f) => path.posix.join(r.dir, f))
  )
  for (const file of [...new Set([...files, ".gitignore", ".gitattributes"])]
    .filter((f) => FINGERPRINT_NAMES.test(f))
    .sort()) {
    try {
      const stat = statSync(path.join(workspace, file))
      hash.update(`${file}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`)
    } catch {
      hash.update(`${file}:missing\n`)
    }
  }
  hash.update([...ignoredRaw].sort().join("\n"))
  return hash.digest("hex").slice(0, 24)
}

// Cheap freshness check: the same inputs, without running probes.
export async function currentFingerprint(
  workspace: string
): Promise<string | null> {
  if (!existsSync(workspace)) return null
  const git = await gitFacts(workspace)
  const listed = git.isRepo
    ? await listProjectFiles(workspace, MAX_FILES)
    : null
  const files = listed?.files ?? walk(workspace, MAX_FILES)
  const inventory = await detectProjects(files, reader(workspace))
  const ignoredRaw = git.isRepo ? await listIgnoredPresent(workspace) : []
  return computeFingerprint(workspace, git, inventory, ignoredRaw)
}

// Setup-relevant excerpts for the model: README setup sections, CI install
// steps, Makefile targets, ignore/attribute files, manifest scripts. Never
// .env contents or arbitrary source.
async function setupExcerpts(
  files: string[],
  read: (f: string) => Promise<string | null>
) {
  const out: Array<{ path: string; text: string }> = []
  const add = (p: string, text: string | null, max = 3000) => {
    if (text && text.trim()) out.push({ path: p, text: text.slice(0, max) })
  }
  const readme = files.find((f) => /^readme(\.md|\.rst|\.txt)?$/i.test(f))
  if (readme) {
    const text = (await read(readme)) ?? ""
    const sections = text
      .split(/\n(?=#{1,3}\s)/)
      .filter((s) =>
        /^#{1,3}\s.*(install|setup|set up|getting started|develop|build|quick ?start|requirements|prerequisites|running|testing)/im.test(
          s
        )
      )
    add(readme, sections.join("\n").slice(0, 4000) || null, 4000)
  }
  for (const f of files
    .filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
    .slice(0, 3)) {
    const text = (await read(f)) ?? ""
    const steps = text
      .split("\n")
      .filter(
        (l) => /^\s*(-\s*)?(run|uses|name):/.test(l) || /^\s{8,}\S/.test(l)
      )
      .join("\n")
    add(f, steps, 2000)
  }
  for (const f of files
    .filter((f) => /(^|\/)(Makefile|justfile|Taskfile\.ya?ml)$/.test(f))
    .slice(0, 2))
    add(
      f,
      ((await read(f)) ?? "")
        .split("\n")
        .filter((l) => /^[\w.-]+\s*:/.test(l) || /^\t/.test(l))
        .join("\n"),
      2000
    )
  for (const f of files
    .filter((f) => /(^|\/)\.gitignore$|(^|\/)\.gitattributes$/.test(f))
    .slice(0, 3))
    add(f, await read(f), 1500)
  for (const f of files
    .filter((f) => /(^|\/)package\.json$/.test(f) && f.split("/").length <= 3)
    .slice(0, 4)) {
    const scripts = /"scripts"\s*:\s*\{[^}]*\}/.exec((await read(f)) ?? "")?.[0]
    add(f, scripts ?? null, 1500)
  }
  return out.slice(0, 14)
}
