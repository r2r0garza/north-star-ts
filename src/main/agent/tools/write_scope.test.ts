import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises"
import { existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { LocalEnvironment } from "../env/local"
import { applyPatchTool } from "./apply_patch_tool"
import { editFileTool } from "./edit_file_tool"
import {
  createDirectoryTool,
  deletePathTool,
  movePathTool,
} from "./filesystem_lifecycle_tools"
import { writeFileTool } from "./write_file_tool"
import type { ToolContext } from "./types"

const CHECKS = ".mission-control/checks/f/m/login"
const SCRATCH = ".mission-control/scratch/run-1"

let workspace: string
let external: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "write-scope-ws-"))
  external = await mkdtemp(join(tmpdir(), "write-scope-external-"))
  await mkdir(join(workspace, CHECKS), { recursive: true })
  await mkdir(join(workspace, SCRATCH), { recursive: true })
  await mkdir(join(workspace, "src"))
  await writeFile(join(workspace, "src", "app.ts"), "export const a = 1\n")
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(external, { recursive: true, force: true })
})

// A Mission Control `qa` seat's context (plan 109.01).
const qa = (): ToolContext => ({
  workspace,
  env: new LocalEnvironment(workspace),
  writeScope: { allow: [CHECKS, SCRATCH] },
})
// Any other seat, or an ordinary conversation: no scope.
const unscoped = (): ToolContext => ({
  workspace,
  env: new LocalEnvironment(workspace),
})

const write = (path: string, ctx: ToolContext) =>
  writeFileTool.execute({ path, content: "x\n" }, ctx)

describe("write scope", () => {
  it("lets a qa seat write inside its checks and scratch directories", async () => {
    expect(await write(`${CHECKS}/login.spec.ts`, qa())).not.toContain("ERROR")
    expect(await write(`${CHECKS}/nested/deep.sh`, qa())).not.toContain("ERROR")
    expect(await write(`${SCRATCH}/notes.md`, qa())).not.toContain("ERROR")
    expect(existsSync(join(workspace, CHECKS, "nested", "deep.sh"))).toBe(true)
  })

  it("refuses a qa seat's write to product code and names the allowed directories", async () => {
    const result = await write("src/new.ts", qa())
    expect(result).toContain("ERROR[out_of_scope]")
    expect(result).toContain(`${CHECKS}/`)
    expect(result).toContain(`${SCRATCH}/`)
    expect(existsSync(join(workspace, "src", "new.ts"))).toBe(false)
  })

  it("leaves unscoped turns (builder seats, ordinary conversations) writing anywhere", async () => {
    expect(await write("src/new.ts", unscoped())).not.toContain("ERROR")
    expect(await write("README.md", unscoped())).not.toContain("ERROR")
  })

  it("refuses ../ traversal out of the checks directory", async () => {
    const result = await write(`${CHECKS}/../../../../../src/evil.ts`, qa())
    expect(result).toContain("ERROR[out_of_scope]")
    expect(existsSync(join(workspace, "src", "evil.ts"))).toBe(false)
  })

  it("refuses a symlink inside the checks directory that points out of it", async () => {
    await symlink(join(workspace, "src"), join(workspace, CHECKS, "link"))
    const result = await write(`${CHECKS}/link/evil.ts`, qa())
    expect(result).toContain("ERROR[out_of_scope]")
    expect(existsSync(join(workspace, "src", "evil.ts"))).toBe(false)

    await symlink(
      join(workspace, "src", "app.ts"),
      join(workspace, CHECKS, "app.ts")
    )
    const edit = await editFileTool.execute(
      { path: `${CHECKS}/app.ts`, old_string: "1", new_string: "2" },
      qa()
    )
    expect(edit).toContain("ERROR[out_of_scope]")
    expect(await readFile(join(workspace, "src", "app.ts"), "utf8")).toBe(
      "export const a = 1\n"
    )
  })

  it("grants nothing through an allowed directory that is itself a symlink", async () => {
    await rm(join(workspace, SCRATCH), { recursive: true })
    await symlink(join(workspace, "src"), join(workspace, SCRATCH))
    const result = await write(`${SCRATCH}/evil.ts`, qa())
    expect(result).toContain("ERROR[out_of_scope]")
    expect(existsSync(join(workspace, "src", "evil.ts"))).toBe(false)
  })

  it("scopes edit_file_tool", async () => {
    const result = await editFileTool.execute(
      { path: "src/app.ts", old_string: "1", new_string: "2" },
      qa()
    )
    expect(result).toContain("ERROR[out_of_scope]")
  })

  it("scopes every operation of apply_patch_tool", async () => {
    const result = await applyPatchTool.execute(
      {
        operations: [
          { type: "add", path: `${CHECKS}/ok.sh`, content: "ok\n" },
          {
            type: "update",
            path: "src/app.ts",
            hunks: [{ old_string: "1", new_string: "2" }],
          },
        ],
      },
      qa()
    )
    expect(result).toContain("ERROR[out_of_scope]")
    // All-or-nothing: the in-scope add didn't land either.
    expect(existsSync(join(workspace, CHECKS, "ok.sh"))).toBe(false)

    const inside = await applyPatchTool.execute(
      {
        operations: [
          { type: "add", path: `${CHECKS}/ok.sh`, content: "ok\n" },
          { type: "add", path: `${SCRATCH}/tmp.txt`, content: "t\n" },
        ],
      },
      qa()
    )
    expect(inside).toContain("Applied patch:")
  })

  it("scopes create_directory, move_path, and delete_path", async () => {
    expect(
      await createDirectoryTool.execute({ path: "src/dir" }, qa())
    ).toContain("ERROR[out_of_scope]")
    expect(
      await createDirectoryTool.execute({ path: `${CHECKS}/fixtures` }, qa())
    ).not.toContain("ERROR")

    // Moving product code into the checks directory would remove it.
    expect(
      await movePathTool.execute(
        { from: "src/app.ts", to: `${CHECKS}/app.ts` },
        qa()
      )
    ).toContain("ERROR[out_of_scope]")
    expect(existsSync(join(workspace, "src", "app.ts"))).toBe(true)

    expect(
      await deletePathTool.execute({ path: "src/app.ts" }, qa())
    ).toContain("ERROR[out_of_scope]")
    expect(existsSync(join(workspace, "src", "app.ts"))).toBe(true)

    await writeFile(join(workspace, CHECKS, "old.sh"), "x\n")
    expect(
      await movePathTool.execute(
        { from: `${CHECKS}/old.sh`, to: `${CHECKS}/new.sh` },
        qa()
      )
    ).not.toContain("ERROR")
    expect(
      await deletePathTool.execute({ path: `${CHECKS}/new.sh` }, qa())
    ).not.toContain("ERROR")
  })

  it("lets a qa seat remove a symlink in its directory without following it", async () => {
    await symlink(join(external, "x"), join(workspace, CHECKS, "dangling"))
    const result = await deletePathTool.execute(
      { path: `${CHECKS}/dangling` },
      qa()
    )
    expect(result).not.toContain("out_of_scope")
  })
})
