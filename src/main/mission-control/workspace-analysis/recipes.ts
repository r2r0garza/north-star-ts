import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
} from "fs"
import path from "path"
import type {
  CommandSpec,
  ProbeClass,
} from "../../../shared/mission-control/workspace-analysis"
import type { IgnoredEntry } from "./ignored"
import type { EcosystemId, ProjectRoot, ToolchainPin } from "./inventory"
import { satisfies as satisfiesRange } from "./toolchains"

// Stage 5 (plan 106.11): the recipe table. For each ecosystem: the tool it
// needs, the commands that set up its environment, how to check readiness
// without installing anything, whether its environment can be linked into a
// worktree, and how to regenerate its lockfile after a merge. No model
// involvement: a recipe is code, and its tests pin the exact commands.
//
// Command flags were chosen for current tool versions; a probe whose flag an
// older tool doesn't know reports "unsupported" (never a false failure) and the
// finding falls back to filesystem evidence at lower confidence.

export const RECIPE_VERSION = 1

export interface RecipeContext {
  root: ProjectRoot
  // Absolute directory of the root, and of the workspace.
  rootAbs: string
  workspaceAbs: string
  // Ignored-but-present entries inside this root (root-relative paths).
  ignored: IgnoredEntry[]
  platform: NodeJS.Platform
  // Python projects: the interpreter environments are created with, chosen
  // to meet requires-python, and the requirement itself.
  python?: { exe: string; version: string | null; satisfied: boolean } | null
  requiresPython?: string | null
}

export interface ToolSpec {
  exe: string
  versionArgs: string[]
  label: string
  pin?: ToolchainPin["tool"]
  // How to get it when it's missing.
  install: { steps: string[]; link?: string }
  // A version-manager install command per manager, by `{version}`.
  managers?: Partial<Record<VersionManager, string>>
}

export type VersionManager =
  | "mise"
  | "asdf"
  | "pyenv"
  | "uv"
  | "fnm"
  | "volta"
  | "rbenv"
  | "rustup"
  | "fvm"
  | "corepack"

export interface ProbeOutcome {
  ok: boolean
  detail: string
  // The tool doesn't support the probe (an old version): not a failure.
  unsupported?: boolean
}

export interface ProbeDef {
  id: string
  label: string
  class: ProbeClass
  // A shell line run in the root directory.
  command?: string
  // Output that means "this tool version can't do this check".
  unsupported?: RegExp
  // A filesystem check, evaluated in-process.
  fs?: (ctx: RecipeContext) => ProbeOutcome
}

export interface EnvState {
  present: boolean
  // What was looked at, for evidence.
  evidence: string
  // The environment exists but is older than the lockfile.
  staleAgainst?: string
}

export interface LinkDecision {
  link: boolean
  reason: string
  // Verified from the environment itself (editable markers, symlinks).
  verified: boolean
}

export interface Recipe {
  id: EcosystemId
  tool: (ctx: RecipeContext) => ToolSpec
  // Commands that create the environment / resolve dependencies, run in the
  // root directory (cwd is root-relative, "" = the root).
  // "worktree": the steps saved for every new worktree, which must not depend
  // on the main checkout's current state (a broken venv there, say).
  setup: (ctx: RecipeContext, mode?: "main" | "worktree") => CommandSpec[]
  // Root-relative environment paths the setup creates (for link decisions).
  envPaths: string[]
  // Null: the ecosystem keeps dependencies in a global cache; nothing local.
  envState: ((ctx: RecipeContext) => EnvState) | null
  probes: (ctx: RecipeContext) => ProbeDef[]
  link?: (ctx: RecipeContext, entry: IgnoredEntry) => LinkDecision
  lockfiles: string[]
  lockRegen?: (ctx: RecipeContext) => string | null
  // Setup per worktree is cheap thanks to a global cache.
  cheap: boolean
  // Rebuilds are heavy; advice for the build-cost finding.
  heavy?: string[]
  // Severity when the environment is missing in the main workspace.
  missingSeverity: "blocker" | "warning"
}

// ── helpers ─────────────────────────────────────────────────────────────────

function abs(ctx: RecipeContext, rel: string) {
  return path.join(ctx.rootAbs, rel)
}
function has(ctx: RecipeContext, rel: string) {
  return existsSync(abs(ctx, rel))
}
function mtime(file: string): number | null {
  try {
    return statSync(file).mtimeMs
  } catch {
    return null
  }
}
function readSmall(file: string, max = 256 * 1024): string | null {
  try {
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > max) return null
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}
function fileNames(ctx: RecipeContext) {
  return new Set(ctx.root.files)
}

// An environment directory and whether a lockfile is newer than its marker.
function envAt(
  ctx: RecipeContext,
  dir: string,
  marker: string,
  lockfiles: string[]
): EnvState {
  const markerPath = abs(ctx, path.join(dir, marker))
  if (!existsSync(abs(ctx, dir)) || !existsSync(markerPath))
    return { present: false, evidence: `No ${dir}/${marker}` }
  const envTime = mtime(markerPath) ?? 0
  const stale = lockfiles.find(
    (l) => (mtime(abs(ctx, l)) ?? 0) > envTime + 1000
  )
  return {
    present: true,
    evidence: `${dir}/${marker} exists`,
    ...(stale ? { staleAgainst: stale } : {}),
  }
}

// ── Python ──────────────────────────────────────────────────────────────────

const venvPython = (dir: string, platform: NodeJS.Platform) =>
  platform === "win32" ? `${dir}\\Scripts\\python.exe` : `${dir}/bin/python`

export function venvDir(ctx: RecipeContext): string {
  for (const dir of [".venv", "venv"])
    if (has(ctx, path.join(dir, "pyvenv.cfg"))) return dir
  return ".venv"
}

// Editable installs make a linked venv import the MAIN checkout's code from a
// worktree. Look for the markers pip/uv/Poetry leave in site-packages.
export function editableInstallInto(
  venv: string,
  workspace: string
): string | null {
  const lib = path.join(venv, "lib")
  const sitePackages: string[] = []
  try {
    for (const entry of readdirSync(lib)) {
      const sp = path.join(lib, entry, "site-packages")
      if (existsSync(sp)) sitePackages.push(sp)
    }
  } catch {
    // Windows layout.
    const sp = path.join(venv, "Lib", "site-packages")
    if (existsSync(sp)) sitePackages.push(sp)
  }
  const inWorkspace = (p: string) => {
    const rel = path.relative(workspace, p.trim())
    return !!p.trim() && !rel.startsWith("..") && !path.isAbsolute(rel)
  }
  for (const sp of sitePackages) {
    let entries: string[] = []
    try {
      entries = readdirSync(sp)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (
        /^__editable__.*\.pth$/.test(entry) ||
        /^__editable___.*_finder\.py$/.test(entry)
      )
        return path.join(sp, entry)
      if (entry.endsWith(".pth")) {
        const text = readSmall(path.join(sp, entry), 64 * 1024) ?? ""
        if (
          text
            .split("\n")
            .some((line) => !line.startsWith("import") && inWorkspace(line))
        )
          return path.join(sp, entry)
      }
      if (entry.endsWith(".dist-info")) {
        const direct = readSmall(
          path.join(sp, entry, "direct_url.json"),
          16 * 1024
        )
        if (direct && /"editable"\s*:\s*true/.test(direct)) {
          const url = /"url"\s*:\s*"file:\/\/([^"]+)"/.exec(direct)?.[1]
          if (!url || inWorkspace(decodeURIComponent(url)))
            return path.join(sp, entry, "direct_url.json")
        }
      }
    }
  }
  return null
}

