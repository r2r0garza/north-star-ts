import { execFile } from "child_process"
import { existsSync } from "fs"
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "fs/promises"
import path from "path"
import { promisify } from "util"
import type { WorktreeSetup, WorktreeSetupStep } from "../db/types"
import { runLongCommand } from "./long-command"
import { toolEnv, warmShellPath } from "./workspace-analysis/tool-env"

const execFileAsync = promisify(execFile)

// How a user story or conflict-resolution worktree was prepared, for the
// agents' instructions: so they use what's there instead of searching the
// machine for a test runner (nav-test-8).
export interface WorktreeEnvironment {
  // Workspace-relative paths linked from the main checkout.
  linked: string[]
  // Configured paths the main checkout doesn't have, so nothing was linked.
  missing: string[]
  // Each configured setup step, in order (plan 106.11).
  steps: WorktreeStepResult[]
  // The first failed step's label and why, when one failed.
  error: string | null
}

export interface WorktreeStepResult {
  id: string
  label: string
  command: string
  cwd: string
  // "python-shared-venv" for the built-in shared environment.
  kind?: WorktreeSetupStep["kind"]
  venv?: string
  status: "ok" | "failed" | "skipped"
  exitCode: number | null
  durationMs: number
  // The end of the step's output, for Health and the agent's briefing.
  outputTail: string
  error: string | null
}

export interface StepRunResult {
  exitCode: number | null
  output: string
}

const OUTPUT_TAIL_CHARS = 2000

// A fresh worktree has only tracked files; an ignored environment (.venv,
// node_modules) and anything a setup step builds are missing. Link the
// configured paths from the main checkout, then run the setup steps in order
// in the worktree. Never throws: a failure is reported so the story still
// runs.
export async function prepareWorktreeEnvironment(input: {
  // The workspace in the main checkout, and the same place in the worktree.
  mainWorkspace: string
  worktreeWorkspace: string
  setup: WorktreeSetup
  // Runs one setup step; replaced in tests. Rejects on a non-zero exit.
  run?: (cwd: string, command: string) => Promise<StepRunResult | void>
  // Told which step is about to run, for "Preparing worktree: …".
  onStep?: (label: string) => void
}): Promise<WorktreeEnvironment | null> {
  const { setup } = input
  if (!setup.linkPaths.length && !setup.steps.length) return null
  const linked: string[] = []
  const missing: string[] = []
  for (const relative of setup.linkPaths) {
    const source = path.join(input.mainWorkspace, relative)
    const target = path.join(input.worktreeWorkspace, relative)
    if (!existsSync(source)) {
      missing.push(relative)
      continue
    }
    if (await lstat(target).catch(() => null)) continue
    try {
      await mkdir(path.dirname(target), { recursive: true })
      await symlink(source, target)
      await excludeFromGit(input.worktreeWorkspace, relative)
      linked.push(relative)
    } catch {
      missing.push(relative)
    }
  }
  const steps: WorktreeStepResult[] = []
  let error: string | null = null
  for (const step of setup.steps) {
    const base = {
      id: step.id,
      label: step.label,
      command: step.command,
      cwd: step.cwd,
      ...(step.kind === "python-shared-venv"
        ? { kind: step.kind, venv: step.venv ?? ".venv" }
        : {}),
    }
    if (error) {
      steps.push({
        ...base,
        status: "skipped",
        exitCode: null,
        durationMs: 0,
        outputTail: "",
        error: null,
      })
      continue
    }
    const started = Date.now()
    input.onStep?.(step.label)
    const cwd = path.resolve(input.worktreeWorkspace, step.cwd)
    const inside = path.relative(input.worktreeWorkspace, cwd)
    if (inside.startsWith("..") || path.isAbsolute(inside)) {
      error = `${step.label}: its directory is outside the workspace`
      steps.push({
        ...base,
        status: "failed",
        exitCode: null,
        durationMs: 0,
        outputTail: "",
        error,
      })
      continue
    }
    try {
      const run = input.run ?? runShell
      const result =
        step.kind === "python-shared-venv"
          ? await sharedPythonVenv({
              step,
              mainRoot: path.resolve(input.mainWorkspace, step.cwd),
              worktreeRoot: cwd,
              run,
            })
          : await run(cwd, step.command)
      steps.push({
        ...base,
        status: "ok",
        exitCode: result?.exitCode ?? 0,
        durationMs: Date.now() - started,
        outputTail: tail(result?.output ?? ""),
        error: null,
      })
    } catch (failure) {
      const message = (
        failure instanceof Error ? failure.message : String(failure)
      ).slice(0, 400)
      const detail = failure as {
        code?: unknown
        stdout?: unknown
        stderr?: unknown
      }
      error = `${step.label}: ${message}`
      steps.push({
        ...base,
        status: "failed",
        exitCode: typeof detail?.code === "number" ? detail.code : null,
        durationMs: Date.now() - started,
        outputTail: tail(
          `${typeof detail?.stdout === "string" ? detail.stdout : ""}${typeof detail?.stderr === "string" ? detail.stderr : ""}`
        ),
        error: message,
      })
    }
  }
  return { linked, missing, steps, error }
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS
    ? text.slice(text.length - OUTPUT_TAIL_CHARS)
    : text
}

