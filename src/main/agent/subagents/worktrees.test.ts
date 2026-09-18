import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { repositoryDelegationLeases } from "./repository-lease"
import {
  collectWriterHandback,
  createWriterWorktree,
  preflightWriterRepository,
  removeWriterWorktree,
  stageIntegrationBranch,
} from "./worktrees"

const dirs: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "subagent-wt-"))
  dirs.push(root)
  git(root, "init")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  writeFileSync(path.join(root, "README.md"), "base\n")
  git(root, "add", "README.md")
  git(root, "commit", "-m", "base")
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("writer worktrees", () => {
  it("returns committed work without mutating the parent checkout", async () => {
    const root = repo()
    const before = git(root, "status", "--porcelain")
    const preflight = await preflightWriterRepository(root)
    const lease = await repositoryDelegationLeases.acquire(root, "test")
    const wt = await createWriterWorktree({
      root,
      baseOid: preflight.baseOid,
      lease,
      assignmentId: "writer",
    })
    writeFileSync(path.join(wt.path, "child.txt"), "child\n")
    git(wt.path, "add", "child.txt")
    git(wt.path, "commit", "-m", "child change")
    const handback = await collectWriterHandback(root, wt)
    expect(handback.commits).toHaveLength(1)
    expect(handback.touchedFiles).toEqual(["child.txt"])
    expect(git(root, "status", "--porcelain")).toBe(before)
    await removeWriterWorktree(root, wt, false)
    repositoryDelegationLeases.release(lease)
  })

  it("stages successful branches without changing the parent checkout", async () => {
    const root = repo()
    const preflight = await preflightWriterRepository(root)
    const lease = await repositoryDelegationLeases.acquire(root, "test")
    const branches: string[] = []
    for (const assignmentId of ["one", "two"]) {
      const wt = await createWriterWorktree({
        root,
        baseOid: preflight.baseOid,
        lease,
        assignmentId,
      })
      writeFileSync(path.join(wt.path, `${assignmentId}.txt`), `${assignmentId}\n`)
      git(wt.path, "add", `${assignmentId}.txt`)
      git(wt.path, "commit", "-m", `${assignmentId} change`)
      branches.push(wt.branch)
      await removeWriterWorktree(root, wt, false)
    }

    const parentHead = git(root, "rev-parse", "HEAD")
    const staged = await stageIntegrationBranch({
      root,
      baseOid: preflight.baseOid,
      branches,
      lease,
    })
    expect(staged.status).toBe("prepared")
    expect(staged.branch).toBe(`integration/${lease.sessionId}`)
    expect(git(root, "rev-parse", "HEAD")).toBe(parentHead)
    expect(git(root, "status", "--porcelain")).toBe("")
    expect(git(root, "merge-base", "--is-ancestor", branches[0], staged.branch!)).toBe(
      ""
    )
    expect(git(root, "merge-base", "--is-ancestor", branches[1], staged.branch!)).toBe(
      ""
    )
    git(root, "branch", "-D", staged.branch!)
    for (const branch of branches) git(root, "branch", "-D", branch)
    repositoryDelegationLeases.release(lease)
  })

  it("rejects dirty and no-commit handbacks", async () => {
    const root = repo()
    const preflight = await preflightWriterRepository(root)
    const lease = await repositoryDelegationLeases.acquire(root, "test")
    const wt = await createWriterWorktree({
      root,
      baseOid: preflight.baseOid,
      lease,
      assignmentId: "dirty",
    })
    writeFileSync(path.join(wt.path, "dirty.txt"), "dirty\n")
    await expect(collectWriterHandback(root, wt)).rejects.toThrow("dirty")
    await removeWriterWorktree(root, wt, true)
    repositoryDelegationLeases.release(lease)
  })
})
