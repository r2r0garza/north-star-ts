import { sep } from "path"
import { LocalEnvironment } from "../agent/env/local"
import type { Environment, ExecResult } from "../agent/env/types"
import { truncateUtf8Text } from "../agent/tools/output"
import { resolveInWorkspace } from "../agent/tools/workspace"
import type { GitDiffResult } from "./diff"

const GIT_TIMEOUT_MS = 5_000
const GIT_NETWORK_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 512 * 1024
const MAX_COMMIT_MESSAGE_LENGTH = 10_000
const MAX_BRANCH_NAME_LENGTH = 255
const MAX_BRANCHES = 200

const repositoryOperations = new Map<string, Promise<void>>()
const DEFAULT_LOG_LIMIT = 20
const MAX_LOG_LIMIT = 100

const GIT_ENV = {
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "true",
  SSH_ASKPASS: "true",
  GIT_OPTIONAL_LOCKS: "0",
}

const GIT_GLOBAL_ARGS = ["-c", "color.ui=false", "-c", "core.pager=cat"]
const GIT_READ_ONLY_ARGS = ["-c", "credential.helper="]

export interface GitStatusEntry {
  path: string
  index: string
  worktree: string
  kind: "ordinary" | "renamed" | "unmerged" | "untracked" | "ignored"
  originalPath?: string
}

export interface GitStatusResult {
  isRepo: boolean
  root?: string
  branch?: string
  detached?: boolean
  sha?: string
  upstream?: string
  ahead?: number
  behind?: number
  entries: GitStatusEntry[]
  truncated: boolean
}

export interface GitDiffStructuredResult extends GitDiffResult {
  isRepo: boolean
  staged: boolean
  path?: string
  base?: string
}

export interface GitLogEntry {
  sha: string
  author: string
  authorDate: string
  subject: string
}

export interface GitLogResult {
  isRepo: boolean
  entries: GitLogEntry[]
  truncated: boolean
}

export interface GitShowResult {
  isRepo: boolean
  revision: string
  path?: string
  text: string
  truncated: boolean
}

export interface GitBranchEntry {
  name: string
  current: boolean
  upstream?: string
}

export interface GitBranchesResult {
  isRepo: boolean
  current?: string
  detached?: boolean
  branches: GitBranchEntry[]
  truncated: boolean
}

export type GitAction = "fetch" | "pull" | "push"

export type GitActionResult =
  | { ok: true; action: GitAction; summary: string }
  | { ok: false; action: GitAction; error: string }

export type GitCommitResult =
  | { ok: true; sha: string; subject: string }
  | { ok: false; error: string }

export type GitBranchActionResult =
  | { ok: true; branch: string }
  | { ok: false; error: string }

export const GIT_COMMIT_MESSAGE_MAX_LENGTH = MAX_COMMIT_MESSAGE_LENGTH
export const GIT_BRANCH_NAME_MAX_LENGTH = MAX_BRANCH_NAME_LENGTH

type RepoInfo =
  | { isRepo: false }
  | {
      isRepo: true
      root: string
      branch?: string
      detached?: boolean
      sha?: string
    }

export class GitService {
  constructor(
    private readonly workspace: string,
    private readonly env: Environment = new LocalEnvironment(workspace)
  ) {}

  async status(): Promise<GitStatusResult> {
    const repo = await this.repoInfo()
    if (!repo.isRepo) return { isRepo: false, entries: [], truncated: false }
    const res = await this.git(
      ["status", "--porcelain=v2", "-z", "-b", "--untracked-files=all"],
      repo.root
    )
    const text = res.stdout.toString("utf8")
    return {
      isRepo: true,
      root: repo.root,
      branch: repo.branch,
      detached: repo.detached,
      sha: repo.sha,
      ...parseBranchTracking(text),
      entries: parseStatus(text),
      truncated: !!res.outputTruncated,
    }
  }

