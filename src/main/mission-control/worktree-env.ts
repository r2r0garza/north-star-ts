import { exec, execFile } from "child_process"
import { existsSync } from "fs"
import { appendFile, lstat, mkdir, readFile, symlink } from "fs/promises"
import path from "path"
import { promisify } from "util"
import type { WorktreeSetup } from "../db/types"

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

const SETUP_TIMEOUT_MS = 10 * 60_000

// How a user story or conflict-resolution worktree was prepared, for the
// agents' instructions: so they use what's there instead of searching the
// machine for a test runner (nav-test-8).
export interface WorktreeEnvironment {
  // Workspace-relative paths linked from the main checkout.
  linked: string[]
  // Configured paths the main checkout doesn't have, so nothing was linked.
  missing: string[]
  // The setup command, when one ran.
  command: string | null
  // Why the setup command failed, when it did.
  error: string | null
}

// A fresh worktree has only tracked files; an ignored environment (.venv,
// node_modules) and anything a setup step builds are missing. Link the
// configured paths from the main checkout, then run the setup command in the
// worktree. Never throws: a failure is reported so the story still runs.
export async function prepareWorktreeEnvironment(input: {
  // The workspace in the main checkout, and the same place in the worktree.
  mainWorkspace: string
  worktreeWorkspace: string
  setup: WorktreeSetup
  // Runs the setup command; replaced in tests.
  run?: (cwd: string, command: string) => Promise<void>
}): Promise<WorktreeEnvironment | null> {
  const { setup } = input
  if (!setup.linkPaths.length && !setup.command) return null
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
  let error: string | null = null
  if (setup.command) {
    try {
      await (input.run ?? runShell)(input.worktreeWorkspace, setup.command)
    } catch (failure) {
      error = (
        failure instanceof Error ? failure.message : String(failure)
      ).slice(0, 400)
    }
  }
  return { linked, missing, command: setup.command || null, error }
}

async function runShell(cwd: string, command: string): Promise<void> {
  await execAsync(command, {
    cwd,
    timeout: SETUP_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  })
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
  if (env.command)
    lines.push(
      env.error
        ? `The workspace's setup command \`${env.command}\` failed (${env.error}). If you can't run the checks, say so in your result instead of installing tools or searching the machine for them.`
        : `The workspace's setup command \`${env.command}\` has already run here.`
    )
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