// Will the project's own setup install it in editable mode? uv and Poetry do
// for a packaged project; the pip recipe does when there's no requirements
// file; Pipenv when the Pipfile says so.
export function installsEditable(ctx: RecipeContext): boolean {
  const pyproject = readSmall(abs(ctx, "pyproject.toml")) ?? ""
  const packaged = /\[build-system\]/.test(pyproject) || has(ctx, "setup.py")
  const eco = ctx.root.ecosystems
  if (eco.includes("uv"))
    return packaged && !/^\s*package\s*=\s*false/m.test(pyproject)
  if (eco.includes("poetry"))
    return !/^\s*package-mode\s*=\s*false/m.test(pyproject)
  if (eco.includes("pipenv"))
    return /editable\s*=\s*true|-e\s+\./.test(
      readSmall(abs(ctx, "Pipfile")) ?? ""
    )
  if (eco.includes("pip")) return packaged && !requirementsFiles(ctx).length
  return false
}

function pythonLink(ctx: RecipeContext, entry: IgnoredEntry): LinkDecision {
  const venv = path.join(ctx.workspaceAbs, entry.path)
  if (!existsSync(path.join(venv, "pyvenv.cfg")))
    return {
      link: false,
      reason: "It isn't a virtual environment.",
      verified: false,
    }
  // A venv built with a Python the project doesn't accept gets rebuilt.
  if (
    !venvFitsRequirement(
      ctx,
      entry.path.slice(ctx.root.dir ? ctx.root.dir.length + 1 : 0)
    )
  )
    return {
      link: false,
      reason:
        "It was built with a Python the project doesn't accept and has to be rebuilt; each worktree builds its own.",
      verified: true,
    }
  const editable = editableInstallInto(venv, ctx.workspaceAbs)
  if (editable)
    return {
      link: false,
      reason: `The project is installed in editable mode (${path.relative(ctx.workspaceAbs, editable)}), so a linked environment would import the main checkout's code instead of the worktree's.`,
      verified: true,
    }
  // Not editable yet, but the setup will make it so (the venv is new or
  // broken): decide for what it will be, not what it is.
  if (installsEditable(ctx))
    return {
      link: false,
      reason:
        "The project's setup installs it in editable mode, so a linked environment would import the main checkout's code instead of the worktree's.",
      verified: false,
    }
  return {
    link: true,
    reason:
      "The environment doesn't point back at the checkout, so every worktree can share it.",
    verified: true,
  }
}

const pythonTool = (exe = "python3"): ToolSpec => ({
  exe,
  versionArgs: ["--version"],
  label: "Python",
  pin: "python",
  install: {
    steps: ["Install Python 3 from python.org or with your version manager."],
    link: "https://www.python.org/downloads/",
  },
  managers: {
    uv: "uv python install {version}",
    pyenv: "pyenv install -s {version}",
    mise: "mise install python@{version}",
    asdf: "asdf install python {version}",
  },
})

function requirementsFiles(ctx: RecipeContext): string[] {
  const names = [...fileNames(ctx)].filter((n) =>
    /^requirements.*\.txt$/.test(n)
  )
  const main = names.includes("requirements.txt") ? ["requirements.txt"] : []
  const dev = names.filter((n) =>
    /^requirements[-_.]?(dev|test|tests|development)\.txt$/.test(n)
  )
  return main.length || dev.length ? [...main, ...dev] : names.slice(0, 1)
}

function pipCompileCommand(ctx: RecipeContext): string | null {
  for (const file of requirementsFiles(ctx)) {
    const text = readSmall(abs(ctx, file), 64 * 1024) ?? ""
    const header = text.split("\n").slice(0, 12).join("\n")
    if (!/autogenerated by (pip-compile|uv)/i.test(header)) continue
    const line = /^#\s+((?:uv pip compile|pip-compile)\b[^\n]*)$/m.exec(
      header
    )?.[1]
    if (line) return line.trim()
    return /uv/.test(header)
      ? `uv pip compile requirements.in -o ${file}`
      : `pip-compile --output-file=${file}`
  }
  return null
}

const uv: Recipe = {
  id: "uv",
  tool: () => ({
    exe: "uv",
    versionArgs: ["--version"],
    label: "uv",
    install: {
      steps: [
        "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh (or brew install uv).",
      ],
      link: "https://docs.astral.sh/uv/getting-started/installation/",
    },
  }),
  setup: () => [
    { label: "Install Python dependencies (uv)", command: "uv sync", cwd: "" },
  ],
  envPaths: [".venv"],
  envState: (ctx) => envAt(ctx, ".venv", "pyvenv.cfg", ["uv.lock"]),
  probes: () => [
    {
      id: "uv-check",
      label: "uv environment matches uv.lock",
      class: "passive",
      command: "uv sync --locked --check --offline",
      unsupported: /unexpected argument|unrecognized|Found argument/i,
    },
  ],
  link: pythonLink,
  lockfiles: ["uv.lock"],
  lockRegen: () => "uv lock",
  cheap: true,
  missingSeverity: "blocker",
}

const poetry: Recipe = {
  id: "poetry",
  tool: () => ({
    exe: "poetry",
    versionArgs: ["--version"],
    label: "Poetry",
    install: {
      steps: ["Install Poetry: pipx install poetry (or see the Poetry docs)."],
      link: "https://python-poetry.org/docs/#installation",
    },
  }),
  setup: (ctx) => [
    // Point Poetry at the interpreter that meets requires-python when the
    // default python3 doesn't.
    ...(ctx.python?.satisfied && ctx.python.exe !== "python3"
      ? [
          {
            label: "Use a supported Python",
            command: `poetry env use ${ctx.python.exe}`,
            cwd: "",
          },
        ]
      : []),
    {
      label: "Install Python dependencies (Poetry)",
      command: "poetry install",
      cwd: "",
    },
  ],
  envPaths: [".venv"],
  envState: (ctx) => {
    const local = envAt(ctx, ".venv", "pyvenv.cfg", ["poetry.lock"])
    return local.present
      ? local
      : {
          present: false,
          evidence: "No in-project .venv (Poetry may keep it elsewhere)",
        }
  },
  probes: () => [
    {
      id: "poetry-lock",
      label: "poetry.lock matches pyproject.toml",
      class: "passive",
      command: "poetry check --lock",
      unsupported: /does not exist|unknown option|The "--lock" option/i,
    },
    {
      id: "poetry-env",
      label: "Poetry has an environment for the project",
      class: "passive",
      command: "poetry env info --path",
    },
  ],
  link: pythonLink,
  lockfiles: ["poetry.lock"],
  lockRegen: () => "poetry lock",
  cheap: true,
  missingSeverity: "blocker",
}

const pipenv: Recipe = {
  id: "pipenv",
  tool: () => ({
    exe: "pipenv",
    versionArgs: ["--version"],
    label: "Pipenv",
    install: {
      steps: ["Install Pipenv: pipx install pipenv."],
      link: "https://pipenv.pypa.io/en/latest/installation.html",
    },
  }),
  setup: (ctx) => [
    {
      label: "Install Python dependencies (Pipenv)",
      command: `${fileNames(ctx).has("Pipfile.lock") ? "pipenv sync --dev" : "pipenv install --dev"}${ctx.python?.satisfied && ctx.python.exe !== "python3" ? ` --python ${ctx.python.exe}` : ""}`,
      cwd: "",
    },
  ],
  envPaths: [".venv"],
  envState: null,
  probes: () => [
    {
      id: "pipenv-venv",
      label: "Pipenv has an environment for the project",
      class: "passive",
      command: "pipenv --venv",
    },
    {
      id: "pipenv-verify",
      label: "Pipfile.lock is up to date",
      class: "passive",
      command: "pipenv verify",
      unsupported: /No such command/i,
    },
  ],
  link: pythonLink,
  lockfiles: ["Pipfile.lock"],
  lockRegen: () => "pipenv lock",
  cheap: false,
  missingSeverity: "blocker",
}

