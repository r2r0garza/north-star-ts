import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { walkFiles, loadGitignore, isBinaryBuffer, DEFAULT_SKIP_DIRS } from "./walk"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "walk-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function collect(opts: Parameters<typeof walkFiles>[0]): Promise<string[]> {
  const out: string[] = []
  for await (const f of walkFiles(opts)) out.push(f.relPath)
  return out.sort()
}

describe("walkFiles", () => {
  it("yields files relative to root, POSIX-normalized", async () => {
    await mkdir(join(root, "src"))
    await writeFile(join(root, "src", "a.ts"), "x")
    await writeFile(join(root, "b.md"), "y")
    const rels = await collect({ root, maxFileBytes: 1e6 })
    expect(rels).toEqual(["b.md", "src/a.ts"])
  })

  it("prunes default skip dirs", async () => {
    await mkdir(join(root, "node_modules"))
    await writeFile(join(root, "node_modules", "dep.js"), "x")
    await mkdir(join(root, ".git"))
    await writeFile(join(root, ".git", "HEAD"), "ref")
    await writeFile(join(root, "keep.ts"), "x")
    const rels = await collect({ root, skipDirs: DEFAULT_SKIP_DIRS, maxFileBytes: 1e6 })
    expect(rels).toEqual(["keep.ts"])
  })

  it("skips oversized files", async () => {
    await writeFile(join(root, "big.txt"), "abcdefghij")
    await writeFile(join(root, "small.txt"), "ab")
    const rels = await collect({ root, maxFileBytes: 5 })
    expect(rels).toEqual(["small.txt"])
  })

  it("flags lockfiles but still yields them", async () => {
    await writeFile(join(root, "pnpm-lock.yaml"), "lock")
    await writeFile(join(root, "app.ts"), "x")
    const files: Array<{ relPath: string; isLockfile: boolean }> = []
    for await (const f of walkFiles({ root, maxFileBytes: 1e6 })) files.push(f)
    const lock = files.find((f) => f.relPath === "pnpm-lock.yaml")!
    expect(lock.isLockfile).toBe(true)
    expect(files.find((f) => f.relPath === "app.ts")!.isLockfile).toBe(false)
  })

  it("respects a .gitignore matcher", async () => {
    await writeFile(join(root, ".gitignore"), "ignored/\n*.log\n")
    await mkdir(join(root, "ignored"))
    await writeFile(join(root, "ignored", "x.ts"), "x")
    await writeFile(join(root, "app.log"), "x")
    await writeFile(join(root, "keep.ts"), "x")
    const gitignore = await loadGitignore(root)
    const rels = await collect({ root, maxFileBytes: 1e6, gitignore })
    // .gitignore itself is not ignored, keep.ts stays, ignored/ + *.log pruned.
    expect(rels).toEqual([".gitignore", "keep.ts"])
  })

  it("loadGitignore returns undefined when no .gitignore", async () => {
    expect(await loadGitignore(root)).toBeUndefined()
  })

  it("stops promptly when the signal aborts", async () => {
    await writeFile(join(root, "a.ts"), "x")
    const ac = new AbortController()
    ac.abort()
    const rels = await collect({ root, maxFileBytes: 1e6, signal: ac.signal })
    expect(rels).toEqual([])
  })

  it("isBinaryBuffer detects a NUL byte in the first 8KB", () => {
    expect(isBinaryBuffer(Buffer.from([0x61, 0x00, 0x62]))).toBe(true)
    expect(isBinaryBuffer(Buffer.from("plain text"))).toBe(false)
  })
})
