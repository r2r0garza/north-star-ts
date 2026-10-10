import { vi } from "vitest"
vi.setConfig({ testTimeout: 60_000 })
const nodeCommand = (code: string) =>
  `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(code).toString("base64")}', 'base64').toString('utf8'))"`

import { execFileSync } from "child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { listWorktrees } from "../agent/subagents/worktrees"
import {
  commitWorktreeChanges,
  createUserStoryWorktree,
  finalizeResolution,
  findUserStoryMerge,
  integrationBranchName,
  landingSummary,
  landLocally,
  generatedRulesFor,
  mergeUserStory,
  prepareResolution,
  startIntegrationBranch,
} from "./milestone-git"

const dirs: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mc-git-"))
  dirs.push(root)
  git(root, "init", "-b", "main")
  git(root, "config", "core.autocrlf", "false")
  git(root, "config", "core.eol", "lf")
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

// A user story worktree with one file written (uncommitted, as a worker leaves it).
async function userStory(
  root: string,
  key: string,
  file: string,
  content: string
) {
  const directory = scratch(key)
  const created = await createUserStoryWorktree({
    root,
    integrationBranch: INTEGRATION,
    userStoryKey: key,
    attempt: 1,
    directory,
  })
  writeFileSync(path.join(directory, file), content)
  await commitWorktreeChanges(directory, `user story ${key}`)
  return { ...created, directory, head: git(root, "rev-parse", created.branch) }
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe("milestone integration git", () => {
  it("starts the integration branch without touching the user's checkout", async () => {
    const root = repo()
    const head = git(root, "rev-parse", "HEAD")
    const started = await startIntegrationBranch({
      workspace: root,
      branch: INTEGRATION,
    })
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

  it("merges independent user stories in order and leaves no scratch worktrees", async () => {
    const root = repo()
    await startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    const a = await userStory(root, "invoice-api", "api.txt", "api\n")
    const b = await userStory(root, "invoice-pdf", "pdf.txt", "pdf\n")
    expect(a.branch).toBe("mc/billing/m1/userStories/invoice-api-1")
    expect(a.baseOid).toBe(b.baseOid)

    const first = await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: a.head,
      message:
        "user story invoice-api: API\n\nMission-Control-User-Story: user-story-a",
      scratchDirectory: scratch("merge-a"),
    })
    const second = await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: b.head,
      message:
        "user story invoice-pdf: PDF\n\nMission-Control-User-Story: user-story-b",
      scratchDirectory: scratch("merge-b"),
    })
    expect(first.status).toBe("merged")
    expect(second.status).toBe("merged")
    const log = git(root, "log", "--first-parent", "--format=%s", INTEGRATION)
    expect(log.split("\n").slice(0, 2)).toEqual([
      "user story invoice-pdf: PDF",
      "user story invoice-api: API",
    ])
    expect(await findUserStoryMerge(root, INTEGRATION, "user-story-a")).toBe(
      first.status === "merged" ? first.mergeCommit : ""
    )
    // Merging again is a no-op.
    expect(
      await mergeUserStory({
        root,
        integrationBranch: INTEGRATION,
        userStoryHead: a.head,
        message: "again",
        scratchDirectory: scratch("merge-again"),
      })
    ).toEqual({ status: "already_merged" })
    // Only the user's checkout and the two user story worktrees remain.
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
    const a = await userStory(
      root,
      "a",
      "shared.txt",
      "one\nTWO from a\nthree\n"
    )
    const b = await userStory(
      root,
      "b",
      "shared.txt",
      "one\nTWO from b\nthree\n"
    )
    await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: a.head,
      message: "a",
      scratchDirectory: scratch("m-a"),
    })
    const before = git(root, "rev-parse", INTEGRATION)
    const conflict = await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: b.head,
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
      userStoryHead: b.head,
      directory,
    })
    expect(prepared).toEqual({ startOid: before, files: ["shared.txt"] })
    expect(readFileSync(path.join(directory, "shared.txt"), "utf8")).toContain(
      "<<<<<<<"
    )
    const finalize = () =>
      finalizeResolution({
        root,
        integrationBranch: INTEGRATION,
        directory,
        startOid: prepared.startOid,
        userStoryHead: b.head,
        conflictFiles: prepared.files,
        message:
          "user story b: resolved\n\nMission-Control-User-Story: user-story-b",
      })
    expect(await finalize()).toEqual({
      status: "unresolved",
      files: ["shared.txt"],
    })
    writeFileSync(
      path.join(directory, "shared.txt"),
      "one\nTWO from a and b\nthree\n"
    )
    const done = await finalize()
    expect(done.status).toBe("merged")
    expect(git(root, "show", `${INTEGRATION}:shared.txt`)).toContain("a and b")
    expect(git(root, "merge-base", "--is-ancestor", b.head, INTEGRATION)).toBe(
      ""
    )
  })

  it("won't move an integration branch someone checked out", async () => {
    const root = repo()
    await startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    const a = await userStory(root, "a", "a.txt", "a\n")
    const inspect = scratch("inspect")
    git(root, "worktree", "add", inspect, INTEGRATION)
    const outcome = await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: a.head,
      message: "a",
      scratchDirectory: scratch("m"),
    })
    expect(outcome.status).toBe("blocked")
    expect(git(inspect, "rev-parse", "HEAD")).toBe(a.baseOid)
  })

  it("lands locally: fast-forward, merge commit, and stale approvals", async () => {
    const root = repo()
    await startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    const a = await userStory(root, "a", "a.txt", "a\n")
    await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: a.head,
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
    const a = await userStory(root, "a", "a.txt", "a\n")
    await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: a.head,
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
      message: "Merge milestone m1",
      scratchDirectory: scratch("land"),
    })
    expect(landed.fastForward).toBe(false)
    expect(git(root, "rev-parse", "main")).toBe(landed.mergeCommit)
    expect(git(root, "log", "-1", "--format=%s", "main")).toBe(
      "Merge milestone m1"
    )
    expect(git(root, "branch", "--show-current")).toBe("elsewhere")
    expect((await listWorktrees(root)).length).toBe(2)
  })
})

