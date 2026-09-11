import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { listWorkspaceDirectory } from "./tree"

let gitAvailable = true
try {
  execFileSync("git", ["--version"], { stdio: "ignore" })
} catch {
  gitAvailable = false
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "files-tree-test-"))
  await mkdir(join(root, "folder"))
  await mkdir(join(root, ".hidden"))
  await writeFile(join(root, "z-file.txt"), "z")
  await writeFile(join(root, ".gitignore"), "z-file.txt\n")
  await writeFile(join(root, "a-file.txt"), "a")
  await writeFile(join(root, "folder", "nested.txt"), "nested")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("listWorkspaceDirectory", () => {
  it("lists direct children, including dotfiles and gitignored entries", async () => {
    const result = await listWorkspaceDirectory(root, "")
    expect(result.error).toBeNull()
    expect(result.entries.map((entry) => entry.path)).toEqual([
      ".hidden",
      "folder",
      ".gitignore",
      "a-file.txt",
      "z-file.txt",
    ])
    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "directory",
      "directory",
      "file",
      "file",
      "file",
    ])
    expect(result.entries.every((entry) => !entry.ignored)).toBe(true)
  })

  it.skipIf(!gitAvailable)("marks entries ignored by Git", async () => {
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
    const result = await listWorkspaceDirectory(root, "")
    expect(
      result.entries.find((entry) => entry.path === "z-file.txt")?.ignored
    ).toBe(true)
    expect(
      result.entries.find((entry) => entry.path === "a-file.txt")?.ignored
    ).toBe(false)
  })

  it("lists only a nested directory's direct children", async () => {
    const result = await listWorkspaceDirectory(root, "folder")
    expect(result).toMatchObject({
      entries: [
        {
          name: "nested.txt",
          path: "folder/nested.txt",
          kind: "file",
          ignored: false,
        },
      ],
      error: null,
    })
  })

  it("rejects traversal and absolute paths", async () => {
    await expect(listWorkspaceDirectory(root, "../")).resolves.toMatchObject({
      entries: [],
      error: "Directory is unavailable.",
    })
    await expect(listWorkspaceDirectory(root, root)).resolves.toMatchObject({
      entries: [],
      error: "Directory is unavailable.",
    })
  })

  it("returns symlinks but never treats them as expandable directories", async () => {
    await symlink(join(root, "folder"), join(root, "folder-link"))
    const result = await listWorkspaceDirectory(root, "")
    expect(result.entries).toContainEqual({
      name: "folder-link",
      path: "folder-link",
      kind: "symlink",
      ignored: false,
    })
    await expect(
      listWorkspaceDirectory(root, "folder-link")
    ).resolves.toMatchObject({
      entries: [],
      error: "Path is not a directory.",
    })
    expect((await lstat(join(root, "folder-link"))).isSymbolicLink()).toBe(true)
  })
})