// The Python version a venv was created with (pyvenv.cfg).
export function venvVersion(ctx: RecipeContext, dir: string): string | null {
  const cfg = readSmall(abs(ctx, path.join(dir, "pyvenv.cfg")), 16 * 1024) ?? ""
  return /^\s*version(?:_info)?\s*=\s*([\d.]+)/m.exec(cfg)?.[1] ?? null
}

function venvFitsRequirement(ctx: RecipeContext, dir: string): boolean {
  const version = venvVersion(ctx, dir)
  if (!version || !ctx.requiresPython) return true
  return satisfiesRange(version, ctx.requiresPython) !== false
}

// Optional-dependency groups a developer installs (pytest lives there).
function devExtras(ctx: RecipeContext): string[] {
  const text = readSmall(abs(ctx, "pyproject.toml")) ?? ""
  const block =
    /\[project\.optional-dependencies\]([\s\S]*?)(\n\[|$)/.exec(text)?.[1] ?? ""
  const groups = [...block.matchAll(/^\s*([\w-]+)\s*=/gm)].map((m) => m[1])
  return groups.filter((g) =>
    /^(dev|develop|development|test|tests|testing|lint)$/.test(g)
  )
}

const pip: Recipe = {
  id: "pip",
  tool: () => pythonTool(),
  setup: (ctx, mode) => {
    const venv = venvDir(ctx)
    const python = ctx.python?.exe ?? "python3"
    const venvPy = venvPython(venv, ctx.platform)
    // A venv built with a Python the project doesn't accept is rebuilt.
    const rebuild =
      mode !== "worktree" &&
      has(ctx, path.join(venv, "pyvenv.cfg")) &&
      !venvFitsRequirement(ctx, venv)
    const reqs = requirementsFiles(ctx)
    const extras = devExtras(ctx)
    const install = reqs.length
      ? `${venvPy} -m pip install ${reqs.map((r) => `-r ${r}`).join(" ")}`
      : `${venvPy} -m pip install -e ${extras.length ? `'.[${extras.join(",")}]'` : "."}`
    return [
      {
        label: rebuild
          ? "Rebuild the virtual environment"
          : "Create a virtual environment",
        command: `${python} -m venv ${rebuild ? "--clear " : ""}${venv}`,
        cwd: "",
      },
      // The pip bundled with an older Python can't install pyproject-only
      // projects in editable mode (needs pip 21.3+).
      {
        label: "Update pip in the environment",
        command: `${venvPy} -m pip install --upgrade pip`,
        cwd: "",
      },
      { label: "Install Python dependencies (pip)", command: install, cwd: "" },
    ]
  },
  envPaths: [".venv", "venv"],
  envState: (ctx) =>
    envAt(ctx, venvDir(ctx), "pyvenv.cfg", requirementsFiles(ctx)),
  probes: (ctx) => [
    {
      id: "venv-python",
      label: "The environment's Python meets requires-python",
      class: "passive",
      fs: () => {
        const version = venvVersion(ctx, venvDir(ctx))
        return venvFitsRequirement(ctx, venvDir(ctx))
          ? {
              ok: true,
              detail: version ? `Python ${version}` : "version unknown",
            }
          : {
              ok: false,
              detail: `Built with Python ${version}; the project requires ${ctx.requiresPython}`,
            }
      },
    },
    {
      id: "pip-check",
      label: "Installed packages are consistent",
      class: "passive",
      command: `${venvPython(venvDir(ctx), ctx.platform)} -m pip check`,
      unsupported: /No module named pip/i,
    },
  ],
  link: pythonLink,
  lockfiles: [],
  lockRegen: pipCompileCommand,
  cheap: false,
  missingSeverity: "blocker",
}

const conda: Recipe = {
  id: "conda",
  tool: () => ({
    exe: "conda",
    versionArgs: ["--version"],
    label: "conda",
    install: {
      steps: ["Install Miniconda or Miniforge."],
      link: "https://github.com/conda-forge/miniforge",
    },
  }),
  setup: (ctx) => [
    {
      label: "Create the conda environment",
      command: `conda env create -p ./.conda -f ${fileNames(ctx).has("environment.yaml") ? "environment.yaml" : "environment.yml"}`,
      cwd: "",
    },
  ],
  envPaths: [".conda"],
  envState: (ctx) => envAt(ctx, ".conda", "conda-meta", []),
  probes: () => [
    {
      id: "conda-python",
      label: "The conda environment runs Python",
      class: "passive",
      command: 'conda run -p ./.conda python -c ""',
    },
  ],
  link: () => ({
    link: false,
    reason:
      "A conda environment records its own absolute prefix, so it can't be shared by link.",
    verified: true,
  }),
  lockfiles: [],
  cheap: false,
  missingSeverity: "blocker",
}

// ── JavaScript / TypeScript ─────────────────────────────────────────────────

const nodeTool = (): ToolSpec => ({
  exe: "node",
  versionArgs: ["--version"],
  label: "Node.js",
  pin: "node",
  install: {
    steps: ["Install Node.js (LTS) from nodejs.org or with a version manager."],
    link: "https://nodejs.org/en/download",
  },
  managers: {
    fnm: "fnm install {version}",
    volta: "volta install node@{version}",
    mise: "mise install node@{version}",
    asdf: "asdf install nodejs {version}",
  },
})

function packageJsonDeps(file: string): string[] {
  const text = readSmall(file)
  if (!text) return []
  try {
    const json = JSON.parse(text) as Record<
      string,
      Record<string, string> | undefined
    >
    return [
      ...new Set([
        ...Object.keys(json.dependencies ?? {}),
        ...Object.keys(json.devDependencies ?? {}),
      ]),
    ]
  } catch {
    return []
  }
}

// Every direct dependency of the root (and its workspace members) is
// installed. Passive: reads package.json and looks in node_modules.
function nodeModulesProbe(ctx: RecipeContext): ProbeOutcome {
  const dirs = [
    ctx.rootAbs,
    ...ctx.root.members.map((m) => path.join(ctx.workspaceAbs, m)),
  ]
  const missing: string[] = []
  let checked = 0
  for (const dir of dirs) {
    for (const dep of packageJsonDeps(path.join(dir, "package.json"))) {
      // A workspace sibling is linked, not installed from the registry.
      checked++
      const found = [dir, ctx.rootAbs].some((base) => {
        try {
          lstatSync(path.join(base, "node_modules", dep))
          return true
        } catch {
          return false
        }
      })
      if (!found) missing.push(dep)
    }
  }
  if (!checked) return { ok: true, detail: "No dependencies declared" }
  return missing.length
    ? {
        ok: false,
        detail: `${missing.length} of ${checked} dependencies aren't installed: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", …" : ""}`,
      }
    : { ok: true, detail: `All ${checked} direct dependencies are installed` }
}

function pnpProbe(ctx: RecipeContext): ProbeOutcome {
  if (!has(ctx, ".pnp.cjs"))
    return {
      ok: false,
      detail: "No .pnp.cjs (Yarn Plug'n'Play hasn't installed)",
    }
  const lock = mtime(abs(ctx, "yarn.lock")) ?? 0
  const state =
    mtime(abs(ctx, ".yarn/install-state.gz")) ??
    mtime(abs(ctx, ".pnp.cjs")) ??
    0
  return state + 1000 < lock
    ? { ok: false, detail: "yarn.lock is newer than the last install" }
    : { ok: true, detail: ".pnp.cjs is up to date with yarn.lock" }
}

function nodeLink(ctx: RecipeContext, entry: IgnoredEntry): LinkDecision {
  if (ctx.root.flags.workspaces || ctx.root.members.length)
    return {
      link: false,
      reason:
        "This is a monorepo: node_modules links workspace packages from the main checkout, so a linked copy would run the main checkout's code.",
      verified: true,
    }
  if (
    entry.path.endsWith("node_modules") &&
    hasWorkspaceLinks(path.join(ctx.workspaceAbs, entry.path), ctx.workspaceAbs)
  )
    return {
      link: false,
      reason:
        "node_modules contains links into the checkout, so a linked copy would point at the main checkout.",
      verified: true,
    }
  return {
    link: true,
    reason:
      "A single package's node_modules doesn't point back at the checkout, so worktrees can share it.",
    verified: true,
  }
}

// Top-level node_modules symlinks that resolve inside the workspace.
function hasWorkspaceLinks(nodeModules: string, workspace: string): boolean {
  let entries: string[] = []
  try {
    entries = readdirSync(nodeModules)
  } catch {
    return false
  }
  for (const entry of entries.slice(0, 2000)) {
    const names = entry.startsWith("@")
      ? (() => {
          try {
            return readdirSync(path.join(nodeModules, entry)).map((n) =>
              path.join(entry, n)
            )
          } catch {
            return []
          }
        })()
      : [entry]
    for (const name of names) {
      const full = path.join(nodeModules, name)
      try {
        if (!lstatSync(full).isSymbolicLink()) continue
        const target = path.resolve(path.dirname(full), readlinkSafe(full))
        const rel = path.relative(workspace, target)
        if (
          !rel.startsWith("..") &&
          !rel.startsWith("node_modules") &&
          !rel.includes(`${path.sep}node_modules${path.sep}`) &&
          !path.isAbsolute(rel)
        )
          return true
      } catch {
        // unreadable: ignore
      }
    }
  }
  return false
}

function readlinkSafe(file: string): string {
  try {
    return readlinkSync(file)
  } catch {
    return ""
  }
}

function nodeRecipe(
  id: "pnpm" | "npm" | "yarn" | "bun",
  lockfiles: string[]
): Recipe {
  const berry = (ctx: RecipeContext) => ctx.root.flags.yarnBerry
  return {
    id,
    tool: () =>
      id === "npm"
        ? { ...nodeTool(), exe: "npm", label: "npm (Node.js)" }
        : id === "bun"
          ? {
              exe: "bun",
              versionArgs: ["--version"],
              label: "Bun",
              pin: "bun",
              install: {
                steps: [
                  "Install Bun: curl -fsSL https://bun.sh/install | bash (or brew install oven-sh/bun/bun).",
                ],
                link: "https://bun.sh/docs/installation",
              },
              managers: { mise: "mise install bun@{version}" },
            }
          : {
              exe: id,
              versionArgs: ["--version"],
              label: id === "pnpm" ? "pnpm" : "Yarn",
              pin: id,
              install: {
                steps: [
                  `Enable ${id} with Corepack (bundled with Node.js): corepack enable ${id}.`,
                ],
                link:
                  id === "pnpm"
                    ? "https://pnpm.io/installation"
                    : "https://yarnpkg.com/getting-started/install",
              },
              managers: { corepack: `corepack enable ${id}` },
            },
    setup: (ctx) => {
      const own = fileNames(ctx)
      const locked = lockfiles.some((l) => own.has(l))
      const command =
        id === "pnpm"
          ? locked
            ? "pnpm install --frozen-lockfile"
            : "pnpm install"
          : id === "npm"
            ? locked
              ? "npm ci"
              : "npm install"
            : id === "yarn"
              ? locked
                ? berry(ctx)
                  ? "yarn install --immutable"
                  : "yarn install --frozen-lockfile"
                : "yarn install"
              : locked
                ? "bun install --frozen-lockfile"
                : "bun install"
      return [
        { label: `Install JavaScript dependencies (${id})`, command, cwd: "" },
      ]
    },
    envPaths:
      id === "yarn"
        ? ["node_modules", ".yarn/cache", ".pnp.cjs"]
        : ["node_modules"],
    envState: (ctx) => {
      if (id === "yarn" && ctx.root.flags.yarnPnp) {
        return has(ctx, ".pnp.cjs")
          ? { present: true, evidence: ".pnp.cjs exists" }
          : { present: false, evidence: "No .pnp.cjs" }
      }
      const marker =
        id === "pnpm"
          ? ".modules.yaml"
          : id === "npm"
            ? ".package-lock.json"
            : id === "yarn"
              ? berry(ctx)
                ? ".yarn-state.yml"
                : ".yarn-integrity"
              : ".bin"
      if (!has(ctx, "node_modules"))
        return { present: false, evidence: "No node_modules" }
      const state = envAt(
        ctx,
        "node_modules",
        has(ctx, path.join("node_modules", marker)) ? marker : ".",
        lockfiles.filter((l) => fileNames(ctx).has(l))
      )
      return { ...state, present: true }
    },
    probes: (ctx) => [
      id === "yarn" && ctx.root.flags.yarnPnp
        ? {
            id: "yarn-pnp",
            label: "Yarn Plug'n'Play install is current",
            class: "passive",
            fs: pnpProbe,
          }
        : {
            id: `${id}-deps`,
            label: "Every direct dependency is installed",
            class: "passive",
            fs: nodeModulesProbe,
          },
    ],
    link: nodeLink,
    lockfiles,
    lockRegen: (ctx) =>
      id === "pnpm"
        ? "pnpm install --lockfile-only"
        : id === "npm"
          ? "npm install --package-lock-only"
          : id === "yarn"
            ? berry(ctx)
              ? "yarn install --mode=update-lockfile"
              : "yarn install --ignore-scripts"
            : "bun install --lockfile-only",
    cheap: id !== "npm",
    missingSeverity: "blocker",
  }
}

const deno: Recipe = {
  id: "deno",
  tool: () => ({
    exe: "deno",
    versionArgs: ["--version"],
    label: "Deno",
    install: {
      steps: [
        "Install Deno: curl -fsSL https://deno.land/install.sh | sh (or brew install deno).",
      ],
      link: "https://docs.deno.com/runtime/getting_started/installation/",
    },
    managers: { mise: "mise install deno@{version}" },
  }),
  setup: () => [
    { label: "Cache Deno dependencies", command: "deno install", cwd: "" },
  ],
  envPaths: [],
  envState: null,
  probes: () => [],
  lockfiles: ["deno.lock"],
  lockRegen: () => "deno install",
  cheap: true,
  missingSeverity: "warning",
}

// ── Java / Kotlin ───────────────────────────────────────────────────────────

const javaTool = (): ToolSpec => ({
  exe: "java",
  versionArgs: ["-version"],
  label: "Java (JDK)",
  pin: "java",
  install: {
    steps: [
      "Install a JDK (e.g. Temurin) from adoptium.net, or with SDKMAN!: sdk install java <version>-tem.",
    ],
    link: "https://adoptium.net/",
  },
  managers: {
    mise: "mise install java@{version}",
    asdf: "asdf install java {version}",
  },
})

const maven: Recipe = {
  id: "maven",
  tool: (ctx) =>
    has(ctx, "mvnw")
      ? javaTool()
      : {
          exe: "mvn",
          versionArgs: ["--version"],
          label: "Maven",
          install: {
            steps: [
              "Install Maven (brew install maven) or add the Maven wrapper (mvn wrapper:wrapper).",
            ],
            link: "https://maven.apache.org/install.html",
          },
        },
  setup: (ctx) => [
    {
      label: "Download Maven dependencies",
      command: `${has(ctx, "mvnw") ? "./mvnw" : "mvn"} -B -q dependency:go-offline`,
      cwd: "",
    },
  ],
  envPaths: [],
  envState: null,
  probes: (ctx) => [
    {
      id: "maven-offline",
      label: "Maven resolves the build offline",
      class: "executes-project-code",
      command: `${has(ctx, "mvnw") ? "./mvnw" : "mvn"} -B -q -o validate`,
    },
  ],
  lockfiles: [],
  cheap: true,
  heavy: [
    "Maven keeps downloads in ~/.m2, shared by every worktree; each worktree still compiles from scratch.",
  ],
  missingSeverity: "warning",
}

const gradle: Recipe = {
  id: "gradle",
  tool: (ctx) =>
    has(ctx, "gradlew")
      ? javaTool()
      : {
          exe: "gradle",
          versionArgs: ["--version"],
          label: "Gradle",
          install: {
            steps: [
              "Install Gradle (brew install gradle) or add the Gradle wrapper (gradle wrapper).",
            ],
            link: "https://gradle.org/install/",
          },
        },
  setup: (ctx) => [
    {
      label: "Prepare Gradle (wrapper and configuration)",
      command: `${has(ctx, "gradlew") ? "./gradlew" : "gradle"} --quiet help`,
      cwd: "",
    },
  ],
  envPaths: [],
  envState: null,
  probes: (ctx) => [
    {
      id: "gradle-offline",
      label: "Gradle configures offline",
      class: "executes-project-code",
      command: `${has(ctx, "gradlew") ? "./gradlew" : "gradle"} --offline --quiet help`,
    },
  ],
  lockfiles: ["gradle.lockfile"],
  lockRegen: (ctx) =>
    has(ctx, "gradle.lockfile")
      ? `${has(ctx, "gradlew") ? "./gradlew" : "gradle"} dependencies --write-locks`
      : null,
  cheap: true,
  heavy: [
    "Every parallel story starts its own Gradle daemon (often 1–2 GB each). Keep parallel stories modest, or cap org.gradle.jvmargs in gradle.properties.",
    "Enable the Gradle build cache (org.gradle.caching=true) so worktrees reuse each other's outputs.",
  ],
  missingSeverity: "warning",
}

// ── C# ──────────────────────────────────────────────────────────────────────

const dotnet: Recipe = {
  id: "dotnet",
  tool: () => ({
    exe: "dotnet",
    versionArgs: ["--version"],
    label: ".NET SDK",
    pin: "dotnet",
    install: {
      steps: [
        "Install the .NET SDK version in global.json from dotnet.microsoft.com.",
      ],
      link: "https://dotnet.microsoft.com/download",
    },
    managers: {
      mise: "mise install dotnet@{version}",
      asdf: "asdf install dotnet {version}",
    },
  }),
  setup: (ctx) => [
    ...(has(ctx, ".config/dotnet-tools.json")
      ? [
          {
            label: "Restore .NET tools",
            command: "dotnet tool restore",
            cwd: "",
          },
        ]
      : []),
    { label: "Restore NuGet packages", command: "dotnet restore", cwd: "" },
  ],
  envPaths: [],
  envState: (ctx) => {
    const assets = findFiles(ctx.rootAbs, "project.assets.json", 4)
    if (!assets.length)
      return {
        present: false,
        evidence: "No obj/project.assets.json (packages not restored)",
      }
    const newest = Math.min(...assets.map((f) => mtime(f) ?? 0))
    const projects = ctx.root.files.filter((f) =>
      /\.(csproj|fsproj|props)$/.test(f)
    )
    const stale = projects.find(
      (p) => (mtime(abs(ctx, p)) ?? 0) > newest + 1000
    )
    return {
      present: true,
      evidence: `${assets.length} project.assets.json restored`,
      ...(stale ? { staleAgainst: stale } : {}),
    }
  },
  probes: () => [],
  lockfiles: ["packages.lock.json"],
  lockRegen: () => "dotnet restore --force-evaluate",
  cheap: true,
  heavy: [
    "Each worktree builds bin/ and obj/ from scratch; NuGet packages come from the shared global cache.",
  ],
  missingSeverity: "warning",
}

function findFiles(dir: string, name: string, maxDepth: number): string[] {
  const out: string[] = []
  const walk = (current: string, depth: number) => {
    if (depth > maxDepth || out.length > 50) return
    let entries: import("fs").Dirent[] = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.name === name) out.push(full)
    }
  }
  walk(dir, 0)
  return out
}

