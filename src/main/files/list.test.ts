import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { listWorkspaceFiles } from "./list"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "files-list-test-"))
  await mkdir(join(root, "src"), { recursive: true })
  await mkdir(join(root, "src", "lib"), { recursive: true })
  await mkdir(join(root, "node_modules", "dep"), { recursive: true })
  await writeFile(join(root, "README.md"), "readme")
  await writeFile(join(root, "src", "foo.ts"), "foo")
  await writeFile(join(root, "src", "lib", "bar.ts"), "bar")
  await writeFile(join(root, "secret.env"), "shh")
  await writeFile(join(root, ".gitignore"), "secret.env\n")
  await writeFile(join(root, "node_modules", "dep", "index.js"), "dep")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("listWorkspaceFiles", () => {
  it("returns workspace-relative POSIX paths for an empty query", async () => {
    const files = await listWorkspaceFiles(root, "", 1000)
    expect(files).toContain("README.md")
    expect(files).toContain("src/foo.ts")
    expect(files).toContain("src/lib/bar.ts")
  })

  it("honors .gitignore and default skip dirs", async () => {
    const files = await listWorkspaceFiles(root, "", 1000)
    expect(files).not.toContain("secret.env")
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false)
  })

  it("filters by basename and ranks basename matches first", async () => {
    const files = await listWorkspaceFiles(root, "foo", 1000)
    expect(files).toEqual(["src/foo.ts"])
  })

  it("matches on path segments too", async () => {
    const files = await listWorkspaceFiles(root, "lib", 1000)
    expect(files).toContain("src/lib/bar.ts")
  })

  it("is case-insensitive", async () => {
    const files = await listWorkspaceFiles(root, "README", 1000)
    expect(files).toContain("README.md")
  })

  it("returns [] when nothing matches", async () => {
    expect(await listWorkspaceFiles(root, "zzz-nope", 1000)).toEqual([])
  })

  it("caches the walk within the TTL (new files not seen until expiry)", async () => {
    await listWorkspaceFiles(root, "", 1000) // warm cache at t=1000
    await writeFile(join(root, "src", "added.ts"), "new")
    // Within TTL: served from cache, new file absent.
    const cached = await listWorkspaceFiles(root, "added", 1000 + 5_000)
    expect(cached).toEqual([])
    // After TTL: fresh walk picks it up.
    const fresh = await listWorkspaceFiles(root, "added", 1000 + 60_000)
    expect(fresh).toContain("src/added.ts")
  })
})
