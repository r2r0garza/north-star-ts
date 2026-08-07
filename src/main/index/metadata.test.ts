import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { readGitBranch } from "./metadata"

// Exercises readGitBranch against real git repos, since the whole point of the
// git-CLI path is to be correct for cases a naive .git/HEAD read gets wrong
// (worktrees, subdirectories). Skips cleanly if git isn't on PATH.
let gitAvailable = true
try {
  execFileSync("git", ["--version"], { stdio: "ignore" })
} catch {
  gitAvailable = false
}

describe.skipIf(!gitAvailable)("readGitBranch", () => {
  let repo: string
  let notRepo: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "branch-repo-"))
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, stdio: "ignore" })
    git("init", "-b", "main")
    git("config", "user.email", "t@t.test")
    git("config", "user.name", "Test")
    writeFileSync(join(repo, "f.txt"), "x\n")
    git("add", ".")
    git("commit", "-m", "init")
    git("checkout", "-b", "feat/backend-test-suite")
    notRepo = mkdtempSync(join(tmpdir(), "branch-plain-"))
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(notRepo, { recursive: true, force: true })
  })

  it("returns null when the folder is not a git repo", async () => {
    expect(await readGitBranch(notRepo)).toBeNull()
  })

  it("reads the current branch (including slashes)", async () => {
    const res = await readGitBranch(repo)
    expect((res?.value as { branch?: string })?.branch).toBe(
      "feat/backend-test-suite"
    )
  })

  it("reads the branch from a SUBDIRECTORY of the repo", async () => {
    const sub = join(repo, "src", "nested")
    mkdirSync(sub, { recursive: true })
    // A naive `<sub>/.git/HEAD` read would fail here; the git CLI resolves it.
    const res = await readGitBranch(sub)
    expect((res?.value as { branch?: string })?.branch).toBe(
      "feat/backend-test-suite"
    )
  })

  it("reads the branch inside a linked WORKTREE (.git is a file, not a dir)", async () => {
    const wt = mkdtempSync(join(tmpdir(), "branch-wt-"))
    rmSync(wt, { recursive: true, force: true }) // git worktree add wants a fresh path
    execFileSync("git", ["worktree", "add", "-b", "wt-branch", wt], {
      cwd: repo,
      stdio: "ignore",
    })
    try {
      const res = await readGitBranch(wt)
      expect((res?.value as { branch?: string })?.branch).toBe("wt-branch")
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wt], {
        cwd: repo,
        stdio: "ignore",
      })
    }
  })

  it("reports a detached HEAD as a short sha", async () => {
    const detached = mkdtempSync(join(tmpdir(), "branch-detached-"))
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: detached, stdio: "ignore" })
    git("init", "-b", "main")
    git("config", "user.email", "t@t.test")
    git("config", "user.name", "Test")
    writeFileSync(join(detached, "f.txt"), "x\n")
    git("add", ".")
    git("commit", "-m", "init")
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: detached })
      .toString()
      .trim()
    git("checkout", sha)
    try {
      const res = await readGitBranch(detached)
      const v = res?.value as {
        detached?: boolean
        sha?: string
        branch?: string
      }
      expect(v?.branch).toBeUndefined()
      expect(v?.detached).toBe(true)
      expect(sha.startsWith(v?.sha ?? "")).toBe(true)
    } finally {
      rmSync(detached, { recursive: true, force: true })
    }
  })
})