// ── C / C++ ─────────────────────────────────────────────────────────────────

function cmakeCaches(ctx: RecipeContext): string[] {
  const out: string[] = []
  for (const entry of ctx.ignored) {
    if (entry.class !== "build-output" || !entry.directory) continue
    const cache = path.join(ctx.workspaceAbs, entry.path, "CMakeCache.txt")
    if (existsSync(cache)) out.push(cache)
  }
  return out
}

function cmakePreset(ctx: RecipeContext): string | null {
  for (const file of ["CMakeUserPresets.json", "CMakePresets.json"]) {
    const text = readSmall(abs(ctx, file))
    if (!text) continue
    try {
      const json = JSON.parse(text) as {
        configurePresets?: Array<{ name: string; hidden?: boolean }>
      }
      const preset = json.configurePresets?.find((p) => !p.hidden)
      if (preset) return preset.name
    } catch {
      // not JSON
    }
  }
  return null
}

const cmake: Recipe = {
  id: "cmake",
  tool: () => ({
    exe: "cmake",
    versionArgs: ["--version"],
    label: "CMake",
    pin: "cmake",
    install: {
      steps: [
        "Install CMake (brew install cmake) and a C/C++ compiler (xcode-select --install on macOS).",
      ],
      link: "https://cmake.org/download/",
    },
    managers: { mise: "mise install cmake@{version}" },
  }),
  setup: (ctx) => {
    const preset = cmakePreset(ctx)
    const conan = ctx.root.ecosystems.includes("conan")
    return [
      ...(conan
        ? [
            {
              label: "Install Conan dependencies",
              command: "conan install . --build=missing",
              cwd: "",
            },
          ]
        : []),
      {
        label: "Configure the CMake build",
        command: preset ? `cmake --preset ${preset}` : "cmake -S . -B build",
        cwd: "",
      },
    ]
  },
  envPaths: [],
  envState: (ctx) => {
    const caches = cmakeCaches(ctx)
    if (!caches.length)
      return {
        present: false,
        evidence: "No configured build directory (CMakeCache.txt)",
      }
    for (const cache of caches) {
      const home = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/m.exec(
        readSmall(cache, 2 * 1024 * 1024) ?? ""
      )?.[1]
      if (home && path.resolve(home) !== path.resolve(ctx.rootAbs))
        return {
          present: true,
          evidence: `${path.relative(ctx.workspaceAbs, cache)} was configured for ${home}`,
          staleAgainst: path.relative(ctx.workspaceAbs, cache),
        }
    }
    return {
      present: true,
      evidence: `${path.relative(ctx.workspaceAbs, caches[0])} exists`,
    }
  },
  probes: (ctx) => [
    {
      id: "cmake-cache",
      label: "The CMake build directory belongs to this checkout",
      class: "passive",
      fs: () => {
        const caches = cmakeCaches(ctx)
        for (const cache of caches) {
          const home = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.*)$/m.exec(
            readSmall(cache, 2 * 1024 * 1024) ?? ""
          )?.[1]
          if (home && path.resolve(home) !== path.resolve(ctx.rootAbs))
            return {
              ok: false,
              detail: `${path.relative(ctx.workspaceAbs, cache)} points at ${home}`,
            }
        }
        return caches.length
          ? { ok: true, detail: "Configured for this checkout" }
          : { ok: false, detail: "Not configured" }
      },
    },
  ],
  lockfiles: [],
  cheap: false,
  heavy: [
    "Native builds are heavy per worktree. Install ccache (brew install ccache) and configure with -DCMAKE_CXX_COMPILER_LAUNCHER=ccache so worktrees share compiled objects.",
    "Keep parallel stories modest on large C/C++ builds.",
  ],
  missingSeverity: "warning",
}

