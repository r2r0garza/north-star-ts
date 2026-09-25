import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { listWorktrees } from "../agent/subagents/worktrees"
import {
  commitWorktreeChanges,
  createSliceWorktree,
  finalizeResolution,
  findSliceMerge,
  integrationBranchName,
  landingSummary,
  landLocally,
  mergeSlice,
  prepareResolution,
  startIntegrationBranch,
} from "./mission-git"

const dirs: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mc-git-"))
  dirs.push(root)
  git(root, "init", "-b", "main")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "user.name", "Test")
  writeFileSync(path.join(root, "README.md"), "base\n")
  writeFileSync(path.join(root, "shared.txt"), "one\ntwo\nthree\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "base")
  return root
}

function scratch(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `mc-wt-${name}-`))
  dirs.push(dir)
  rmSync(dir, { recursive: true, force: true })
  return dir
}

const INTEGRATION = integrationBranchName("billing", "m1")

// A slice worktree with one file written (uncommitted, as a worker leaves it).
async function slice(root: string, key: string, file: string, content: string) {
  const directory = scratch(key)
  const created = await createSliceWorktree({
    root,
    integrationBranch: INTEGRATION,
    sliceKey: key,
    attempt: 1,
    directory,
  })
  writeFileSync(path.join(directory, file), content)
  await commitWorktreeChanges(directory, `slice ${key}`)
  return { ...created, directory, head: git(root, "rev-parse", created.branch) }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("mission integration git", () => {
  it("starts the integration branch without touching the user's checkout", async () => {
    const root = repo()
    const head = git(root, "rev-parse", "HEAD")
    const started = await startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    expect(started).toMatchObject({ baseRef: "main", baseOid: head })
    expect(git(root, "rev-parse", INTEGRATION)).toBe(head)
    expect(git(root, "branch", "--show-current")).toBe("main")
    // Idempotent after a crash between creating and recording the branch.
    await expect(
      startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    ).resolves.toMatchObject({ baseOid: head })
  })

  it("refuses a dirty tree or a detached HEAD", async () => {
    const root = repo()
    writeFileSync(path.join(root, "dirty.txt"), "x\n")
    await expect(
      startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    ).rejects.toThrow(/clean working tree/)
    rmSync(path.join(root, "dirty.txt"))
    git(root, "checkout", "--detach")
    await expect(
      startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    ).rejects.toThrow(/detached HEAD/)
  })

  it("merges independent slices in order and leaves no scratch worktrees", async () => {
    const root = repo()
    await startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    const a = await slice(root, "invoice-api", "api.txt", "api\n")
    const b = await slice(root, "invoice-pdf", "pdf.txt", "pdf\n")
    expect(a.branch).toBe("mc/billing/m1/slices/invoice-api-1")
    expect(a.baseOid).toBe(b.baseOid)

    const first = await mergeSlice({
      root,
      integrationBranch: INTEGRATION,
      sliceHead: a.head,
      message: "slice invoice-api: API\n\nMission-Control-Slice: slice-a",
      scratchDirectory: scratch("merge-a"),
    })
    const second = await mergeSlice({
      root,
      integrationBranch: INTEGRATION,
      sliceHead: b.head,
      message: "slice invoice-pdf: PDF\n\nMission-Control-Slice: slice-b",
      scratchDirectory: scratch("merge-b"),
    })
    expect(first.status).toBe("merged")
    expect(second.status).toBe("merged")
    const log = git(root, "log", "--first-parent", "--format=%s", INTEGRATION)
    expect(log.split("\n").slice(0, 2)).toEqual([
      "slice invoice-pdf: PDF",
      "slice invoice-api: API",
    ])
    expect(await findSliceMerge(root, INTEGRATION, "slice-a")).toBe(
      first.status === "merged" ? first.mergeCommit : ""
    )
    // Merging again is a no-op.
    expect(
      await mergeSlice({
        root,
        integrationBranch: INTEGRATION,
        sliceHead: a.head,
        message: "again",
        scratchDirectory: scratch("merge-again"),
      })
    ).toEqual({ status: "already_merged" })
    // Only the user's checkout and the two slice worktrees remain.
    expect((await listWorktrees(root)).map((w) => w.branch).sort()).toEqual([
      "refs/heads/main",
      `refs/heads/${a.branch}`,
      `refs/heads/${b.branch}`,
    ])
    expect(git(root, "status", "--porcelain")).toBe("")
    expect(git(root, "branch", "--show-current")).toBe("main")
  })

  it("aborts a conflict cleanly, then commits an integrator's resolution", async () => {
    const root = repo()
    await startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    const a = await slice(root, "a", "shared.txt", "one\nTWO from a\nthree\n")
    const b = await slice(root, "b", "shared.txt", "one\nTWO from b\nthree\n")
    await mergeSlice({
      root,
      integrationBranch: INTEGRATION,
      sliceHead: a.head,
      message: "a",
      scratchDirectory: scratch("m-a"),
    })
    const before = git(root, "rev-parse", INTEGRATION)
    const conflict = await mergeSlice({
      root,
      integrationBranch: INTEGRATION,
      sliceHead: b.head,
      message: "b",
      scratchDirectory: scratch("m-b"),
    })
    expect(conflict).toEqual({ status: "conflict", files: ["shared.txt"] })
    expect(git(root, "rev-parse", INTEGRATION)).toBe(before)
    expect(git(root, "status", "--porcelain")).toBe("")
    expect((await listWorktrees(root)).length).toBe(3)

    const directory = scratch("resolve")
    const prepared = await prepareResolution({
      root,
      integrationBranch: INTEGRATION,
      sliceHead: b.head,
      directory,
    })
    expect(prepared).toEqual({ startOid: before, files: ["shared.txt"] })
    expect(readFileSync(path.join(directory, "shared.txt"), "utf8")).toContain("<<<<<<<")
    const finalize = () =>
      finalizeResolution({
        root,
        integrationBranch: INTEGRATION,
        directory,
        startOid: prepared.startOid,
        sliceHead: b.head,
        conflictFiles: prepared.files,
        message: "slice b: resolved\n\nMission-Control-Slice: slice-b",
      })
    expect(await finalize()).toEqual({ status: "unresolved", files: ["shared.txt"] })
    writeFileSync(path.join(directory, "shared.txt"), "one\nTWO from a and b\nthree\n")
    const done = await finalize()
    expect(done.status).toBe("merged")
    expect(git(root, "show", `${INTEGRATION}:shared.txt`)).toContain("a and b")
    expect(git(root, "merge-base", "--is-ancestor", b.head, INTEGRATION)).toBe("")
  })

  it("won't move an integration branch someone checked out", async () => {
    const root = repo()
    await startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    const a = await slice(root, "a", "a.txt", "a\n")
    const inspect = scratch("inspect")
    git(root, "worktree", "add", inspect, INTEGRATION)
    const outcome = await mergeSlice({
      root,
      integrationBranch: INTEGRATION,
      sliceHead: a.head,
      message: "a",
      scratchDirectory: scratch("m"),
    })
    expect(outcome.status).toBe("blocked")
    expect(git(inspect, "rev-parse", "HEAD")).toBe(a.baseOid)
  })

  it("lands locally: fast-forward, merge commit, and stale approvals", async () => {
    const root = repo()
    await startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    const a = await slice(root, "a", "a.txt", "a\n")
    await mergeSlice({
      root,
      integrationBranch: INTEGRATION,
      sliceHead: a.head,
      message: "a",
      scratchDirectory: scratch("m"),
    })
    const summary = await landingSummary(root, "main", INTEGRATION)
    expect(summary).toMatchObject({
      fastForward: true,
      merged: false,
      commitCount: 2,
      baseCheckout: expect.stringContaining("mc-git-"),
    })
    expect(summary.files).toEqual([{ status: "A", path: "a.txt" }])

    // A stale approval changes nothing.
    await expect(
      landLocally({
        root,
        base: "main",
        expectedBaseOid: summary.baseOid!,
        head: INTEGRATION,
        expectedHeadOid: "0".repeat(40),
        message: "land",
        scratchDirectory: scratch("land"),
      })
    ).rejects.toThrow(/moved since you reviewed/)
    // Uncommitted changes in the checked-out base block the merge.
    writeFileSync(path.join(root, "README.md"), "edited\n")
    await expect(
      landLocally({
        root,
        base: "main",
        expectedBaseOid: summary.baseOid!,
        head: INTEGRATION,
        expectedHeadOid: summary.headOid!,
        message: "land",
        scratchDirectory: scratch("land"),
      })
    ).rejects.toThrow(/uncommitted changes/)
    git(root, "checkout", "README.md")

    const landed = await landLocally({
      root,
      base: "main",
      expectedBaseOid: summary.baseOid!,
      head: INTEGRATION,
      expectedHeadOid: summary.headOid!,
      message: "land",
      scratchDirectory: scratch("land"),
    })
    expect(landed).toEqual({ mergeCommit: summary.headOid, fastForward: true })
    expect(existsSync(path.join(root, "a.txt"))).toBe(true)
    expect((await landingSummary(root, "main", INTEGRATION)).merged).toBe(true)
  })

  it("lands with a merge commit on a base that moved and isn't checked out", async () => {
    const root = repo()
    await startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    const a = await slice(root, "a", "a.txt", "a\n")
    await mergeSlice({
      root,
      integrationBranch: INTEGRATION,
      sliceHead: a.head,
      message: "a",
      scratchDirectory: scratch("m"),
    })
    writeFileSync(path.join(root, "later.txt"), "later\n")
    git(root, "add", "later.txt")
    git(root, "commit", "-m", "user work")
    git(root, "checkout", "-b", "elsewhere")
    const summary = await landingSummary(root, "main", INTEGRATION)
    expect(summary).toMatchObject({ fastForward: false, baseCheckout: null })
    const landed = await landLocally({
      root,
      base: "main",
      expectedBaseOid: summary.baseOid!,
      head: INTEGRATION,
      expectedHeadOid: summary.headOid!,
      message: "Merge mission m1",
      scratchDirectory: scratch("land"),
    })
    expect(landed.fastForward).toBe(false)
    expect(git(root, "rev-parse", "main")).toBe(landed.mergeCommit)
    expect(git(root, "log", "-1", "--format=%s", "main")).toBe("Merge mission m1")
    expect(git(root, "branch", "--show-current")).toBe("elsewhere")
    expect((await listWorktrees(root)).length).toBe(2)
  })
})

describe("worktreeDiff", () => {
  it("includes new untracked files without staging them", async () => {
    const root = repo()
    const { worktreeDiff } = await import("./mission-git")
    writeFileSync(path.join(root, "README.md"), "changed\n")
    writeFileSync(path.join(root, "new.txt"), "brand new\n")
    const base = git(root, "rev-parse", "HEAD")
    const { diff, truncated } = await worktreeDiff(root, base, 100_000)
    expect(truncated).toBe(false)
    expect(diff).toContain("+changed")
    expect(diff).toContain("+brand new")
    expect(git(root, "status", "--porcelain")).toContain("?? new.txt")
  })
})
