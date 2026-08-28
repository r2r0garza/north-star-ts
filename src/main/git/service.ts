import { sep } from "path"
import { LocalEnvironment } from "../agent/env/local"
import type { Environment, ExecResult } from "../agent/env/types"
import { truncateUtf8Text } from "../agent/tools/output"
import { resolveInWorkspace } from "../agent/tools/workspace"
import type { GitDiffResult } from "./diff"

const GIT_TIMEOUT_MS = 5_000
const MAX_OUTPUT_BYTES = 512 * 1024
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

const GIT_GLOBAL_ARGS = [
  "-c",
  "color.ui=false",
  "-c",
  "core.pager=cat",
  "-c",
  "credential.helper=",
]

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
      ["status", "--porcelain=v2", "-z", "-b"],
      repo.root
    )
    return {
      isRepo: true,
      root: repo.root,
      branch: repo.branch,
      detached: repo.detached,
      sha: repo.sha,
      entries: parseStatus(res.stdout.toString("utf8")),
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
    return {
      isRepo: true,
      current: repo.branch ?? repo.sha,
      detached: repo.detached,
      branches,
      truncated: !!res.outputTruncated,
    }
  }

  async branchName(): Promise<string | null> {
    const repo = await this.repoInfo()
    if (!repo.isRepo) return null
    return repo.branch ?? repo.sha ?? null
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
    const sha = (await this.git(["rev-parse", "--short=12", "HEAD"], root))
      .stdout.toString("utf8")
      .trim()
    return { isRepo: true, root, detached: true, sha }
  }

  private async git(
    args: string[],
    cwd: string,
    opts: { allowExitCodes?: number[] } = {}
  ): Promise<ExecResult> {
    if (!this.env.execFile) {
      throw new Error("This environment does not support argv execution.")
    }
    const res = await this.env.execFile("git", [...GIT_GLOBAL_ARGS, ...args], {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES * 2,
      env: GIT_ENV,
    })
    const allowed = opts.allowExitCodes ?? [0]
    if (!allowed.includes(res.exitCode ?? -1)) {
      const detail = (res.stderr ?? res.stdout).toString("utf8").trim()
      throw new Error(detail || `git exited with code ${res.exitCode}`)
    }
    return res
  }

  private validatePath(path: string): string {
    if (!path || path.includes("\0")) throw new Error("Invalid path.")
    if (path.startsWith("-")) throw new Error("Paths may not start with '-'.")
    const resolved = resolveInWorkspace(this.workspace, path)
    const rel =
      resolved === this.workspace ? "" : resolved.slice(this.workspace.length + 1)
    return rel.split(sep).join("/")
  }
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
