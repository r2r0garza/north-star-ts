import { describe, it, expect, beforeEach, vi } from "vitest"

const { realpathMock } = vi.hoisted(() => ({
  realpathMock: vi.fn(),
}))

vi.mock("fs/promises", () => ({
  realpath: realpathMock,
}))

import { resolveInWorkspace, resolveInWorkspaceReal } from "./workspace"

const enoent = () =>
  Object.assign(new Error("ENOENT: missing"), { code: "ENOENT" })

describe("workspace path resolution", () => {
  beforeEach(() => {
    realpathMock.mockReset()
  })

  it("allows in-workspace names whose components start with two dots", () => {
    expect(resolveInWorkspace("/workspace", "..cache/note.txt")).toBe(
      "/workspace/..cache/note.txt"
    )
    expect(resolveInWorkspace("/workspace", "src/..notes/todo.txt")).toBe(
      "/workspace/src/..notes/todo.txt"
    )
  })

  it("still rejects parent traversal and absolute escapes", () => {
    expect(() => resolveInWorkspace("/workspace", "../outside.txt")).toThrow(
      "outside the workspace"
    )
    expect(() => resolveInWorkspace("/workspace", "/tmp/outside.txt")).toThrow(
      "outside the workspace"
    )
  })

  it("allows existing real paths with dot-dot-prefixed names", async () => {
    realpathMock.mockImplementation(async (path: string) => {
      if (path === "/workspace") return "/real/workspace"
      if (path === "/workspace/..cache/note.txt") {
        return "/real/workspace/..cache/note.txt"
      }
      throw enoent()
    })

    await expect(
      resolveInWorkspaceReal("/workspace", "..cache/note.txt")
    ).resolves.toBe("/real/workspace/..cache/note.txt")
  })

  it("walks to the nearest existing ancestor only for missing paths", async () => {
    realpathMock.mockImplementation(async (path: string) => {
      if (path === "/workspace") return "/real/workspace"
      if (path === "/workspace/..cache/new.txt") throw enoent()
      if (path === "/workspace/..cache") return "/real/workspace/..cache"
      throw new Error(`unexpected realpath ${path}`)
    })

    await expect(
      resolveInWorkspaceReal("/workspace", "..cache/new.txt")
    ).resolves.toBe("/real/workspace/..cache/new.txt")
  })

  it.each([
    [
      "permission",
      Object.assign(new Error("EACCES: denied"), { code: "EACCES" }),
    ],
    [
      "symlink loop",
      Object.assign(new Error("ELOOP: loop"), { code: "ELOOP" }),
    ],
    ["generic I/O", new Error("I/O failed")],
  ])("fails closed on %s realpath errors", async (_name, error) => {
    realpathMock.mockImplementation(async (path: string) => {
      if (path === "/workspace") return "/real/workspace"
      throw error
    })

    await expect(
      resolveInWorkspaceReal("/workspace", "blocked/file.txt")
    ).rejects.toThrow(error.message)
    expect(realpathMock).toHaveBeenCalledTimes(2)
  })

  it("rejects symlink escapes after resolving the real target", async () => {
    realpathMock.mockImplementation(async (path: string) => {
      if (path === "/workspace") return "/real/workspace"
      if (path === "/workspace/link/secret.txt") return "/outside/secret.txt"
      throw enoent()
    })

    await expect(
      resolveInWorkspaceReal("/workspace", "link/secret.txt")
    ).rejects.toThrow("resolves (via symlink) outside the workspace")
  })
})