async function runShell(cwd: string, command: string): Promise<StepRunResult> {
  await warmShellPath()
  // No fixed timeout: an install may take seconds or many minutes. Stopped
  // only when it goes quiet for a long time (see long-command.ts).
  const { stdout, stderr } = await runLongCommand(command, {
    cwd,
    env: toolEnv(),
  })
  return { exitCode: 0, output: `${stdout}${stderr}` }
}

// ── python-shared-venv (plan 106.11) ────────────────────────────────────────

// Files whose differences mean the worktree needs other packages than the
// main checkout's venv has.
const DEPENDENCY_FILES =
  /^(pyproject\.toml|setup\.cfg|setup\.py|requirements[^/]*\.txt|uv\.lock|poetry\.lock|Pipfile(\.lock)?)$/

async function sitePackages(venv: string): Promise<string | null> {
  const lib = path.join(venv, "lib")
  const versions = await readdir(lib).catch(() => [] as string[])
  for (const entry of versions
    .filter((v) => v.startsWith("python"))
    .sort()
    .reverse()) {
    const dir = path.join(lib, entry, "site-packages")
    if (existsSync(dir)) return dir
  }
  const windows = path.join(venv, "Lib", "site-packages")
  return existsSync(windows) ? windows : null
}

async function dependencyFilesDiffer(
  mainRoot: string,
  worktreeRoot: string
): Promise<string[]> {
  const names = new Set([
    ...(await readdir(mainRoot).catch(() => [] as string[])),
    ...(await readdir(worktreeRoot).catch(() => [] as string[])),
  ])
  const changed: string[] = []
  for (const name of names) {
    if (!DEPENDENCY_FILES.test(name)) continue
    const [a, b] = await Promise.all([
      readFile(path.join(mainRoot, name), "utf8").catch(() => null),
      readFile(path.join(worktreeRoot, name), "utf8").catch(() => null),
    ])
    if (a !== b) changed.push(name)
  }
  return changed
}