const meson: Recipe = {
  id: "meson",
  tool: () => ({
    exe: "meson",
    versionArgs: ["--version"],
    label: "Meson",
    install: {
      steps: [
        "Install Meson and Ninja: brew install meson ninja (or pipx install meson).",
      ],
      link: "https://mesonbuild.com/Getting-meson.html",
    },
  }),
  setup: () => [
    {
      label: "Configure the Meson build",
      command: "meson setup build",
      cwd: "",
    },
  ],
  envPaths: [],
  envState: (ctx) =>
    has(ctx, "build/meson-info") || has(ctx, "builddir/meson-info")
      ? { present: true, evidence: "meson-info exists" }
      : { present: false, evidence: "No configured Meson build directory" },
  probes: () => [],
  lockfiles: [],
  cheap: false,
  heavy: [
    "Native builds are heavy per worktree; ccache helps (meson picks it up automatically when installed).",
  ],
  missingSeverity: "warning",
}

const autotools: Recipe = {
  id: "autotools",
  tool: () => ({
    exe: "autoreconf",
    versionArgs: ["--version"],
    label: "Autotools",
    install: {
      steps: [
        "Install autoconf, automake, and libtool: brew install autoconf automake libtool.",
      ],
    },
  }),
  setup: (ctx) => [
    ...(fileNames(ctx).has("configure")
      ? []
      : [
          {
            label: "Generate the configure script",
            command: "autoreconf -i",
            cwd: "",
          },
        ]),
    { label: "Configure the build", command: "./configure", cwd: "" },
  ],
  envPaths: [],
  envState: (ctx) =>
    has(ctx, "config.status")
      ? { present: true, evidence: "config.status exists" }
      : { present: false, evidence: "Not configured (no config.status)" },
  probes: () => [],
  lockfiles: [],
  cheap: false,
  heavy: [
    "Native builds are heavy per worktree; ccache (CC='ccache cc') helps.",
  ],
  missingSeverity: "warning",
}

