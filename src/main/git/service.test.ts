import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { GitService } from "./service"
import type { Environment, ExecFileOptions, ExecResult } from "../agent/env/types"

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
