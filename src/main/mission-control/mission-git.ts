import { execFile } from "child_process"
import { readFile, realpath } from "fs/promises"
import path from "path"
import { promisify } from "util"
import {
  addWorktree,
  branchCheckout,
  gitSucceeds,
  inProgressOperation,
  isMissionControlBranch,
  preflightWriterRepository,
  removeWorktree,
  runGit,
} from "../agent/subagents/worktrees"

// Git operations for Mission Control integration (plan 106.5). The rules:
//
// - The user's checkout and branches are never touched, except by an approved
//   local landing (landLocally). No reset --hard, clean, force-push, or history
//   rewrite anywhere.
// - Mission Control creates and deletes only its own `mc/…` branches.
// - The integration branch is never checked out. Every merge runs in a
//   throwaway detached worktree and then moves the branch with a
//   compare-and-swap update-ref, so a crash mid-merge leaves the branch either
//   before or after the merge, never half-merged.
//
// Branch layout. Git stores refs as paths, so `mc/i/m` can't be a branch and a
// directory at once; the integration branch is therefore a leaf beside the
// slices directory:
//
//   mc/<initiative>/<mission>/integration
//   mc/<initiative>/<mission>/slices/<slice>-<attempt>

const NETWORK_TIMEOUT_MS = 120_000
const MAX_LISTED_COMMITS = 100
const MAX_LISTED_FILES = 500

export function integrationBranchName(
  initiativeKey: string,
  missionKey: string
): string {
  return `mc/${initiativeKey}/${missionKey}/integration`
}

export function sliceBranchPrefix(integrationBranch: string): string {
  return integrationBranch.replace(/\/integration$/, "/slices/")
}

// The repository root for a workspace, or null when it is not in a git
// repository (Mission Control then keeps slices single-flight).
export async function repositoryRoot(workspace: string): Promise<string | null> {
  return runGit(workspace, ["rev-parse", "--show-toplevel"], { timeout: 10_000 }).then(
    (root) => root || null,
    () => null
  )
}

// Where the workspace sits inside its repository, so a worktree of the same
// repository can offer the matching folder ("" at the root).
export async function workspaceSubpath(
  root: string,
  workspace: string
): Promise<string> {
  const [realRoot, realWorkspace] = await Promise.all([
    realpath(root),
    realpath(workspace),
  ])
  const relative = path.relative(realRoot, realWorkspace)
  return relative.startsWith("..") ? "" : relative
}

export async function revParse(root: string, ref: string): Promise<string | null> {
  return runGit(root, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]).then(
    (oid) => oid || null,
    () => null
  )
}

export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  return gitSucceeds(root, ["merge-base", "--is-ancestor", ancestor, descendant])
}

async function branchOid(root: string, branch: string): Promise<string | null> {
  return revParse(root, `refs/heads/${branch}`)
}

// A committer identity for merge commits when the repository has none
// configured, so a fresh clone without user.name doesn't wedge the queue.
async function identityEnv(cwd: string): Promise<Record<string, string>> {
  const configured = await gitSucceeds(cwd, ["var", "GIT_COMMITTER_IDENT"])
  if (configured) return {}
  return {
    GIT_AUTHOR_NAME: "Mission Control",
    GIT_AUTHOR_EMAIL: "mission-control@localhost",
    GIT_COMMITTER_NAME: "Mission Control",
    GIT_COMMITTER_EMAIL: "mission-control@localhost",
  }
}

async function commitGit(cwd: string, args: string[]): Promise<string> {
  return runGit(cwd, args, { timeout: 120_000, env: await identityEnv(cwd) })
}

async function unmergedPaths(checkout: string): Promise<string[]> {
  const text = await runGit(checkout, ["diff", "--name-only", "--diff-filter=U"]).catch(
    () => ""
  )
  return text.split("\n").filter(Boolean)
}