const make: Recipe = {
  id: "make",
  tool: () => ({
    exe: "make",
    versionArgs: ["--version"],
    label: "make",
    install: {
      steps: [
        "Install the command-line developer tools: xcode-select --install (macOS) or build-essential (Linux).",
      ],
    },
  }),
  setup: () => [],
  envPaths: [],
  envState: null,
  probes: () => [],
  lockfiles: [],
  cheap: true,
  missingSeverity: "warning",
}

const bazel: Recipe = {
  id: "bazel",
  tool: () => ({
    exe: "bazel",
    versionArgs: ["--version"],
    label: "Bazel (bazelisk)",
    install: {
      steps: ["Install Bazelisk: brew install bazelisk."],
      link: "https://github.com/bazelbuild/bazelisk",
    },
  }),
  setup: () => [],
  envPaths: [],
  envState: null,
  probes: () => [],
  lockfiles: ["MODULE.bazel.lock"],
  lockRegen: () => "bazel mod deps --lockfile_mode=update",
  cheap: true,
  heavy: [
    "Bazel keeps an output base per checkout path, so each worktree starts cold. A shared --disk_cache in ~/.bazelrc lets worktrees reuse outputs.",
  ],
  missingSeverity: "warning",
}

const conan: Recipe = {
  id: "conan",
  tool: () => ({
    exe: "conan",
    versionArgs: ["--version"],
    label: "Conan",
    install: {
      steps: ["Install Conan: pipx install conan."],
      link: "https://docs.conan.io/2/installation.html",
    },
  }),
  setup: (ctx) =>
    ctx.root.ecosystems.includes("cmake")
      ? []
      : [
          {
            label: "Install Conan dependencies",
            command: "conan install . --build=missing",
            cwd: "",
          },
        ],
  envPaths: [],
  envState: null,
  probes: () => [],
  lockfiles: ["conan.lock"],
  lockRegen: () => "conan lock create .",
  cheap: true,
  missingSeverity: "warning",
}

const vcpkg: Recipe = {
  id: "vcpkg",
  tool: () => ({
    exe: "vcpkg",
    versionArgs: ["version"],
    label: "vcpkg",
    install: {
      steps: ["Install vcpkg and set VCPKG_ROOT (see the vcpkg docs)."],
      link: "https://learn.microsoft.com/vcpkg/get_started/get-started",
    },
  }),
  setup: (ctx) =>
    ctx.root.ecosystems.includes("cmake")
      ? []
      : [
          {
            label: "Install vcpkg dependencies",
            command: "vcpkg install",
            cwd: "",
          },
        ],
  envPaths: ["vcpkg_installed"],
  envState: null,
  probes: () => [],
  lockfiles: [],
  cheap: true,
  missingSeverity: "warning",
}

// ── PHP ─────────────────────────────────────────────────────────────────────

const composer: Recipe = {
  id: "composer",
  tool: () => ({
    exe: "composer",
    versionArgs: ["--version"],
    label: "Composer",
    install: {
      steps: ["Install PHP and Composer: brew install php composer."],
      link: "https://getcomposer.org/download/",
    },
  }),
  setup: () => [
    {
      label: "Install PHP dependencies (Composer)",
      command: "composer install --no-interaction",
      cwd: "",
    },
  ],
  envPaths: ["vendor"],
  envState: (ctx) => envAt(ctx, "vendor", "autoload.php", ["composer.lock"]),
  probes: () => [
    {
      id: "composer-validate",
      label: "composer.json and composer.lock agree",
      class: "passive",
      command: "composer validate --no-check-publish --no-interaction",
    },
    {
      id: "composer-platform",
      label: "PHP and its extensions meet the requirements",
      class: "passive",
      command: "composer check-platform-reqs --no-interaction",
    },
  ],
  link: () => ({
    link: false,
    reason:
      "Composer's autoloader resolves classes relative to the checkout it was installed in, so a linked vendor/ would load the main checkout's code.",
    verified: true,
  }),
  lockfiles: ["composer.lock"],
  lockRegen: () => "composer update --lock --no-interaction",
  cheap: true,
  missingSeverity: "blocker",
}

// ── Go ──────────────────────────────────────────────────────────────────────