// [project.scripts] entries, name → "module:function".
function consoleScripts(
  pyproject: string
): Array<{ name: string; target: string }> {
  const block =
    /^\[project\.scripts\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(
      pyproject
    )?.[1] ?? ""
  return [...block.matchAll(/^\s*"?([\w.-]+)"?\s*=\s*"([\w.]+:[\w.]+)"/gm)].map(
    (m) => ({
      name: m[1],
      target: m[2],
    })
  )
}

// Give the worktree a thin venv of its own: created from the main venv's
// Python (so compiled packages match), with the main venv's site-packages on
// its path for every dependency, and the worktree's own source put first.
// The main venv's .pth files (its editable install pointing at the MAIN
// checkout) aren't processed, so imports get the worktree's code. Falls back
// to the full setup when the main checkout has no venv, and installs on top
// when the worktree's dependency files differ from the main checkout's.
async function sharedPythonVenv(input: {
  step: WorktreeSetupStep
  mainRoot: string
  worktreeRoot: string
  run: (cwd: string, command: string) => Promise<StepRunResult | void>
}): Promise<StepRunResult> {
  const { step, mainRoot, worktreeRoot, run } = input
  const venvRel = step.venv || ".venv"
  const mainVenv = path.join(mainRoot, venvRel)
  const worktreeVenv = path.join(worktreeRoot, venvRel)
  const log: string[] = []
  const runAll = async (
    commands: Array<{ label: string; command: string }>
  ) => {
    for (const c of commands) {
      log.push(`$ ${c.command}`)
      const result = await run(worktreeRoot, c.command)
      if (result?.output) log.push(result.output.slice(-1500))
    }
  }
  const mainSite = existsSync(path.join(mainVenv, "pyvenv.cfg"))
    ? await sitePackages(mainVenv)
    : null
  const mainPython = path.join(
    mainVenv,
    process.platform === "win32" ? "Scripts\\python.exe" : "bin/python"
  )
  if (!mainSite || !existsSync(mainPython)) {
    log.push(
      `The main checkout has no usable ${venvRel}; running the full setup.`
    )
    await runAll(step.fallback ?? [])
    return { exitCode: 0, output: log.join("\n") }
  }
  // A link from linkPaths would share the main venv itself: replace it.
  const existing = await lstat(worktreeVenv).catch(() => null)
  if (existing?.isSymbolicLink()) await unlinkQuiet(worktreeVenv)
  if (!existsSync(path.join(worktreeVenv, "pyvenv.cfg"))) {
    await execFileAsync(
      mainPython,
      ["-m", "venv", "--without-pip", worktreeVenv],
      {
        cwd: worktreeRoot,
        env: toolEnv(),
      }
    )
    log.push(`Created ${venvRel} from the main checkout's Python.`)
  }
  const site = await sitePackages(worktreeVenv)
  if (!site)
    throw new Error(`${venvRel} was created without a site-packages directory`)
  const source = existsSync(path.join(worktreeRoot, "src"))
    ? path.join(worktreeRoot, "src")
    : worktreeRoot
  // .pth files are read in name order; the worktree's source goes first.
  await writeFile(
    path.join(site, "00_north_star_worktree_source.pth"),
    `${source}\n`
  )
  await writeFile(
    path.join(site, "zz_north_star_shared_packages.pth"),
    `${mainSite}\n`
  )
  log.push(`Reusing packages from ${mainSite}; project code from ${source}.`)
  // The tools the shared packages installed (pytest, pre-commit, pip, …):
  // copies of the main venv's launchers, pointed at this worktree's Python,
  // so `.venv/bin/pytest` runs here with the worktree's code (nav-test-16:
  // "pytest missing from .venv").
  const mainBin = path.join(
    mainVenv,
    process.platform === "win32" ? "Scripts" : "bin"
  )
  const worktreeBin = path.join(
    worktreeVenv,
    process.platform === "win32" ? "Scripts" : "bin"
  )
  const tools: string[] = []
  for (const name of await readdir(mainBin).catch(() => [] as string[])) {
    if (/^(python|activate|Activate)/.test(name)) continue
    const target = path.join(worktreeBin, name)
    if (existsSync(target)) continue
    const text = await readFile(path.join(mainBin, name), "utf8").catch(
      () => null
    )
    // Only Python launchers: text that runs the main venv's interpreter.
    if (!text || text.length > 64 * 1024 || !text.includes(mainBin)) continue
    await writeFile(target, text.split(mainBin).join(worktreeBin))
    await chmod(target, 0o755)
    tools.push(name)
  }
  if (tools.length) log.push(`Tools: ${tools.sort().join(", ")}`)
  // The project's own commands, run with this worktree's venv and code.
  const pyproject = await readFile(
    path.join(worktreeRoot, "pyproject.toml"),
    "utf8"
  ).catch(() => "")
  const bin = path.join(
    worktreeVenv,
    process.platform === "win32" ? "Scripts" : "bin"
  )
  for (const script of consoleScripts(pyproject)) {
    const [module, fn] = script.target.split(":")
    const file = path.join(bin, script.name)
    await writeFile(
      file,
      `#!${path.join(bin, "python")}\nimport sys\nfrom ${module} import ${fn.split(".")[0]}\nif __name__ == "__main__":\n    sys.exit(${fn}())\n`
    )
    await chmod(file, 0o755)
    log.push(`Command ${script.name} → ${script.target}`)
  }
  // A merged story may have added dependencies the main venv doesn't have.
  const changed = await dependencyFilesDiffer(mainRoot, worktreeRoot)
  if (changed.length && step.refresh?.length) {
    log.push(
      `${changed.join(", ")} differ from the main checkout; installing what's new.`
    )
    await runAll(step.refresh)
  }
  return { exitCode: 0, output: log.join("\n") }
}

async function unlinkQuiet(file: string) {
  await unlink(file).catch(() => {})
}

// Git sees a symlink as a file, so an ignore rule for a directory (".venv/")
// doesn't cover a linked .venv and the worktree's changes would commit it.
// Exclude the link by its exact path in the repository's shared info/exclude.
async function excludeFromGit(
  worktree: string,
  relative: string
): Promise<void> {
  const git = (...args: string[]) =>
    execFileAsync("git", args, { cwd: worktree }).then((r) => r.stdout.trim())
  const [commonDir, prefix] = await Promise.all([
    git("rev-parse", "--path-format=absolute", "--git-common-dir"),
    git("rev-parse", "--show-prefix"),
  ])
  const file = path.join(commonDir, "info", "exclude")
  const entry = `/${path.posix.join(prefix, relative.split(path.sep).join("/"))}`
  const current = await readFile(file, "utf8").catch(() => "")
  if (current.split("\n").includes(entry)) return
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(
    file,
    `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`
  )
}

// The "Environment" lines for an agent's instructions.
export function renderEnvironment(
  env: WorktreeEnvironment | null | undefined
): string[] {
  if (!env) return []
  const lines = ["", "## Environment"]
  if (env.linked.length)
    lines.push(
      `Linked from the repository's main checkout: ${env.linked.map((p) => `\`${p}\``).join(", ")}.`
    )
  // The shared Python environment: say how to use it, so nobody goes
  // looking for another interpreter or reports pytest missing.
  for (const step of env.steps.filter(
    (s) => s.status === "ok" && s.kind === "python-shared-venv"
  )) {
    const venv = path.posix.join(step.cwd || ".", step.venv ?? ".venv")
    lines.push(
      `Python: this worktree has its own \`${venv}\` with the project's dependencies installed and this worktree's code importable. Run tools through it: \`${venv}/bin/python -m pytest\` (or \`${venv}/bin/pytest\`), \`${venv}/bin/python -m <tool>\`.`
    )
  }
  const ran = env.steps.filter(
    (s) => s.status === "ok" && s.kind !== "python-shared-venv"
  )
  if (ran.length)
    lines.push(
      `These setup steps already ran here: ${ran.map((s) => `\`${s.command}\`${s.cwd ? ` (in \`${s.cwd}\`)` : ""}`).join(", ")}.`
    )
  const failed = env.steps.find((s) => s.status === "failed")
  if (failed) {
    const skipped = env.steps.filter((s) => s.status === "skipped")
    lines.push(
      `The workspace's setup step "${failed.label}" (\`${failed.command}\`${failed.cwd ? ` in \`${failed.cwd}\`` : ""}) failed (${failed.error ?? "failed"}).${skipped.length ? ` The steps after it didn't run: ${skipped.map((s) => `\`${s.command}\``).join(", ")}.` : ""} If you can't run the checks, say so in your result instead of installing tools or searching the machine for them.`
    )
  }
  if (env.missing.length)
    lines.push(
      `Not available (the main checkout doesn't have them): ${env.missing.map((p) => `\`${p}\``).join(", ")}.`
    )
  if (!env.error)
    lines.push(
      "Use this environment to run the project's checks; don't search the machine for other interpreters or test runners."
    )
  return lines
}