// Compare-and-swap a Mission Control branch: succeeds only if it still points
// at `expected`.
async function moveBranch(
  root: string,
  branch: string,
  next: string,
  expected: string,
  reason: string
): Promise<boolean> {
  if (!isMissionControlBranch(branch)) throw new Error(`Refusing to move ${branch}`)
  return runGit(root, [
    "update-ref",
    "-m",
    reason,
    `refs/heads/${branch}`,
    next,
    expected,
  ]).then(
    () => true,
    () => false
  )
}

// ── mission start ────────────────────────────────────────────────────────────

export interface MissionStart {
  root: string
  baseRef: string
  baseOid: string
}

// Create the integration branch at the user's current commit. Requires the
// writer preflight: a clean tree and no merge/rebase/cherry-pick in progress.
export async function startIntegrationBranch(input: {
  workspace: string
  branch: string
}): Promise<MissionStart> {
  let root: string
  let baseOid: string
  try {
    ;({ root, baseOid } = await preflightWriterRepository(input.workspace))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("clean repository"))
      throw new Error(
        "Mission Control needs a clean working tree to start a mission. Commit or stash your changes, then run the slice again."
      )
    if (message.includes("blocked by"))
      throw new Error(
        `Finish the ${message.split("blocked by ")[1]?.replace("_HEAD", "").toLowerCase() ?? "git operation"} in progress before starting a mission.`
      )
    throw error
  }
  const baseRef = await runGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(
    () => ""
  )
  if (!baseRef)
    throw new Error(
      "The workspace is on a detached HEAD. Check out the branch the mission should land on, then run the slice again."
    )
  if (!isMissionControlBranch(input.branch))
    throw new Error(`Refusing to create ${input.branch}`)
  await runGit(root, ["check-ref-format", "--branch", input.branch])
  const existing = await branchOid(root, input.branch)
  if (existing && existing !== baseOid)
    throw new Error(
      `The branch ${input.branch} already exists with other commits. Delete or rename it, then run the slice again.`
    )
  // A crash after creating the branch but before recording it leaves the
  // branch at the base commit; adopt it.
  if (!existing) await runGit(root, ["branch", input.branch, baseOid])
  return { root, baseRef, baseOid }
}

// ── slice worktrees ─────────────────────────────────────────────────────────

// A branch name under the mission's slices prefix that doesn't exist yet. A
// leftover from an interrupted launch keeps its work; the new attempt gets a
// suffixed name instead.
async function freeSliceBranch(root: string, base: string): Promise<string> {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    if (!(await branchOid(root, candidate))) return candidate
  }
  throw new Error(`No free branch name for ${base}`)
}

export async function createSliceWorktree(input: {
  root: string
  integrationBranch: string
  sliceKey: string
  attempt: number
  directory: string
}): Promise<{ branch: string; baseOid: string }> {
  const baseOid = await branchOid(input.root, input.integrationBranch)
  if (!baseOid)
    throw new Error(
      `The integration branch ${input.integrationBranch} is missing. It may have been deleted outside Mission Control.`
    )
  const branch = await freeSliceBranch(
    input.root,
    `${sliceBranchPrefix(input.integrationBranch)}${input.sliceKey}-${input.attempt}`
  )
  await addWorktree({
    root: input.root,
    directory: input.directory,
    startPoint: baseOid,
    newBranch: branch,
  })
  return { branch, baseOid }
}

// Commit whatever the slice's workers left uncommitted in its worktree, so
// the branch carries all of the slice's work. Returns the new commit, if any.
export async function commitWorktreeChanges(
  worktree: string,
  message: string
): Promise<string | null> {
  const operation = await inProgressOperation(worktree)
  if (operation)
    throw new Error(
      `The slice worktree has a ${operation.replace("_HEAD", "").toLowerCase()} in progress; finish or abort it first.`
    )
  await runGit(worktree, ["add", "-A"])
  const staged = await gitSucceeds(worktree, ["diff", "--cached", "--quiet"])
  if (staged) return null
  await commitGit(worktree, ["commit", "--no-verify", "-q", "-m", message])
  return runGit(worktree, ["rev-parse", "HEAD"])
}