const go: Recipe = {
  id: "go",
  tool: () => ({
    exe: "go",
    versionArgs: ["version"],
    label: "Go",
    pin: "go",
    install: {
      steps: ["Install Go from go.dev/dl (or brew install go)."],
      link: "https://go.dev/dl/",
    },
    managers: {
      mise: "mise install go@{version}",
      asdf: "asdf install golang {version}",
    },
  }),
  setup: () => [
    { label: "Download Go modules", command: "go mod download", cwd: "" },
  ],
  envPaths: [],
  envState: null,
  probes: () => [
    {
      id: "go-offline",
      label: "Every module is in the module cache",
      class: "passive",
      command: "GOFLAGS=-mod=mod GOPROXY=off go list -m all",
    },
  ],
  lockfiles: ["go.sum"],
  lockRegen: () => "go mod tidy",
  cheap: true,
  missingSeverity: "warning",
}

// ── Rust ────────────────────────────────────────────────────────────────────

const cargo: Recipe = {
  id: "cargo",
  tool: () => ({
    exe: "cargo",
    versionArgs: ["--version"],
    label: "Rust (cargo)",
    pin: "rust",
    install: {
      steps: [
        "Install Rust with rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh.",
      ],
      link: "https://rustup.rs/",
    },
    managers: { rustup: "rustup toolchain install {version}" },
  }),
  setup: () => [
    { label: "Fetch Rust dependencies", command: "cargo fetch", cwd: "" },
  ],
  envPaths: [],
  envState: null,
  probes: () => [
    {
      id: "cargo-offline",
      label: "Every crate is in the registry cache",
      class: "passive",
      command:
        "cargo metadata --locked --offline --format-version 1 --no-deps --quiet >/dev/null && cargo fetch --locked --offline --quiet",
    },
  ],
  lockfiles: ["Cargo.lock"],
  lockRegen: () => "cargo update --workspace",
  cheap: true,
  heavy: [
    "Each worktree compiles target/ from scratch. Install sccache (cargo install sccache) and set RUSTC_WRAPPER=sccache to share compiled crates.",
    "A shared CARGO_TARGET_DIR avoids recompiling but makes parallel builds wait on each other's lock.",
  ],
  missingSeverity: "warning",
}

// ── Swift / Apple ───────────────────────────────────────────────────────────

const swiftpm: Recipe = {
  id: "swiftpm",
  tool: () => ({
    exe: "swift",
    versionArgs: ["--version"],
    label: "Swift",
    pin: "swift",
    install: {
      steps: ["Install Xcode (macOS) or a Swift toolchain from swift.org."],
      link: "https://www.swift.org/install/",
    },
  }),
  setup: () => [
    {
      label: "Resolve Swift packages",
      command: "swift package resolve",
      cwd: "",
    },
  ],
  envPaths: [".build"],
  envState: (ctx) =>
    has(ctx, ".build/workspace-state.json")
      ? envAt(ctx, ".build", "workspace-state.json", ["Package.resolved"])
      : {
          present: false,
          evidence: "No .build/workspace-state.json (packages not resolved)",
        },
  probes: () => [],
  link: () => ({
    link: false,
    reason:
      "SwiftPM's .build holds build products for this checkout; concurrent builds would corrupt a shared copy.",
    verified: true,
  }),
  lockfiles: ["Package.resolved"],
  lockRegen: () => "swift package resolve",
  cheap: true,
  heavy: ["Each worktree compiles .build/ from scratch."],
  missingSeverity: "warning",
}

const cocoapods: Recipe = {
  id: "cocoapods",
  tool: () => ({
    exe: "pod",
    versionArgs: ["--version"],
    label: "CocoaPods",
    install: {
      steps: ["Install CocoaPods: brew install cocoapods."],
      link: "https://guides.cocoapods.org/using/getting-started.html",
    },
  }),
  setup: () => [
    {
      label: "Install CocoaPods dependencies",
      command: "pod install",
      cwd: "",
    },
  ],
  envPaths: ["Pods"],
  envState: (ctx) =>
    has(ctx, "Pods/Manifest.lock")
      ? { present: true, evidence: "Pods/Manifest.lock exists" }
      : { present: false, evidence: "No Pods/ (pods not installed)" },
  probes: () => [
    {
      id: "pods-sync",
      label: "Podfile.lock matches Pods/Manifest.lock",
      class: "passive",
      fs: (ctx) => {
        const lock = readSmall(abs(ctx, "Podfile.lock"))
        const manifest = readSmall(abs(ctx, "Pods/Manifest.lock"))
        if (!manifest) return { ok: false, detail: "No Pods/Manifest.lock" }
        if (!lock) return { ok: true, detail: "No Podfile.lock to compare" }
        return lock === manifest
          ? { ok: true, detail: "Pods match Podfile.lock" }
          : {
              ok: false,
              detail: "The sandbox is not in sync with Podfile.lock",
            }
      },
    },
  ],
  link: () => ({
    link: false,
    reason:
      "Pods/ holds project-relative paths and build settings for this checkout.",
    verified: true,
  }),
  lockfiles: ["Podfile.lock"],
  lockRegen: () => "pod install",
  cheap: false,
  missingSeverity: "blocker",
}

const carthage: Recipe = {
  id: "carthage",
  tool: () => ({
    exe: "carthage",
    versionArgs: ["version"],
    label: "Carthage",
    install: { steps: ["Install Carthage: brew install carthage."] },
  }),
  setup: () => [
    {
      label: "Build Carthage dependencies",
      command: "carthage bootstrap --use-xcframeworks",
      cwd: "",
    },
  ],
  envPaths: ["Carthage"],
  envState: (ctx) =>
    has(ctx, "Carthage/Build")
      ? { present: true, evidence: "Carthage/Build exists" }
      : { present: false, evidence: "No Carthage/Build" },
  probes: () => [],
  link: () => ({
    link: true,
    reason: "Prebuilt Carthage frameworks don't depend on the checkout's path.",
    verified: false,
  }),
  lockfiles: ["Cartfile.resolved"],
  lockRegen: () => "carthage update --no-build",
  cheap: false,
  missingSeverity: "blocker",
}

const xcode: Recipe = {
  id: "xcode",
  tool: () => ({
    exe: "xcodebuild",
    versionArgs: ["-version"],
    label: "Xcode",
    pin: "xcode",
    install: {
      steps: [
        "Install Xcode from the App Store, then run xcode-select -s /Applications/Xcode.app.",
      ],
      link: "https://developer.apple.com/xcode/",
    },
  }),
  setup: () => [],
  envPaths: [],
  envState: null,
  probes: () => [],
  lockfiles: [],
  cheap: true,
  heavy: [
    "Each worktree gets its own DerivedData, so the first build in a worktree is a full build.",
  ],
  missingSeverity: "warning",
}

const tuist: Recipe = {
  id: "tuist",
  tool: () => ({
    exe: "tuist",
    versionArgs: ["version"],
    label: "Tuist",
    install: {
      steps: [
        "Install Tuist: brew install --cask tuist (or mise install tuist).",
      ],
      link: "https://docs.tuist.dev/",
    },
  }),
  setup: (ctx) => [
    ...(has(ctx, "Tuist/Package.swift")
      ? [
          {
            label: "Install Tuist dependencies",
            command: "tuist install",
            cwd: "",
          },
        ]
      : []),
    {
      label: "Generate the Xcode project (Tuist)",
      command: "tuist generate --no-open",
      cwd: "",
    },
  ],
  envPaths: [],
  envState: (ctx) =>
    ctx.ignored.some((e) => /\.(xcodeproj|xcworkspace)$/.test(e.path))
      ? { present: true, evidence: "The generated Xcode project exists" }
      : { present: false, evidence: "The Xcode project hasn't been generated" },
  probes: () => [],
  lockfiles: [],
  cheap: true,
  missingSeverity: "blocker",
}

