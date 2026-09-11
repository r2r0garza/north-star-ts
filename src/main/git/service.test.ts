import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { GitService } from "./service"
import type {
  Environment,
  ExecFileOptions,
  ExecResult,
} from "../agent/env/types"

let gitAvailable = true
try {
  execFileSync("git", ["--version"], { stdio: "ignore" })
} catch {
  gitAvailable = false
}

function git(repo: string, ...args: string[]) {
  return execFileSync("git", args, { cwd: repo, stdio: "ignore" })
}

describe.skipIf(!gitAvailable)("GitService", () => {
  let repo: string
  let plain: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "git-service-repo-"))
    plain = mkdtempSync(join(tmpdir(), "git-service-plain-"))
    git(repo, "init")
    git(repo, "config", "user.email", "t@t.test")
    git(repo, "config", "user.name", "Test")
    writeFileSync(join(repo, "tracked.txt"), "line one\nline two\n")
    mkdirSync(join(repo, "src"), { recursive: true })
    writeFileSync(join(repo, "src", "keep.ts"), "export const keep = 1\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "init")
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  })

  it("returns a typed non-repo result", async () => {
    await expect(new GitService(plain).status()).resolves.toMatchObject({
      isRepo: false,
      entries: [],
    })
  })

  it("parses dirty, staged, untracked, and renamed status records", async () => {
    writeFileSync(join(repo, "tracked.txt"), "line one\nchanged\n")
    writeFileSync(join(repo, "new.txt"), "new\n")
    git(repo, "add", "tracked.txt")
    git(repo, "mv", "src/keep.ts", "src/moved.ts")

    const status = await new GitService(repo).status()
    expect(status.isRepo).toBe(true)
    expect(status.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", index: "M" }),
        expect.objectContaining({ path: "new.txt", kind: "untracked" }),
        expect.objectContaining({
          path: "src/moved.ts",
          originalPath: "src/keep.ts",
          kind: "renamed",
        }),
      ])
    )
  })

  it("reports commits ahead of the configured upstream", async () => {
    git(plain, "init", "--bare")
    git(repo, "remote", "add", "origin", plain)
    git(repo, "push", "-u", "origin", "HEAD")
    writeFileSync(join(repo, "tracked.txt"), "local one\n")
    git(repo, "commit", "-am", "local one")
    writeFileSync(join(repo, "tracked.txt"), "local two\n")
    git(repo, "commit", "-am", "local two")

    const status = await new GitService(repo).status()

    expect(status.upstream).toMatch(/^origin\//)
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(0)
  })

  it("leaves tracking counts absent when the branch has no upstream", async () => {
    const status = await new GitService(repo).status()

    expect(status.upstream).toBeUndefined()
    expect(status.ahead).toBeUndefined()
    expect(status.behind).toBeUndefined()
  })

  it("sets the upstream when pushing a branch for the first time", async () => {
    git(plain, "init", "--bare")
    git(repo, "remote", "add", "origin", plain)
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: repo,
    })
      .toString()
      .trim()

    const result = await new GitService(repo).push()

    expect(result).toEqual({
      ok: true,
      action: "push",
      summary: `Pushed current branch and set its upstream to origin/${branch}.`,
    })
    expect(
      execFileSync(
        "git",
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        { cwd: repo }
      )
        .toString()
        .trim()
    ).toBe(`origin/${branch}`)
    await expect(new GitService(repo).status()).resolves.toMatchObject({
      upstream: `origin/${branch}`,
      ahead: 0,
      behind: 0,
    })
  })

  it("returns bounded diffs, logs, shows, and branches", async () => {
    writeFileSync(join(repo, "tracked.txt"), "line one\nchanged\n")
    const service = new GitService(repo)

    const diff = await service.diff({ path: "tracked.txt" })
    expect(diff.diff).toContain("-line two")
    expect(diff.diff).toContain("+changed")

    const log = await service.log({ limit: 1, path: "tracked.txt" })
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0].subject).toBe("init")

    const show = await service.show("HEAD", "tracked.txt")
    expect(show.text).toContain("commit ")
    expect(show.text).toContain("init")

    const branches = await service.branches()
    expect(branches.branches.some((b) => b.current)).toBe(true)
  })

  it("commits selected complete files while preserving unrelated staged work", async () => {
    writeFileSync(join(repo, "tracked.txt"), "line one\nselected\n")
    writeFileSync(join(repo, "src", "keep.ts"), "export const keep = 2\n")
    writeFileSync(join(repo, "new.txt"), "new\n")
    git(repo, "add", "src/keep.ts")

    const result = await new GitService(repo).commitSelected(
      ["tracked.txt", "new.txt"],
      "selected files"
    )

    expect(result).toMatchObject({ ok: true, subject: "selected files" })
    expect(
      execFileSync("git", ["show", "HEAD:tracked.txt"], {
        cwd: repo,
      }).toString()
    ).toContain("selected")
    expect(
      execFileSync("git", ["show", "HEAD:new.txt"], { cwd: repo }).toString()
    ).toBe("new\n")
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repo })
        .toString()
        .trim()
    ).toBe("src/keep.ts")
  })

  it("commits a selected file's complete snapshot when it was partially staged", async () => {
    writeFileSync(join(repo, "tracked.txt"), "line one\nstaged\n")
    git(repo, "add", "tracked.txt")
    writeFileSync(join(repo, "tracked.txt"), "line one\ncomplete\n")

    const result = await new GitService(repo).commitSelected(
      ["tracked.txt"],
      "complete snapshot"
    )

    expect(result).toMatchObject({ ok: true })
    expect(
      execFileSync("git", ["show", "HEAD:tracked.txt"], {
        cwd: repo,
      }).toString()
    ).toBe("line one\ncomplete\n")
  })

  it("rejects conflicted and unknown selected paths without committing", async () => {
    const service = new GitService(repo)
    await expect(
      service.commitSelected(["missing.txt"], "message")
    ).resolves.toEqual(expect.objectContaining({ ok: false }))
    await expect(
      service.commitSelected(["--output=/tmp/x"], "message")
    ).resolves.toEqual(expect.objectContaining({ ok: false }))
  })

  it("rejects flag-like paths and remote-url revisions", async () => {
    const service = new GitService(repo)
    await expect(service.diff({ path: "--output=/tmp/x" })).rejects.toThrow(
      /Paths may not start/
    )
    await expect(service.show("https://example.com/repo")).rejects.toThrow(
      /Invalid revision/
    )
  })
})

describe("GitService argv execution", () => {
  it("passes model values as argv only", async () => {
    const calls: string[][] = []
    const env = {
      execFile: async (
        file: string,
        args: string[],
        _opts: ExecFileOptions
      ): Promise<ExecResult> => {
        calls.push([file, ...args])
        const command = args.at(-1)
        const stdout =
          command === "--is-inside-work-tree"
            ? "true\n"
            : command === "--show-toplevel"
              ? "/repo\n"
              : command === "HEAD"
                ? "commit abc\n"
                : "main\n"
        return {
          stdout: Buffer.from(stdout),
          stderr: Buffer.from(""),
          exitCode: 0,
          signal: null,
          timedOut: false,
        }
      },
    } as Environment

    await new GitService("/repo", env).show("HEAD")
    expect(calls.every((call) => call[0] === "git")).toBe(true)
    expect(calls.flat()).toContain("show")
    expect(calls.flat()).toContain("--")
  })
})