  async diff(
    opts: { path?: string; staged?: boolean; base?: string } = {}
  ): Promise<GitDiffStructuredResult> {
    const repo = await this.repoInfo()
    const staged = opts.staged === true
    if (!repo.isRepo) {
      return {
        isRepo: false,
        diff: "",
        untracked: false,
        truncated: false,
        staged,
      }
    }
    const path = opts.path ? this.validatePath(opts.path) : undefined
    const base = opts.base ? validateRevision(opts.base) : undefined
    const res = await this.git(
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        ...(staged ? ["--cached"] : []),
        ...(base ? [base] : []),
        "--",
        ...(path ? [path] : []),
      ],
      repo.root
    )
    const clipped = truncateUtf8Text(
      res.stdout.toString("utf8"),
      MAX_OUTPUT_BYTES
    )
    return {
      isRepo: true,
      diff: clipped.text,
      untracked: false,
      truncated: clipped.truncated || !!res.outputTruncated,
      staged,
      path,
      base,
    }
  }

  async diffFile(path: string): Promise<GitDiffResult | null> {
    const repo = await this.repoInfo()
    if (!repo.isRepo) return null
    const rel = this.validatePath(path)
    const tracked = await this.git(["ls-files", "--", rel], repo.root)
    if (tracked.stdout.toString("utf8").trim()) {
      const res = await this.git(
        ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", rel],
        repo.root
      )
      const clipped = truncateUtf8Text(
        res.stdout.toString("utf8"),
        MAX_OUTPUT_BYTES
      )
      return {
        diff: clipped.text,
        untracked: false,
        truncated: clipped.truncated || !!res.outputTruncated,
      }
    }
    const res = await this.git(
      ["diff", "--no-index", "--no-color", "--", "/dev/null", rel],
      repo.root,
      { allowExitCodes: [0, 1] }
    )
    const clipped = truncateUtf8Text(
      res.stdout.toString("utf8"),
      MAX_OUTPUT_BYTES
    )
    return {
      diff: clipped.text,
      untracked: true,
      truncated: clipped.truncated || !!res.outputTruncated,
    }
  }

  async log(
    opts: { limit?: number; path?: string } = {}
  ): Promise<GitLogResult> {
    const repo = await this.repoInfo()
    if (!repo.isRepo) return { isRepo: false, entries: [], truncated: false }
    const limit = boundedLimit(opts.limit)
    const path = opts.path ? this.validatePath(opts.path) : undefined
    const res = await this.git(
      [
        "log",
        `-${limit + 1}`,
        "--date=iso-strict",
        "--format=%H%x1f%an <%ae>%x1f%aI%x1f%s%x1e",
        "--",
        ...(path ? [path] : []),
      ],
      repo.root
    )
    const entries = res.stdout
      .toString("utf8")
      .split("\x1e")
      .map((row) => row.trim())
      .filter(Boolean)
      .map((row) => {
        const [sha = "", author = "", authorDate = "", subject = ""] =
          row.split("\x1f")
        return { sha, author, authorDate, subject }
      })
    return {
      isRepo: true,
      entries: entries.slice(0, limit),
      truncated: entries.length > limit || !!res.outputTruncated,
    }
  }

  async show(revision: string, path?: string): Promise<GitShowResult> {
    const rev = validateRevision(revision)
    const repo = await this.repoInfo()
    if (!repo.isRepo) {
      return {
        isRepo: false,
        revision: rev,
        path,
        text: "",
        truncated: false,
      }
    }
    const rel = path ? this.validatePath(path) : undefined
    const res = await this.git(
      [
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--format=fuller",
        rev,
        "--",
        ...(rel ? [rel] : []),
      ],
      repo.root
    )
    const clipped = truncateUtf8Text(
      res.stdout.toString("utf8"),
      MAX_OUTPUT_BYTES
    )
    return {
      isRepo: true,
      revision: rev,
      path: rel,
      text: clipped.text,
      truncated: clipped.truncated || !!res.outputTruncated,
    }
  }

  async branches(): Promise<GitBranchesResult> {
    const repo = await this.repoInfo()
    if (!repo.isRepo) return { isRepo: false, branches: [], truncated: false }
    const res = await this.git(
      [
        "for-each-ref",
        `--count=${MAX_BRANCHES + 1}`,
        "--format=%(refname:short)\t%(upstream:short)",
        "refs/heads",
      ],
      repo.root
    )
    const branches = res.stdout
      .toString("utf8")
      .split("\n")
      .map((row) => row.replace(/\n$/, ""))
      .filter(Boolean)
      .map((row) => {
        const [name = "", upstream = ""] = row.split("\t")
        return {
          name,
          current: name === repo.branch,
          ...(upstream ? { upstream } : {}),
        }
      })
    if (
      repo.branch &&
      !branches.some((branch) => branch.name === repo.branch)
    ) {
      branches.push({ name: repo.branch, current: true })
    }
    branches.sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1
      return (
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.name.localeCompare(b.name)
      )
    })
    return {
      isRepo: true,
      current: repo.branch ?? repo.sha,
      detached: repo.detached,
      branches: branches.slice(0, MAX_BRANCHES),
      truncated: branches.length > MAX_BRANCHES || !!res.outputTruncated,
    }
  }

  async branchName(): Promise<string | null> {
    const repo = await this.repoInfo()
    if (!repo.isRepo) return null
    return repo.branch ?? repo.sha ?? null
  }

  async switchBranch(name: string): Promise<GitBranchActionResult> {
    return this.runBranchOperation(async (repo, branch) => {
      if (!(await this.localBranchExists(repo.root, branch))) {
        throw new Error(`Local branch '${branch}' does not exist.`)
      }
      await this.git(["switch", "--", branch], repo.root)
      return branch
    }, name)
  }

  async createBranch(name: string): Promise<GitBranchActionResult> {
    return this.runBranchOperation(async (repo, branch) => {
      if (await this.localBranchExists(repo.root, branch)) {
        throw new Error(`Local branch '${branch}' already exists.`)
      }
      await this.git(["switch", "-c", branch], repo.root)
      return branch
    }, name)
  }

  async fetch(): Promise<GitActionResult> {
    return this.runAction("fetch", async (repo) => {
      await this.git(["fetch", "--prune"], repo.root, { network: true })
      return "Fetched configured remote."
    })
  }

  async pull(): Promise<GitActionResult> {
    return this.runAction("pull", async (repo) => {
      const branch = this.requireAttachedBranch(repo)
      await this.requireUpstream(repo.root, branch)
      await this.git(["pull", "--ff-only"], repo.root, { network: true })
      return "Fast-forwarded current branch."
    })
  }

  async push(): Promise<GitActionResult> {
    return this.runAction("push", async (repo) => {
      const branch = this.requireAttachedBranch(repo)
      if (await this.hasUpstream(repo.root)) {
        await this.git(["push"], repo.root, { network: true })
        return "Pushed current branch."
      }

      const remote = await this.resolvePushRemote(repo.root, branch)
      await this.git(["push", "--set-upstream", remote, branch], repo.root, {
        network: true,
      })
      return `Pushed current branch and set its upstream to ${remote}/${branch}.`
    })
  }

  async commitSelected(
    paths: string[],
    message: string
  ): Promise<GitCommitResult> {
    const repo = await this.repoInfo()
    if (!repo.isRepo)
      return { ok: false, error: "This folder is not a Git repository." }
    return this.withRepositoryOperation(repo.root, async () => {
      try {
        const commitMessage = validateCommitMessage(message)
        const selected = await this.validateSelectedPaths(repo.root, paths)
        if (selected.paths.length === 0) {
          return {
            ok: false,
            error: "Select at least one changed file to commit.",
          }
        }
        // `commit --only <path>` writes complete working-tree snapshots but needs
        // intent-to-add entries for previously untracked paths. It does not stage
        // their contents, and a failed commit removes only the entries we added.
        if (selected.untracked.length > 0) {
          await this.git(["add", "-N", "--", ...selected.untracked], repo.root)
        }
        try {
          await this.git(
            ["commit", "--only", "-m", commitMessage, "--", ...selected.paths],
            repo.root,
            { timeoutMs: GIT_NETWORK_TIMEOUT_MS }
          )
        } catch (err) {
          if (selected.untracked.length > 0) {
            await this.git(
              ["reset", "-q", "--", ...selected.untracked],
              repo.root,
              {
                allowExitCodes: [0, 1],
              }
            )
          }
          throw err
        }
        const head = await this.git(
          ["log", "-1", "--format=%h%x1f%s"],
          repo.root
        )
        const [sha = "", subject = ""] = head.stdout
          .toString("utf8")
          .trim()
          .split("\x1f", 2)
        return { ok: true, sha, subject }
      } catch (err) {
        return { ok: false, error: sanitizeGitError(err) }
      }
    })
  }

  private async runBranchOperation(
    operation: (
      repo: Extract<RepoInfo, { isRepo: true }>,
      branch: string
    ) => Promise<string>,
    name: string
  ): Promise<GitBranchActionResult> {
    let repo: RepoInfo
    try {
      repo = await this.repoInfo()
    } catch (err) {
      return { ok: false, error: sanitizeGitError(err) }
    }
    if (!repo.isRepo)
      return { ok: false, error: "This folder is not a Git repository." }
    return this.withRepositoryOperation(repo.root, async () => {
      try {
        const freshRepo = await this.repoInfo()
        if (!freshRepo.isRepo || freshRepo.root !== repo.root) {
          throw new Error("Repository state changed.")
        }
        const branch = await this.validateBranchName(freshRepo.root, name)
        const expected = await operation(freshRepo, branch)
        const result = await this.repoInfo()
        if (
          !result.isRepo ||
          result.root !== freshRepo.root ||
          result.detached ||
          result.branch !== expected
        ) {
          throw new Error(
            "Git changed HEAD but did not attach the requested branch."
          )
        }
        return { ok: true, branch: result.branch }
      } catch (err) {
        return { ok: false, error: sanitizeGitError(err) }
      }
    })
  }

  private async validateBranchName(
    root: string,
    value: string
  ): Promise<string> {
    if (typeof value !== "string") throw new Error("Enter a branch name.")
    const branch = value.trim()
    if (!branch) throw new Error("Enter a branch name.")
    if (branch.length > MAX_BRANCH_NAME_LENGTH) {
      throw new Error(
        `Branch names must be at most ${MAX_BRANCH_NAME_LENGTH} characters.`
      )
    }
    if (
      branch.startsWith("-") ||
      branch.startsWith("refs/") ||
      /[\0-\x1f\x7f]/.test(branch)
    ) {
      throw new Error("Invalid branch name.")
    }
    const result = await this.git(
      ["check-ref-format", "--branch", branch],
      root,
      { allowExitCodes: [0, 128] }
    )
    if (result.exitCode !== 0) throw new Error("Invalid branch name.")
    return branch
  }

  private async localBranchExists(
    root: string,
    branch: string
  ): Promise<boolean> {
    const result = await this.git(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      root,
      { allowExitCodes: [0, 1] }
    )
    return result.exitCode === 0
  }

  private async runAction(
    action: GitAction,
    operation: (repo: Extract<RepoInfo, { isRepo: true }>) => Promise<string>
  ): Promise<GitActionResult> {
    const repo = await this.repoInfo()
    if (!repo.isRepo) {
      return {
        ok: false,
        action,
        error: "This folder is not a Git repository.",
      }
    }
    return this.withRepositoryOperation(repo.root, async () => {
      try {
        return { ok: true, action, summary: await operation(repo) }
      } catch (err) {
        return { ok: false, action, error: sanitizeGitError(err) }
      }
    })
  }

  private requireAttachedBranch(
    repo: Extract<RepoInfo, { isRepo: true }>
  ): string {
    if (!repo.branch || repo.detached) {
      throw new Error("Cannot use this action while HEAD is detached.")
    }
    return repo.branch
  }

  private async requireUpstream(root: string, branch: string): Promise<void> {
    if (!(await this.hasUpstream(root))) {
      throw new Error(`Branch '${branch}' has no configured upstream.`)
    }
  }

  private async hasUpstream(root: string): Promise<boolean> {
    const upstream = await this.git(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      root,
      { allowExitCodes: [0, 128] }
    )
    return upstream.exitCode === 0 && !!upstream.stdout.toString("utf8").trim()
  }

  private async resolvePushRemote(
    root: string,
    branch: string
  ): Promise<string> {
    for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault"]) {
      const configured = await this.git(["config", "--get", key], root, {
        allowExitCodes: [0, 1],
      })
      const remote = configured.stdout.toString("utf8").trim()
      if (remote) return remote
    }

    const remotes = (await this.git(["remote"], root)).stdout
      .toString("utf8")
      .split("\n")
      .map((remote) => remote.trim())
      .filter(Boolean)
    if (remotes.includes("origin")) return "origin"
    if (remotes.length === 1) return remotes[0]
    if (remotes.length === 0) {
      throw new Error("This repository has no configured remote to push to.")
    }
    throw new Error(
      `Branch '${branch}' has no configured upstream. Configure a push remote or upstream before pushing.`
    )
  }

  private async validateSelectedPaths(
    root: string,
    paths: string[]
  ): Promise<{ paths: string[]; untracked: string[] }> {
    if (!Array.isArray(paths)) throw new Error("Invalid selected paths.")
    const status = await this.status()
    if (!status.isRepo || status.root !== root)
      throw new Error("Repository state changed.")
    const byPath = new Map(status.entries.map((entry) => [entry.path, entry]))
    const selected: string[] = []
    const untracked: string[] = []
    const seen = new Set<string>()
    for (const rawPath of paths) {
      if (typeof rawPath !== "string") throw new Error("Invalid selected path.")
      const path = this.validatePathInRoot(root, rawPath)
      if (seen.has(path)) continue
      const entry = byPath.get(path)
      if (!entry || entry.kind === "ignored") {
        throw new Error(`Path is not a changed file: ${path}`)
      }
      if (entry.kind === "unmerged") {
        throw new Error(`Resolve conflicts in ${path} before committing.`)
      }
      selected.push(path)
      if (entry.kind === "untracked") untracked.push(path)
      seen.add(path)
    }
    return { paths: selected, untracked }
  }

  private async withRepositoryOperation<T>(
    root: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = repositoryOperations.get(root) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => current)
    repositoryOperations.set(root, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (repositoryOperations.get(root) === queued)
        repositoryOperations.delete(root)
    }
  }

  private async repoInfo(): Promise<RepoInfo> {
    const inside = await this.git(
      ["rev-parse", "--is-inside-work-tree"],
      this.workspace,
      { allowExitCodes: [0, 128] }
    )
    if (
      inside.exitCode !== 0 ||
      inside.stdout.toString("utf8").trim() !== "true"
    ) {
      return { isRepo: false }
    }
    const root = (
      await this.git(["rev-parse", "--show-toplevel"], this.workspace)
    ).stdout
      .toString("utf8")
      .trim()
    const branch = await this.git(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      root,
      { allowExitCodes: [0, 1] }
    )
    if (branch.exitCode === 0) {
      return {
        isRepo: true,
        root,
        branch: branch.stdout.toString("utf8").trim(),
      }
    }
    const sha = (
      await this.git(["rev-parse", "--short=12", "HEAD"], root)
    ).stdout
      .toString("utf8")
      .trim()
    return { isRepo: true, root, detached: true, sha }
  }

  private async git(
    args: string[],
    cwd: string,
    opts: {
      allowExitCodes?: number[]
      network?: boolean
      timeoutMs?: number
    } = {}
  ): Promise<ExecResult> {
    if (!this.env.execFile) {
      throw new Error("This environment does not support argv execution.")
    }
    const res = await this.env.execFile(
      "git",
      [
        ...GIT_GLOBAL_ARGS,
        ...(opts.network ? [] : GIT_READ_ONLY_ARGS),
        ...args,
      ],
      {
        cwd,
        timeoutMs:
          opts.timeoutMs ??
          (opts.network ? GIT_NETWORK_TIMEOUT_MS : GIT_TIMEOUT_MS),
        maxOutputBytes: MAX_OUTPUT_BYTES * 2,
        env: GIT_ENV,
      }
    )
    const allowed = opts.allowExitCodes ?? [0]
    if (!allowed.includes(res.exitCode ?? -1)) {
      const detail = (res.stderr ?? res.stdout).toString("utf8").trim()
      throw new Error(detail || `git exited with code ${res.exitCode}`)
    }
    return res
  }

  private validatePath(path: string): string {
    return this.validatePathInRoot(this.workspace, path)
  }

  private validatePathInRoot(root: string, path: string): string {
    if (!path || path.includes("\0")) throw new Error("Invalid path.")
    if (path.startsWith("-")) throw new Error("Paths may not start with '-'.")
    const resolved = resolveInWorkspace(root, path)
    const rel = resolved === root ? "" : resolved.slice(root.length + 1)
    if (!rel) throw new Error("Invalid path.")
    return rel.split(sep).join("/")
  }
}