const xcodegen: Recipe = {
  id: "xcodegen",
  tool: () => ({
    exe: "xcodegen",
    versionArgs: ["--version"],
    label: "XcodeGen",
    install: {
      steps: ["Install XcodeGen: brew install xcodegen."],
      link: "https://github.com/yonaskolb/XcodeGen",
    },
  }),
  setup: () => [
    {
      label: "Generate the Xcode project (XcodeGen)",
      command: "xcodegen generate",
      cwd: "",
    },
  ],
  envPaths: [],
  envState: (ctx) =>
    ctx.ignored.some((e) => /\.xcodeproj$/.test(e.path))
      ? { present: true, evidence: "The generated Xcode project exists" }
      : { present: false, evidence: "The Xcode project hasn't been generated" },
  probes: () => [],
  lockfiles: [],
  cheap: true,
  missingSeverity: "blocker",
}

// ── Ruby ────────────────────────────────────────────────────────────────────

function pathGems(ctx: RecipeContext): boolean {
  return /\bpath:\s*["']|:path\s*=>/.test(readSmall(abs(ctx, "Gemfile")) ?? "")
}

const bundler: Recipe = {
  id: "bundler",
  tool: () => ({
    exe: "bundle",
    versionArgs: ["--version"],
    label: "Ruby (Bundler)",
    pin: "ruby",
    install: {
      steps: [
        "Install Ruby (brew install ruby, or rbenv/mise), then gem install bundler.",
      ],
      link: "https://www.ruby-lang.org/en/documentation/installation/",
    },
    managers: {
      rbenv: "rbenv install -s {version}",
      mise: "mise install ruby@{version}",
      asdf: "asdf install ruby {version}",
    },
  }),
  setup: () => [
    {
      label: "Install Ruby gems (Bundler)",
      command: "bundle install",
      cwd: "",
    },
  ],
  envPaths: ["vendor/bundle", ".bundle"],
  envState: null,
  probes: () => [
    {
      id: "bundle-check",
      label: "Every gem in Gemfile.lock is installed",
      class: "executes-project-code",
      command: "bundle check",
    },
  ],
  link: (ctx, entry) =>
    entry.path.endsWith(".bundle")
      ? {
          link: true,
          reason: "Bundler's local settings apply to every checkout.",
          verified: false,
        }
      : pathGems(ctx)
        ? {
            link: false,
            reason:
              "The Gemfile has path: gems, which resolve relative to the checkout; a linked bundle would load the main checkout's copies.",
            verified: true,
          }
        : {
            link: true,
            reason:
              "No path: gems, so installed gems don't depend on the checkout.",
            verified: false,
          },
  lockfiles: ["Gemfile.lock"],
  lockRegen: () => "bundle lock",
  cheap: true,
  missingSeverity: "blocker",
}

// ── Dart ────────────────────────────────────────────────────────────────────

const pub: Recipe = {
  id: "pub",
  tool: (ctx) =>
    ctx.root.flags.flutter
      ? {
          exe: "flutter",
          versionArgs: ["--version"],
          label: "Flutter",
          pin: "flutter",
          install: {
            steps: [
              "Install Flutter (or FVM: brew tap leoafarias/fvm && brew install fvm).",
            ],
            link: "https://docs.flutter.dev/get-started/install",
          },
          managers: {
            fvm: "fvm install {version}",
            mise: "mise install flutter@{version}",
          },
        }
      : {
          exe: "dart",
          versionArgs: ["--version"],
          label: "Dart",
          pin: "dart",
          install: {
            steps: [
              "Install the Dart SDK: brew tap dart-lang/dart && brew install dart.",
            ],
            link: "https://dart.dev/get-dart",
          },
        },
  setup: (ctx) => [
    {
      label: "Get Dart packages",
      command: ctx.root.flags.flutter ? "flutter pub get" : "dart pub get",
      cwd: "",
    },
  ],
  envPaths: [".dart_tool"],
  envState: (ctx) =>
    envAt(ctx, ".dart_tool", "package_config.json", [
      "pubspec.lock",
      "pubspec.yaml",
    ]),
  probes: () => [],
  link: () => ({
    link: false,
    reason:
      ".dart_tool/package_config.json records package paths for this checkout.",
    verified: true,
  }),
  lockfiles: ["pubspec.lock"],
  lockRegen: (ctx) =>
    ctx.root.flags.flutter ? "flutter pub get" : "dart pub get",
  cheap: true,
  missingSeverity: "blocker",
}

const melos: Recipe = {
  id: "melos",
  tool: () => ({
    exe: "melos",
    versionArgs: ["--version"],
    label: "Melos",
    install: {
      steps: ["Install Melos: dart pub global activate melos."],
      link: "https://melos.invertase.dev/",
    },
  }),
  setup: () => [
    {
      label: "Bootstrap the Dart workspace (Melos)",
      command: "melos bootstrap",
      cwd: "",
    },
  ],
  envPaths: [],
  envState: null,
  probes: () => [],
  lockfiles: [],
  cheap: true,
  missingSeverity: "warning",
}

// ── SQL ─────────────────────────────────────────────────────────────────────

const dbt: Recipe = {
  id: "dbt",
  tool: () => ({
    exe: "dbt",
    versionArgs: ["--version"],
    label: "dbt",
    install: {
      steps: ["Install dbt with your adapter, e.g. pipx install dbt-postgres."],
      link: "https://docs.getdbt.com/docs/core/installation-overview",
    },
  }),
  setup: (ctx) =>
    fileNames(ctx).has("packages.yml") || fileNames(ctx).has("dependencies.yml")
      ? [{ label: "Install dbt packages", command: "dbt deps", cwd: "" }]
      : [],
  envPaths: ["dbt_packages"],
  envState: (ctx) =>
    fileNames(ctx).has("packages.yml") || fileNames(ctx).has("dependencies.yml")
      ? has(ctx, "dbt_packages")
        ? { present: true, evidence: "dbt_packages exists" }
        : { present: false, evidence: "No dbt_packages (dbt deps hasn't run)" }
      : { present: true, evidence: "No dbt packages declared" },
  probes: () => [],
  link: () => ({
    link: false,
    reason: "dbt deps is quick; each worktree gets its own packages.",
    verified: false,
  }),
  lockfiles: ["package-lock.yml"],
  lockRegen: () => "dbt deps",
  cheap: true,
  missingSeverity: "warning",
}

export const RECIPES: Record<EcosystemId, Recipe> = {
  uv,
  poetry,
  pipenv,
  pip,
  conda,
  pnpm: nodeRecipe("pnpm", ["pnpm-lock.yaml"]),
  npm: nodeRecipe("npm", ["package-lock.json", "npm-shrinkwrap.json"]),
  yarn: nodeRecipe("yarn", ["yarn.lock"]),
  bun: nodeRecipe("bun", ["bun.lock", "bun.lockb"]),
  deno,
  maven,
  gradle,
  dotnet,
  cmake,
  meson,
  autotools,
  make,
  bazel,
  conan,
  vcpkg,
  composer,
  go,
  cargo,
  swiftpm,
  cocoapods,
  carthage,
  xcode,
  tuist,
  xcodegen,
  bundler,
  pub,
  melos,
  dbt,
}

// Tools that only exist on macOS.
export const APPLE_ONLY: ReadonlySet<EcosystemId> = new Set([
  "xcode",
  "cocoapods",
  "carthage",
  "tuist",
  "xcodegen",
])
