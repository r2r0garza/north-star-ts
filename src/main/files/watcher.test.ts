import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  watchWorkspaceFiles,
  workspaceRelativePath,
  type WorkspaceFilesChangedEvent,
} from "./watcher"

let root: string
const watches: Array<{ close: () => Promise<void> }> = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "files-watcher-test-"))
})

afterEach(async () => {
  await Promise.all(watches.splice(0).map((watch) => watch.close()))
  await rm(root, { recursive: true, force: true })
})

describe("workspaceRelativePath", () => {
  it("normalizes paths inside the workspace and rejects paths outside it", () => {
    expect(workspaceRelativePath(root, join(root, "src", "file.ts"))).toBe(
      "src/file.ts"
    )
    expect(workspaceRelativePath(root, root)).toBeNull()
    expect(
      workspaceRelativePath(root, join(root, "..", "outside.ts"))
    ).toBeNull()
  })
})

describe("watchWorkspaceFiles", () => {
  it("coalesces file changes into workspace-relative batches", async () => {
    const events: WorkspaceFilesChangedEvent[] = []
    await mkdir(join(root, "src"))
    const watcher = await watchWorkspaceFiles(
      root,
      (event) => events.push(event),
      25
    )
    watches.push(watcher)
    await watcher.updateDirectories(["src"])
    await new Promise((resolve) => setTimeout(resolve, 50))

    await Promise.all([
      writeFile(join(root, "src", "a.ts"), "a"),
      writeFile(join(root, "src", "b.ts"), "b"),
    ])

    await vi.waitFor(
      () => {
        expect(new Set(events.flatMap((event) => event.paths))).toEqual(
          new Set(["src/a.ts", "src/b.ts"])
        )
      },
      { timeout: 3_000 }
    )
    expect(events.every((event) => event.workspace === root)).toBe(true)
  })

  it("does not recursively watch unopened directory trees", async () => {
    const events: WorkspaceFilesChangedEvent[] = []
    await mkdir(join(root, "node_modules", "package"), { recursive: true })
    watches.push(
      await watchWorkspaceFiles(root, (event) => events.push(event), 25)
    )

    await writeFile(
      join(root, "node_modules", "package", "index.js"),
      "changed"
    )
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(events).toEqual([])
  })

  it("ignores git internals", async () => {
    const events: WorkspaceFilesChangedEvent[] = []
    await mkdir(join(root, ".git"))
    watches.push(
      await watchWorkspaceFiles(root, (event) => events.push(event), 25)
    )

    await writeFile(join(root, ".git", "index"), "changed")
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(events).toEqual([])
  })
})