function validateCommitMessage(value: string): string {
  if (typeof value !== "string") throw new Error("Enter a commit message.")
  const message = value.trim()
  if (!message) throw new Error("Enter a commit message.")
  if (message.length > MAX_COMMIT_MESSAGE_LENGTH) {
    throw new Error(
      `Commit messages must be at most ${MAX_COMMIT_MESSAGE_LENGTH} characters.`
    )
  }
  return message
}

function sanitizeGitError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const clipped = truncateUtf8Text(message, 16 * 1024).text.trim()
  return clipped || "Git operation failed."
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LOG_LIMIT
  return Math.max(1, Math.min(MAX_LOG_LIMIT, Math.trunc(value!)))
}

function validateRevision(revision: string): string {
  const rev = revision.trim()
  if (!rev || rev.startsWith("-") || rev.includes("\0")) {
    throw new Error("Invalid revision.")
  }
  if (/[\s]/.test(rev) || /^[a-z][a-z0-9+.-]*:\/\//i.test(rev)) {
    throw new Error("Invalid revision.")
  }
  if (!/^[A-Za-z0-9_./@{}^~:+-]+$/.test(rev)) {
    throw new Error("Invalid revision.")
  }
  return rev
}

function parseBranchTracking(
  text: string
): Pick<GitStatusResult, "upstream" | "ahead" | "behind"> {
  let upstream: string | undefined
  let ahead: number | undefined
  let behind: number | undefined
  for (const row of text.split("\0")) {
    if (row.startsWith("# branch.upstream ")) {
      upstream = row.slice("# branch.upstream ".length)
    } else {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(row)
      if (match) {
        ahead = Number(match[1])
        behind = Number(match[2])
      }
    }
  }
  return {
    ...(upstream ? { upstream } : {}),
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
  }
}

