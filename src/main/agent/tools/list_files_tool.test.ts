import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { listFilesTool } from "./list_files_tool"

let workspace: string
let external: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "list-files-tool-ws-"))
  external = await mkdtemp(join(tmpdir(), "list-files-tool-external-"))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(external, { recursive: true, force: true })
})

describe("list_files_tool", () => {
  it("lists ordinary in-workspace directories", async () => {
    await mkdir(join(workspace, "src"), { recursive: true })
    await writeFile(join(workspace, "src", "index.ts"), "export {}\n")

    const result = await listFilesTool.execute(
      { path: "src" },
      { workspace }
    )

    expect(result).toContain("index.ts")
  })

  it("rejects workspace symlinks to external directories without listing names", async () => {
    await writeFile(join(external, "external-sentinel.txt"), "secret\n")
    await symlink(external, join(workspace, "outside"))

    await expect(
      listFilesTool.execute({ path: "outside" }, { workspace })
    ).rejects.toThrow(/outside the workspace/)

    await expect(
      listFilesTool.execute({ path: "outside" }, { workspace })
    ).rejects.not.toThrow(/external-sentinel/)
  })

  it("lists workspace symlinks that resolve inside the workspace", async () => {
    await mkdir(join(workspace, "actual"), { recursive: true })
    await writeFile(join(workspace, "actual", "inside.txt"), "ok\n")
    await symlink(join(workspace, "actual"), join(workspace, "link"))

    const result = await listFilesTool.execute(
      { path: "link" },
      { workspace }
    )

    expect(result).toContain("inside.txt")
  })
})