describe("worktreeDiff", () => {
  it("includes new untracked files without staging them", async () => {
    const root = repo()
    const { worktreeDiff } = await import("./milestone-git")
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

describe("regenerating generated files on a merge conflict", () => {
  // A user story that writes several files, e.g. a source file and the index a
  // repository regenerates from its sources.
  async function storyWith(
    root: string,
    key: string,
    files: Record<string, string>
  ) {
    const directory = scratch(key)
    const created = await createUserStoryWorktree({
      root,
      integrationBranch: INTEGRATION,
      userStoryKey: key,
      attempt: 1,
      directory,
    })
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
      writeFileSync(path.join(directory, file), content)
    }
    await commitWorktreeChanges(directory, `user story ${key}`)
    return { head: git(root, "rev-parse", created.branch) }
  }

  // Rebuilds the "index" from the sources, as a repository's generator would.
  const INDEX_RULE = {
    paths: [".code-index/**"],
    command: nodeCommand(
      "const fs = require('fs'); fs.mkdirSync('.code-index', { recursive: true }); fs.writeFileSync('.code-index/files.txt', fs.readdirSync('src').sort().join('\\n') + '\\n')"
    ),
  }

  async function twoStoriesSharingTheIndex(extra: Record<string, string> = {}) {
    const root = repo()
    await startIntegrationBranch({ workspace: root, branch: INTEGRATION })
    const a = await storyWith(root, "a", {
      "src/a.py": "a\n",
      ".code-index/files.txt": "a.py\n",
    })
    const b = await storyWith(root, "b", {
      "src/b.py": "b\n",
      ".code-index/files.txt": "b.py\n",
      ...extra,
    })
    await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: a.head,
      message: "user story a",
      scratchDirectory: scratch("merge-a"),
    })
    return { root, b }
  }

  it("matches conflicts against a workspace's rules, inside its subpath", () => {
    const spec = { rules: [INDEX_RULE], subpath: "" }
    expect(generatedRulesFor([".code-index/files.txt"], spec)).toEqual([
      INDEX_RULE,
    ])
    expect(
      generatedRulesFor([".code-index/files.txt", "src/a.py"], spec)
    ).toBeNull()
    expect(
      generatedRulesFor(["web/.code-index/x.json"], {
        rules: [INDEX_RULE],
        subpath: "web",
      })
    ).toEqual([INDEX_RULE])
    expect(
      generatedRulesFor(["api/.code-index/x.json"], {
        rules: [INDEX_RULE],
        subpath: "web",
      })
    ).toBeNull()
    const lockfile = { paths: ["**/package-lock.json"], command: "npm install" }
    expect(
      generatedRulesFor(["app/package-lock.json"], {
        rules: [lockfile],
        subpath: "",
      })
    ).toEqual([lockfile])
  })

  it("regenerates and merges when only generated files conflict", async () => {
    const { root, b } = await twoStoriesSharingTheIndex()
    const outcome = await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: b.head,
      message: "user story b",
      scratchDirectory: scratch("merge-b"),
      regenerate: { rules: [INDEX_RULE], subpath: "" },
    })
    expect(outcome).toMatchObject({
      status: "merged",
      regenerated: [".code-index/files.txt"],
    })
    // The index holds both stories' sources, and the merge kept both sides.
    expect(git(root, "show", `${INTEGRATION}:.code-index/files.txt`)).toBe(
      "a.py\nb.py"
    )
    expect(git(root, "show", `${INTEGRATION}:src/b.py`)).toBe("b")
    expect(git(root, "log", "-1", "--format=%s", INTEGRATION)).toBe(
      "user story b"
    )
  })

  it("reruns a pre-commit-style command that exits non-zero after rewriting", async () => {
    const { root, b } = await twoStoriesSharingTheIndex()
    // Fails while its rewrite is unstaged ("stage these and retry"), passes
    // once staged — like codex-agentic-os's `index pre-commit`.
    const preCommit = {
      paths: [".code-index/**"],
      command:
        nodeCommand(
          "const fs = require('fs'); fs.mkdirSync('.code-index', { recursive: true }); fs.writeFileSync('.code-index/files.txt', fs.readdirSync('src').sort().join('\\n') + '\\n')"
        ) + " && git diff --quiet -- .code-index",
    }
    const outcome = await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: b.head,
      message: "user story b",
      scratchDirectory: scratch("merge-b"),
      regenerate: { rules: [preCommit], subpath: "" },
    })
    expect(outcome).toMatchObject({
      status: "merged",
      regenerated: [".code-index/files.txt"],
    })
    expect(git(root, "show", `${INTEGRATION}:.code-index/files.txt`)).toBe(
      "a.py\nb.py"
    )
  })

  it("hands the conflict to the integrator when regenerating fails", async () => {
    const { root, b } = await twoStoriesSharingTheIndex()
    const head = git(root, "rev-parse", INTEGRATION)
    const outcome = await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: b.head,
      message: "user story b",
      scratchDirectory: scratch("merge-b"),
      regenerate: {
        rules: [{ ...INDEX_RULE, command: "exit 3" }],
        subpath: "",
      },
    })
    expect(outcome).toMatchObject({
      status: "conflict",
      files: [".code-index/files.txt"],
      regenerateError: expect.stringContaining("`exit 3` failed"),
    })
    expect(git(root, "rev-parse", INTEGRATION)).toBe(head)
  })

  it("leaves a conflict in real source files to the integrator", async () => {
    const { root, b } = await twoStoriesSharingTheIndex({
      "shared.txt": "one\nB\nthree\n",
    })
    // Make the integration side change shared.txt too.
    const c = await storyWith(root, "c", { "shared.txt": "one\nC\nthree\n" })
    await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: c.head,
      message: "user story c",
      scratchDirectory: scratch("merge-c"),
    })
    const outcome = await mergeUserStory({
      root,
      integrationBranch: INTEGRATION,
      userStoryHead: b.head,
      message: "user story b",
      scratchDirectory: scratch("merge-b"),
      regenerate: { rules: [INDEX_RULE], subpath: "" },
    })
    expect(outcome.status).toBe("conflict")
    expect(outcome).not.toHaveProperty("regenerateError")
  })
})