function parseStatus(text: string): GitStatusEntry[] {
  const rows = text.split("\0")
  const entries: GitStatusEntry[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.startsWith("#")) continue
    const parts = row.split(" ")
    if (parts[0] === "?") {
      entries.push({
        kind: "untracked",
        path: parts.slice(1).join(" "),
        index: "?",
        worktree: "?",
      })
    } else if (parts[0] === "!") {
      entries.push({
        kind: "ignored",
        path: parts.slice(1).join(" "),
        index: "!",
        worktree: "!",
      })
    } else if (parts[0] === "1") {
      entries.push({
        kind: "ordinary",
        path: parts.slice(8).join(" "),
        index: parts[1]?.[0] ?? ".",
        worktree: parts[1]?.[1] ?? ".",
      })
    } else if (parts[0] === "2") {
      entries.push({
        kind: "renamed",
        path: parts.slice(9).join(" "),
        originalPath: rows[++i],
        index: parts[1]?.[0] ?? ".",
        worktree: parts[1]?.[1] ?? ".",
      })
    } else if (parts[0] === "u") {
      entries.push({
        kind: "unmerged",
        path: parts.slice(10).join(" "),
        index: parts[1]?.[0] ?? "U",
        worktree: parts[1]?.[1] ?? "U",
      })
    }
  }
  return entries
}
