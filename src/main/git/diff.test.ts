import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { gitDiffFile } from "./diff"

// These exercise the real git CLI against a throwaway repo. Skip cleanly if git
// isn't on PATH (e.g. a minimal CI image) rather than failing.
let gitAvailable = true
try {
  execFileSync("git", ["--version"], { stdio: "ignore" })
} catch {
  gitAvailable = false
}

describe.skipIf(!gitAvailable)("gitDiffFile", () => {
  let repo: string
  let notRepo: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "diff-repo-"))
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, stdio: "ignore" })
    git("init")
    git("config", "user.email", "t@t.test")
    git("config", "user.name", "Test")
    writeFileSync(join(repo, "tracked.txt"), "line one\nline two\n")
    git("add", ".")
    git("commit", "-m", "init")
    notRepo = mkdtempSync(join(tmpdir(), "diff-plain-"))
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(notRepo, { recursive: true, force: true })
  })

  it("returns null when the folder is not a git repo", async () => {
    expect(await gitDiffFile(notRepo, "anything.txt")).toBeNull()
  })

  it("returns an empty diff for a tracked, unchanged file", async () => {
    const res = await gitDiffFile(repo, "tracked.txt")
    expect(res).not.toBeNull()
    expect(res!.diff).toBe("")
    expect(res!.untracked).toBe(false)
  })

  it("diffs a modified tracked file", async () => {
    writeFileSync(join(repo, "tracked.txt"), "line one\nCHANGED\n")
    const res = await gitDiffFile(repo, "tracked.txt")
    expect(res!.diff).toContain("-line two")
    expect(res!.diff).toContain("+CHANGED")
    expect(res!.untracked).toBe(false)
  })

  it("synthesizes an all-additions diff for a new untracked file", async () => {
    mkdirSync(join(repo, "src"), { recursive: true })
    writeFileSync(join(repo, "src", "new.ts"), "export const x = 1\n")
    const res = await gitDiffFile(repo, "src/new.ts")
    expect(res).not.toBeNull()
    expect(res!.untracked).toBe(true)
    expect(res!.diff).toContain("+export const x = 1")
  })
})