export async function changedFiles(
  root: string,
  from: string,
  to: string
): Promise<string[]> {
  const text = await runGit(root, ["diff", "--name-only", `${from}..${to}`])
  return text.split("\n").filter(Boolean)
}

// ── the merge ────────────────────────────────────────────────────────────────

export type MergeOutcome =
  | { status: "merged"; mergeCommit: string }
  | { status: "already_merged" }
  | { status: "conflict"; files: string[] }
  // The integration branch moved while we merged; retry from its new head.
  | { status: "moved" }
  // Something outside the queue's control; nothing was changed.
  | { status: "blocked"; reason: string }

async function checkedOutGuard(
  root: string,
  branch: string
): Promise<string | null> {
  const checkout = await branchCheckout(root, branch)
  return checkout
    ? `${branch} is checked out in ${checkout}. Switch that checkout to another branch so Mission Control can keep merging.`
    : null
}

// Merge a slice head into the integration branch: --no-ff in a scratch
// detached worktree, then compare-and-swap the branch. A conflict is aborted
// and the scratch worktree removed, so the repository is exactly as before.
export async function mergeSlice(input: {
  root: string
  integrationBranch: string
  sliceHead: string
  message: string
  scratchDirectory: string
}): Promise<MergeOutcome> {
  const { root, integrationBranch, sliceHead } = input
  const head = await branchOid(root, integrationBranch)
  if (!head)
    return {
      status: "blocked",
      reason: `The integration branch ${integrationBranch} is missing.`,
    }
  if (await isAncestor(root, sliceHead, head)) return { status: "already_merged" }
  const guard = await checkedOutGuard(root, integrationBranch)
  if (guard) return { status: "blocked", reason: guard }

  await addWorktree({ root, directory: input.scratchDirectory, startPoint: head })
  try {
    try {
      await commitGit(input.scratchDirectory, [
        "merge",
        "--no-ff",
        "--no-verify",
        "-m",
        input.message,
        sliceHead,
      ])
    } catch (error) {
      const files = await unmergedPaths(input.scratchDirectory)
      await runGit(input.scratchDirectory, ["merge", "--abort"]).catch(() => {})
      if (files.length) return { status: "conflict", files }
      return {
        status: "blocked",
        reason: `git merge failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    const mergeCommit = await runGit(input.scratchDirectory, ["rev-parse", "HEAD"])
    const moved = await moveBranch(
      root,
      integrationBranch,
      mergeCommit,
      head,
      "mission-control: merge slice"
    )
    return moved ? { status: "merged", mergeCommit } : { status: "moved" }
  } finally {
    await removeWorktree(root, input.scratchDirectory)
  }
}

// The merge commit that brought `sliceHead` into the integration branch, found
// by its trailer (crash recovery: the branch moved but the queue row didn't).
export async function findSliceMerge(
  root: string,
  integrationBranch: string,
  sliceId: string
): Promise<string | null> {
  const text = await runGit(root, [
    "log",
    "--merges",
    "-n",
    "1",
    "--format=%H",
    "--fixed-strings",
    `--grep=Mission-Control-Slice: ${sliceId}`,
    `refs/heads/${integrationBranch}`,
  ]).catch(() => "")
  return text || null
}

// ── conflict resolution ─────────────────────────────────────────────────────

// A worktree at the integration head with the slice merge started and its
// conflict markers in place, for the integrator seat to resolve.
export async function prepareResolution(input: {
  root: string
  integrationBranch: string
  sliceHead: string
  directory: string
}): Promise<{ startOid: string; files: string[] }> {
  const startOid = await branchOid(input.root, input.integrationBranch)
  if (!startOid)
    throw new Error(`The integration branch ${input.integrationBranch} is missing.`)
  await addWorktree({
    root: input.root,
    directory: input.directory,
    startPoint: startOid,
  })
  await commitGit(input.directory, [
    "merge",
    "--no-ff",
    "--no-commit",
    "--no-verify",
    input.sliceHead,
  ]).catch(() => {})
  return { startOid, files: await unmergedPaths(input.directory) }
}

const CONFLICT_MARKER = /^(<{7}|>{7})(?: |$)/m

async function filesWithMarkers(checkout: string, files: string[]): Promise<string[]> {
  const marked: string[] = []
  for (const file of files) {
    const text = await readFile(path.join(checkout, file), "utf8").catch(() => "")
    if (CONFLICT_MARKER.test(text)) marked.push(file)
  }
  return marked
}

export type ResolutionOutcome =
  | { status: "merged"; mergeCommit: string }
  | { status: "unresolved"; files: string[] }
  | { status: "moved" }
  | { status: "invalid"; reason: string }

// Commit an integrator's resolution and move the integration branch to it.
export async function finalizeResolution(input: {
  root: string
  integrationBranch: string
  directory: string
  startOid: string
  sliceHead: string
  conflictFiles: string[]
  message: string
}): Promise<ResolutionOutcome> {
  const { directory } = input
  const marked = await filesWithMarkers(directory, input.conflictFiles)
  if (marked.length) return { status: "unresolved", files: marked }
  const mergeInProgress = (await inProgressOperation(directory)) === "MERGE_HEAD"
  let mergeCommit: string
  if (mergeInProgress) {
    await runGit(directory, ["add", "-A"])
    const unmerged = await unmergedPaths(directory)
    if (unmerged.length) return { status: "unresolved", files: unmerged }
    await commitGit(directory, ["commit", "--no-verify", "-q", "-m", input.message])
    mergeCommit = await runGit(directory, ["rev-parse", "HEAD"])
  } else {
    // The integrator committed the merge itself: accept it only if it is a
    // real merge of this slice on top of the integration head.
    mergeCommit = await runGit(directory, ["rev-parse", "HEAD"])
    const status = await runGit(directory, ["status", "--porcelain"])
    if (
      mergeCommit === input.startOid ||
      status ||
      !(await isAncestor(directory, input.startOid, mergeCommit)) ||
      !(await isAncestor(directory, input.sliceHead, mergeCommit))
    )
      return {
        status: "invalid",
        reason:
          "The resolution worktree no longer holds the slice merge (it was aborted or left uncommitted changes).",
      }
  }
  const guard = await checkedOutGuard(input.root, input.integrationBranch)
  if (guard) return { status: "invalid", reason: guard }
  const moved = await moveBranch(
    input.root,
    input.integrationBranch,
    mergeCommit,
    input.startOid,
    "mission-control: merge resolved slice"
  )
  return moved ? { status: "merged", mergeCommit } : { status: "moved" }
}

// ── landing ─────────────────────────────────────────────────────────────────

export interface LandingSummary {
  base: string
  baseOid: string | null
  head: string
  headOid: string | null
  commitCount: number
  commits: Array<{ oid: string; subject: string; author: string }>
  files: Array<{ status: string; path: string }>
  filesTruncated: boolean
  // The base can move to head without a merge commit.
  fastForward: boolean
  // head is already reachable from base (the mission landed).
  merged: boolean
  baseCheckout: string | null
}

export async function landingSummary(
  root: string,
  base: string,
  integrationBranch: string
): Promise<LandingSummary> {
  const [baseOid, headOid] = await Promise.all([
    branchOid(root, base),
    branchOid(root, integrationBranch),
  ])
  const summary: LandingSummary = {
    base,
    baseOid,
    head: integrationBranch,
    headOid,
    commitCount: 0,
    commits: [],
    files: [],
    filesTruncated: false,
    fastForward: false,
    merged: false,
    baseCheckout: await branchCheckout(root, base).catch(() => null),
  }
  if (!baseOid || !headOid) return summary
  summary.merged = await isAncestor(root, headOid, baseOid)
  summary.fastForward = await isAncestor(root, baseOid, headOid)
  const range = `${baseOid}..${headOid}`
  summary.commitCount = Number(
    await runGit(root, ["rev-list", "--count", range]).catch(() => "0")
  )
  const log = await runGit(root, [
    "log",
    "-n",
    String(MAX_LISTED_COMMITS),
    "--format=%H%x1f%s%x1f%an",
    range,
  ]).catch(() => "")
  summary.commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [oid, subject, author] = line.split("\x1f")
      return { oid, subject, author }
    })
  const diff = await runGit(root, [
    "diff",
    "--name-status",
    "--no-renames",
    `${baseOid}...${headOid}`,
  ]).catch(() => "")
  const files = diff
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t")
      return { status, path: rest.join("\t") }
    })
  summary.filesTruncated = files.length > MAX_LISTED_FILES
  summary.files = files.slice(0, MAX_LISTED_FILES)
  return summary
}

// The approved local merge (policy local_merge): the one operation that
// changes the user's branch. Fast-forward when possible, else a merge commit.
// Where the base is checked out, the merge runs in that checkout, which must
// have no uncommitted changes to tracked files. Never pushes.
export async function landLocally(input: {
  root: string
  base: string
  expectedBaseOid: string
  head: string
  expectedHeadOid: string
  message: string
  scratchDirectory: string
}): Promise<{ mergeCommit: string; fastForward: boolean }> {
  const { root, base } = input
  const baseOid = await branchOid(root, base)
  const headOid = await branchOid(root, input.head)
  if (baseOid !== input.expectedBaseOid)
    throw new Error(
      `${base} moved since you reviewed the merge. Review it again before approving.`
    )
  if (headOid !== input.expectedHeadOid)
    throw new Error(
      `${input.head} moved since you reviewed the merge. Review it again before approving.`
    )
  const fastForward = await isAncestor(root, baseOid, headOid)
  const checkout = await branchCheckout(root, base)
  if (checkout) {
    const dirty = await runGit(checkout, ["status", "--porcelain", "--untracked-files=no"])
    if (dirty)
      throw new Error(
        `${checkout} has uncommitted changes on ${base}. Commit or stash them, then approve again.`
      )
    const operation = await inProgressOperation(checkout)
    if (operation)
      throw new Error(`Finish the git operation in progress in ${checkout} first.`)
    try {
      if (fastForward)
        await runGit(checkout, ["merge", "--ff-only", headOid], { timeout: 120_000 })
      else
        await commitGit(checkout, [
          "merge",
          "--no-ff",
          "--no-verify",
          "-m",
          input.message,
          headOid,
        ])
    } catch (error) {
      if ((await inProgressOperation(checkout)) === "MERGE_HEAD")
        await runGit(checkout, ["merge", "--abort"]).catch(() => {})
      throw new Error(
        `Merging into ${base} failed and was aborted, leaving ${base} unchanged: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    return { mergeCommit: await runGit(checkout, ["rev-parse", "HEAD"]), fastForward }
  }

  let next = headOid
  if (!fastForward) {
    await addWorktree({ root, directory: input.scratchDirectory, startPoint: baseOid })
    try {
      await commitGit(input.scratchDirectory, [
        "merge",
        "--no-ff",
        "--no-verify",
        "-m",
        input.message,
        headOid,
      ]).catch(async (error) => {
        await runGit(input.scratchDirectory, ["merge", "--abort"]).catch(() => {})
        throw new Error(
          `Merging into ${base} conflicts; ${base} is unchanged. Merge it manually or switch the policy to manual: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      next = await runGit(input.scratchDirectory, ["rev-parse", "HEAD"])
    } finally {
      await removeWorktree(root, input.scratchDirectory)
    }
  }
  await runGit(root, [
    "update-ref",
    "-m",
    "mission-control: land mission",
    `refs/heads/${base}`,
    next,
    baseOid,
  ]).catch(() => {
    throw new Error(`${base} moved while landing; nothing was changed. Review again.`)
  })
  return { mergeCommit: next, fastForward }
}

// ── pull requests ───────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile)

export async function pushRemote(root: string, branch: string): Promise<string | null> {
  for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault"]) {
    const value = await runGit(root, ["config", "--get", key]).catch(() => "")
    if (value) return value
  }
  const remotes = (await runGit(root, ["remote"]).catch(() => ""))
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean)
  if (remotes.includes("origin")) return "origin"
  return remotes.length === 1 ? remotes[0] : null
}

let ghCheck: Promise<boolean> | null = null
export function ghAvailable(): Promise<boolean> {
  ghCheck ??= execFileAsync("gh", ["--version"], { timeout: 10_000 }).then(
    () => true,
    () => false
  )
  return ghCheck
}

// Push the integration branch and open a PR with the user's authenticated gh.
export async function openPullRequest(input: {
  root: string
  branch: string
  base: string
  title: string
  body: string
}): Promise<{ url: string; remote: string }> {
  if (!isMissionControlBranch(input.branch)) throw new Error(`Refusing to push ${input.branch}`)
  const remote = await pushRemote(input.root, input.base)
  if (!remote) throw new Error("This repository has no remote to push to.")
  if (!(await ghAvailable()))
    throw new Error("The GitHub CLI (gh) is not installed or not on PATH.")
  await runGit(
    input.root,
    ["push", "--set-upstream", remote, `refs/heads/${input.branch}:refs/heads/${input.branch}`],
    { timeout: NETWORK_TIMEOUT_MS, env: { GIT_ASKPASS: "true", SSH_ASKPASS: "true" } }
  )
  const { stdout } = await execFileAsync(
    "gh",
    [
      "pr",
      "create",
      "--base",
      input.base,
      "--head",
      input.branch,
      "--title",
      input.title,
      "--body",
      input.body,
    ],
    {
      cwd: input.root,
      timeout: NETWORK_TIMEOUT_MS,
      encoding: "utf8",
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 1024 * 1024,
    }
  )
  const url = stdout.trim().split("\n").reverse().find((line) => /^https?:\/\//.test(line))
  if (!url) throw new Error(`gh did not report a pull request URL: ${stdout.trim()}`)
  return { url, remote }
}

// Delete Mission Control branches whose tips are already contained in `into`
// (their work is reachable from it). Returns the deleted names.
export async function deleteMergedBranches(
  root: string,
  branches: string[],
  into: string
): Promise<string[]> {
  const deleted: string[] = []
  for (const branch of new Set(branches)) {
    if (!isMissionControlBranch(branch)) continue
    const oid = await branchOid(root, branch)
    if (!oid) continue
    if (!(await isAncestor(root, oid, into))) continue
    if (await branchCheckout(root, branch)) continue
    if (await runGit(root, ["branch", "-D", branch]).then(() => true, () => false))
      deleted.push(branch)
  }
  return deleted
}

export async function listBranches(root: string, prefix: string): Promise<string[]> {
  const text = await runGit(root, [
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${prefix}`,
  ]).catch(() => "")
  return text.split("\n").filter(Boolean)
}

// A worktree's changes against `base`: tracked edits plus new untracked files
// (as all-additions), without touching its index. Bounded by `limit` bytes.
export async function worktreeDiff(
  worktree: string,
  base: string,
  limit: number
): Promise<{ diff: string; truncated: boolean }> {
  let diff = await runGit(worktree, ["diff", "--no-color", "--no-ext-diff", base])
  const untracked = (
    await runGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]).catch(
      () => ""
    )
  )
    .split("\0")
    .filter(Boolean)
  for (const file of untracked) {
    if (diff.length > limit) break
    const text = await execFileAsync(
      "git",
      ["diff", "--no-index", "--no-color", "--", "/dev/null", file],
      { cwd: worktree, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }
    ).then(
      (result) => result.stdout,
      // Exit status 1 means "there are differences" for --no-index.
      (error: { stdout?: string }) => error.stdout ?? ""
    )
    diff += (diff && !diff.endsWith("\n") ? "\n" : "") + text
  }
  return diff.length > limit
    ? { diff: diff.slice(0, limit), truncated: true }
    : { diff, truncated: false }
}
