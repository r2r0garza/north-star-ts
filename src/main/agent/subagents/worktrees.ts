import { execFile } from "child_process"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { promisify } from "util"
import { systemSlug } from "../../config/system-name"
import type { RepositoryLease } from "./repository-lease"

const execFileAsync = promisify(execFile)
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
}

async function git(cwd: string, args: string[], timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
    env: GIT_ENV,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout.trim()
}

export interface WriterWorktree {
  path: string
  branch: string
  baseOid: string
  markerPath: string
}

export interface WriterHandback {
  branch: string
  commits: string[]
  touchedFiles: string[]
  headOid: string
}

export async function preflightWriterRepository(workspace: string): Promise<{
  root: string
  baseOid: string
  status: string
}> {
  const root = await git(workspace, ["rev-parse", "--show-toplevel"])
  const baseOid = await git(root, ["rev-parse", "HEAD"])
  const status = await git(root, ["status", "--porcelain=v2", "--untracked-files=all"])
  if (status) throw new Error("writer preflight requires a clean repository")
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD"]) {
    try {
      await git(root, ["rev-parse", "--verify", name])
      throw new Error(`writer preflight blocked by ${name}`)
    } catch (error) {
      if (error instanceof Error && error.message.includes("blocked by")) throw error
    }
  }
  return { root, baseOid, status }
}

export async function createWriterWorktree(input: {
  root: string
  baseOid: string
  lease: RepositoryLease
  assignmentId: string
}): Promise<WriterWorktree> {
  const safe = input.assignmentId.replace(/[^a-zA-Z0-9._-]/g, "-")
  const branch = `subagent/${input.lease.sessionId.slice(0, 8)}/${safe}`
  const directory = await mkdtemp(
    path.join(tmpdir(), `${systemSlug()}-subagent-${safe}-`)
  )
  await rm(directory, { recursive: true, force: true })
  await git(input.root, ["worktree", "add", "-b", branch, directory, input.baseOid])
  const markerPath = `${directory}.${systemSlug()}-owner.json`
  await writeFile(
    markerPath,
    JSON.stringify({
      sessionId: input.lease.sessionId,
      repositoryId: input.lease.repositoryId,
      branch,
    }),
    "utf8"
  )
  return { path: directory, branch, baseOid: input.baseOid, markerPath }
}

export async function collectWriterHandback(
  root: string,
  worktree: WriterWorktree
): Promise<WriterHandback> {
  const status = await git(worktree.path, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
  ])
  if (status) throw new Error("writer returned a dirty worktree")
  const commitsText = await git(worktree.path, [
    "rev-list",
    "--reverse",
    `${worktree.baseOid}..HEAD`,
  ])
  const commits = commitsText.split("\n").filter(Boolean)
  if (commits.length === 0) throw new Error("writer returned without a commit")
  const headOid = await git(worktree.path, ["rev-parse", "HEAD"])
  const ancestor = await execFileAsync(
    "git",
    ["merge-base", "--is-ancestor", worktree.baseOid, headOid],
    { cwd: worktree.path, env: GIT_ENV, timeout: 5000 }
  ).then(() => true, () => false)
  if (!ancestor) throw new Error("writer branch does not descend from the captured base")
  const touched = await git(worktree.path, [
    "diff",
    "--name-only",
    `${worktree.baseOid}..${headOid}`,
  ])
  return {
    branch: worktree.branch,
    commits,
    touchedFiles: touched.split("\n").filter(Boolean),
    headOid,
  }
}

export async function removeWriterWorktree(
  root: string,
  worktree: WriterWorktree,
  deleteBranch: boolean
): Promise<void> {
  await git(root, ["worktree", "remove", "--force", worktree.path]).catch(() => {})
  if (deleteBranch) {
    await git(root, ["branch", "-D", worktree.branch]).catch(() => {})
  }
  await rm(worktree.path, { recursive: true, force: true }).catch(() => {})
  await rm(worktree.markerPath, { force: true }).catch(() => {})
}

export interface IntegrationStagingResult {
  status: "prepared" | "conflicted" | "stale" | "failed"
  branch?: string
  paths: string[]
  error?: string
}

export async function stageIntegrationBranch(input: {
  root: string
  baseOid: string
  branches: string[]
  lease: RepositoryLease
}): Promise<IntegrationStagingResult> {
  const head = await git(input.root, ["rev-parse", "HEAD"])
  const status = await git(input.root, [
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
  ])
  if (head !== input.baseOid || status) {
    return {
      status: "stale",
      paths: [],
      error: "parent repository changed after writer preflight",
    }
  }

  const branch = `integration/${input.lease.sessionId}`
  const directory = await mkdtemp(
    path.join(tmpdir(), `${systemSlug()}-integration-`)
  )
  await rm(directory, { recursive: true, force: true })
  let added = false
  let prepared = false
  try {
    await git(input.root, ["worktree", "add", "-b", branch, directory, input.baseOid])
    added = true
    for (const childBranch of input.branches) {
      try {
        await git(directory, ["merge", "--no-ff", "--no-edit", childBranch], 60_000)
      } catch (error) {
        const conflicted = await git(directory, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]).catch(() => "")
        const paths = conflicted.split("\n").filter(Boolean)
        return {
          status: paths.length > 0 ? "conflicted" : "failed",
          paths,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
    prepared = true
    return { status: "prepared", branch, paths: [] }
  } catch (error) {
    return {
      status: "failed",
      paths: [],
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (added) {
      await git(input.root, ["worktree", "remove", "--force", directory]).catch(
        () => {}
      )
    }
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    if (!prepared) await git(input.root, ["branch", "-D", branch]).catch(() => {})
  }
}

export async function mergeability(
  root: string,
  parentHead: string,
  branch: string
): Promise<{ status: "clean" | "conflicted" | "unverified"; paths: string[] }> {
  const version = await git(root, ["version"])
  const match = /git version (\d+)\.(\d+)/.exec(version)
  if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 38)) {
    return { status: "unverified", paths: [] }
  }
  try {
    await git(root, ["merge-tree", "--write-tree", parentHead, branch])
    return { status: "clean", paths: [] }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const paths = [...text.matchAll(/CONFLICT \([^)]*\): .* in (.+)$/gm)].map(
      (match) => match[1]
    )
    return { status: "conflicted", paths }
  }
}
