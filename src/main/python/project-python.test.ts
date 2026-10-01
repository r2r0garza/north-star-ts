import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { workspaceManagesPython } from "./project-python"

describe("workspaceManagesPython", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "project-python-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function touch(rel: string): Promise<void> {
    const path = join(root, rel)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, "")
  }

  it("is false for a workspace with no Python environment", async () => {
    await touch("frontend/package.json")
    await touch("scripts/tool.py")
    expect(await workspaceManagesPython(root)).toBe(false)
  })

  it("finds a venv at the root", async () => {
    await touch(".venv/pyvenv.cfg")
    expect(await workspaceManagesPython(root)).toBe(true)
  })

  it("finds a venv in a subfolder, whatever it is named", async () => {
    await touch("frontend/package.json")
    await touch("backend/env/pyvenv.cfg")
    expect(await workspaceManagesPython(root)).toBe(true)
  })

  it("finds venvs nested a few levels down", async () => {
    await touch("services/api/.venv/pyvenv.cfg")
    expect(await workspaceManagesPython(root)).toBe(true)
  })

  it.each(["poetry.lock", "Pipfile", "uv.lock"])(
    "treats %s as a project that manages its own Python",
    async (marker) => {
      await touch(`backend/${marker}`)
      expect(await workspaceManagesPython(root)).toBe(true)
    }
  )

  it("ignores markers inside node_modules", async () => {
    await touch("node_modules/pkg/.venv/pyvenv.cfg")
    expect(await workspaceManagesPython(root)).toBe(false)
  })

  it("stops at the depth limit", async () => {
    await touch("a/b/c/d/pyvenv.cfg")
    expect(await workspaceManagesPython(root, { maxDepth: 3 })).toBe(false)
    expect(await workspaceManagesPython(root, { maxDepth: 4 })).toBe(true)
  })

  it("is false for a workspace that doesn't exist", async () => {
    expect(await workspaceManagesPython(join(root, "missing"))).toBe(false)
  })
})
