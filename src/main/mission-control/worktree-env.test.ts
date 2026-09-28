import { execFileSync } from "child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs"
import { tmpdir } from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { prepareWorktreeEnvironment, renderEnvironment } from "./worktree-env"

const dirs: string[] = []
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim()

// A repository whose main checkout has an ignored .venv, plus a worktree of it
// (which, like a user story's, has only tracked files).
function repoWithWorktree() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wt-env-")))
  dirs.push(root)
  git(root, "init", "-b", "main")
  git(root, "config", "user.email", "t@example.com")
  git(root, "config", "user.name", "T")
  writeFileSync(path.join(root, ".gitignore"), ".venv/\n")
  writeFileSync(path.join(root, "app.py"), "print('hi')\n")
  git(root, "add", ".")
  git(root, "commit", "-m", "base")
  mkdirSync(path.join(root, ".venv", "bin"), { recursive: true })
  writeFileSync(path.join(root, ".venv", "bin", "pytest"), "#!/bin/sh\n")
  const worktree = `${root}-story`
  dirs.push(worktree)
  git(root, "worktree", "add", "-q", "-b", "story", worktree)
  return { root, worktree }
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe("prepareWorktreeEnvironment", () => {
  it("links ignored paths from the main checkout without git picking them up", async () => {
    const { root, worktree } = repoWithWorktree()
    const env = await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup: { linkPaths: [".venv", "node_modules"], command: "" },
    })
    expect(env).toEqual({
      linked: [".venv"],
      missing: ["node_modules"],
      command: null,
      error: null,
    })
    expect(lstatSync(path.join(worktree, ".venv")).isSymbolicLink()).toBe(true)
    expect(existsSync(path.join(worktree, ".venv", "bin", "pytest"))).toBe(true)
    // A symlink isn't matched by ".venv/", so without the exclude it'd commit.
    expect(git(worktree, "status", "--porcelain")).toBe("")
  })

  it("runs the setup command in the worktree and reports a failure instead of throwing", async () => {
    const { root, worktree } = repoWithWorktree()
    const ok = await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup: { linkPaths: [], command: "touch .ready" },
    })
    expect(ok).toMatchObject({ command: "touch .ready", error: null })
    expect(existsSync(path.join(worktree, ".ready"))).toBe(true)

    const failed = await prepareWorktreeEnvironment({
      mainWorkspace: root,
      worktreeWorkspace: worktree,
      setup: { linkPaths: [], command: "exit 4" },
    })
    expect(failed?.error).toBeTruthy()
  })

  it("does nothing when the workspace configures no setup", async () => {
    const { root, worktree } = repoWithWorktree()
    expect(
      await prepareWorktreeEnvironment({
        mainWorkspace: root,
        worktreeWorkspace: worktree,
        setup: { linkPaths: [], command: "" },
      })
    ).toBeNull()
  })
})

describe("renderEnvironment", () => {
  it("tells agents what's ready and not to search the machine", () => {
    const text = renderEnvironment({
      linked: [".venv"],
      missing: [],
      command: "pip install -e '.[dev]'",
      error: null,
    }).join("\n")
    expect(text).toContain("## Environment")
    expect(text).toContain("`.venv`")
    expect(text).toContain("has already run here")
    expect(text).toContain("don't search the machine")
  })

  it("asks agents to report, not improvise, when setup failed", () => {
    const text = renderEnvironment({
      linked: [],
      missing: [],
      command: "uv sync",
      error: "uv: command not found",
    }).join("\n")
    expect(text).toContain("failed (uv: command not found)")
    expect(text).toContain("say so in your result")
  })
})
