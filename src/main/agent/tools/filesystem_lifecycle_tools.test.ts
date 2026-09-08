import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  createDirectoryTool,
  deletePathTool,
  movePathTool,
  statPathTool,
} from "./filesystem_lifecycle_tools"
import type { ToolContext } from "./types"
import type { ToolAction } from "../approval/types"

let workspace: string
let external: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "fs-lifecycle-tool-ws-"))
  external = await mkdtemp(join(tmpdir(), "fs-lifecycle-tool-external-"))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(external, { recursive: true, force: true })
})

function metadata(result: string): Record<string, unknown> {
  const marker = "[metadata] "
  const index = result.indexOf(marker)
  if (index < 0) throw new Error(`metadata missing from ${result}`)
  return JSON.parse(result.slice(index + marker.length))
}

describe("filesystem lifecycle tools", () => {
  it("stats files with kind, size, and revision metadata", async () => {
    await writeFile(join(workspace, "note.txt"), "hello")

    const result = await statPathTool.execute(
      { path: "note.txt" },
      { workspace }
    )
    const data = metadata(result)

    expect(result).toContain("Path note.txt is a file.")
    expect(data.kind).toBe("file")
    expect(data.size).toBe(5)
    expect(data.revision).toMatch(/^[a-f0-9]{64}$/)
  })

  it("creates one directory or parent directories explicitly", async () => {
    const shallow = await createDirectoryTool.execute(
      { path: "one" },
      { workspace }
    )
    const nestedMissingParent = await createDirectoryTool.execute(
      { path: "two/child" },
      { workspace }
    )
    const nested = await createDirectoryTool.execute(
      { path: "two/child", parents: true },
      { workspace }
    )

    expect(metadata(shallow).status).toBe("created")
    expect(nestedMissingParent).toContain("ERROR[not_found]")
    expect(metadata(nested).status).toBe("created")
  })

  it("moves files without replacing by default", async () => {
    await writeFile(join(workspace, "from.txt"), "from")
    await writeFile(join(workspace, "exists.txt"), "exists")

    const blocked = await movePathTool.execute(
      { from: "from.txt", to: "exists.txt" },
      { workspace }
    )
    const moved = await movePathTool.execute(
      { from: "from.txt", to: "to.txt" },
      { workspace }
    )

    expect(blocked).toContain("ERROR[already_exists]")
    expect(metadata(moved).status).toBe("moved")
    expect(await readFile(join(workspace, "to.txt"), "utf8")).toBe("from")
  })

  it("overwrites destinations only with an explicit overwrite flag", async () => {
    await writeFile(join(workspace, "from.txt"), "from")
    await writeFile(join(workspace, "to.txt"), "old")

    const result = await movePathTool.execute(
      { from: "from.txt", to: "to.txt", overwrite: true },
      { workspace }
    )

    expect(metadata(result).overwrite).toBe(true)
    expect(await readFile(join(workspace, "to.txt"), "utf8")).toBe("from")
  })

  it("deletes files and requires recursive=true for non-empty directories", async () => {
    await writeFile(join(workspace, "gone.txt"), "x")
    await mkdir(join(workspace, "tree", "child"), { recursive: true })
    await writeFile(join(workspace, "tree", "child", "note.txt"), "x")

    const file = await deletePathTool.execute(
      { path: "gone.txt" },
      { workspace }
    )
    const blockedDir = await deletePathTool.execute(
      { path: "tree" },
      { workspace }
    )
    const deletedDir = await deletePathTool.execute(
      { path: "tree", recursive: true },
      { workspace }
    )

    expect(metadata(file).status).toBe("deleted")
    expect(blockedDir).toContain("ERROR[delete_failed]")
    expect(metadata(deletedDir).status).toBe("deleted")
  })

  it("rejects final-component symlinks instead of deleting or moving their targets", async () => {
    await writeFile(join(external, "sentinel.txt"), "secret")
    await symlink(join(external, "sentinel.txt"), join(workspace, "link.txt"))

    const stat = await statPathTool.execute({ path: "link.txt" }, { workspace })
    const del = await deletePathTool.execute(
      { path: "link.txt" },
      { workspace }
    )
    const move = await movePathTool.execute(
      { from: "link.txt", to: "moved.txt" },
      { workspace }
    )

    expect(stat).toContain("ERROR[not_allowed]")
    expect(del).toContain("ERROR[not_allowed]")
    expect(move).toContain("ERROR[not_allowed]")
    expect(await readFile(join(external, "sentinel.txt"), "utf8")).toBe(
      "secret"
    )
  })

  it("refuses workspace root move and delete operations", async () => {
    const move = await movePathTool.execute(
      { from: ".", to: "elsewhere" },
      { workspace }
    )
    const del = await deletePathTool.execute(
      { path: ".", recursive: true },
      { workspace }
    )

    expect(move).toContain("ERROR[protected_path]")
    expect(del).toContain("ERROR[protected_path]")
  })

  it("routes mutation actions through distinct approval kinds", async () => {
    const seen: ToolAction[] = []
    const ctx: ToolContext = {
      workspace,
      gate: async (action) => {
        seen.push(action)
        return "approved"
      },
    }
    await createDirectoryTool.execute({ path: "dir" }, ctx)
    await writeFile(join(workspace, "dir", "from.txt"), "x")
    await movePathTool.execute({ from: "dir/from.txt", to: "dir/to.txt" }, ctx)
    await deletePathTool.execute({ path: "dir/to.txt" }, ctx)

    expect(seen.map((action) => action.kind)).toEqual([
      "file_mkdir",
      "file_move",
      "file_delete",
    ])
  })
})
