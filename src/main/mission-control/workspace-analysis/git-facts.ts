import { realpath } from "fs/promises"
import path from "path"
import { git } from "./exec"

// Stage 1 (plan 106.11): what Git says about the selected workspace. Uses
// `git rev-parse`, not the presence of `.git`: a linked worktree has a `.git`
// file, and a workspace may be a subfolder of its repository.

export interface GitFacts {
  isRepo: boolean
  // Absolute repository root, when a repository.
  root: string | null
  // The workspace's place in the repository ("" at the root).
  subpath: string
  // The workspace is itself a linked worktree (its git dir isn't the common one).
  linkedWorktree: boolean
  branch: string | null
  unborn: boolean
  // `git status --porcelain` for the workspace, capped.
  dirty: string[]
  dirtyCount: number
  hasRemote: boolean
  // Existing Mission Control branches (mc/…), for collision checks.
  mcBranches: string[]
  // Why Git couldn't be used, when it's installed but failed.
  error: string | null
  gitMissing: boolean
}

const DIRTY_SAMPLE = 20

export async function gitFacts(workspace: string): Promise<GitFacts> {
  const base: GitFacts = {
    isRepo: false,
    root: null,
    subpath: "",
    linkedWorktree: false,
    branch: null,
    unborn: false,
    dirty: [],
    dirtyCount: 0,
    hasRemote: false,
    mcBranches: [],
    error: null,
    gitMissing: false,
  }
  const inside = await git(workspace, ["rev-parse", "--is-inside-work-tree"])
  if (inside.missing) return { ...base, gitMissing: true }
  if (!inside.ok || inside.stdout.trim() !== "true") return base
  const top = await git(workspace, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ])
  if (!top.ok)
    return { ...base, error: top.stderr.trim() || "git rev-parse failed" }
  const [root, gitDir, commonDir] = top.stdout.trim().split("\n")
  const [realRoot, realWorkspace] = await Promise.all([
    realpath(root).catch(() => root),
    realpath(workspace).catch(() => workspace),
  ])
  const relative = path.relative(realRoot, realWorkspace)
  const subpath =
    relative.startsWith("..") || path.isAbsolute(relative)
      ? ""
      : relative.split(path.sep).join("/")
  const [head, branch, status, remotes, refs] = await Promise.all([
    git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    git(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    git(workspace, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--",
      ".",
    ]),
    git(workspace, ["remote"]),
    git(workspace, [
      "for-each-ref",
      "--format=%(refname:short)",
      "--count=200",
      "refs/heads/mc/",
    ]),
  ])
  const dirty = status.ok
    ? status.stdout.split("\n").filter((line) => line.trim())
    : []
  return {
    ...base,
    isRepo: true,
    root,
    subpath,
    linkedWorktree:
      !!gitDir &&
      !!commonDir &&
      path.resolve(gitDir) !== path.resolve(commonDir),
    branch: branch.ok ? branch.stdout.trim() || null : null,
    unborn: !head.ok,
    dirty: dirty.slice(0, DIRTY_SAMPLE),
    dirtyCount: dirty.length,
    hasRemote: remotes.ok && remotes.stdout.trim().length > 0,
    mcBranches: refs.ok
      ? refs.stdout.split("\n").filter((line) => line.trim())
      : [],
  }
}

// Files Git knows in the workspace (tracked plus untracked-not-ignored),
// workspace-relative. Null when not a repository.
export async function listProjectFiles(
  workspace: string,
  limit: number
): Promise<{ files: string[]; truncated: boolean } | null> {
  const result = await git(
    workspace,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
    30_000
  )
  if (!result.ok) return null
  const files = [...new Set(result.stdout.split("\0").filter(Boolean))]
  return { files: files.slice(0, limit), truncated: files.length > limit }
}

// Tracked files only, workspace-relative.
export async function listTrackedFiles(
  workspace: string,
  limit: number
): Promise<string[]> {
  const result = await git(workspace, ["ls-files", "-z", "--", "."], 30_000)
  if (!result.ok) return []
  return result.stdout.split("\0").filter(Boolean).slice(0, limit)
}

// What the workspace has that a fresh worktree won't: ignored entries that
// exist, fully-ignored directories collapsed (`--directory`). Workspace-relative;
// directories end with "/".
export async function listIgnoredPresent(
  workspace: string,
  limit = 2000
): Promise<string[]> {
  const result = await git(
    workspace,
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
      "--",
      ".",
    ],
    30_000
  )
  if (!result.ok) return []
  return result.stdout.split("\0").filter(Boolean).slice(0, limit)
}

// Recent commits' changed paths, newest first, workspace-relative (for
// co-change pairing of generated files).
export async function recentChanges(
  workspace: string,
  commits = 200
): Promise<string[][]> {
  const result = await git(
    workspace,
    [
      "log",
      `-n${commits}`,
      "--no-merges",
      "--name-only",
      "--relative",
      "--format=%x1e",
      "--",
      ".",
    ],
    30_000
  )
  if (!result.ok) return []
  return result.stdout
    .split("\x1e")
    .map((chunk) =>
      chunk
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    )
    .filter((files) => files.length)
}
