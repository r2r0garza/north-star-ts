import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { chmod, mkdtemp, rm, stat, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { LocalEnvironment } from "../env/local"
import { applyPatchTool } from "./apply_patch_tool"
import { editFileTool } from "./edit_file_tool"
import { writeFileTool } from "./write_file_tool"
import type { ToolContext } from "./types"

const executableMode = 0o755
const modeBits = async (path: string) => (await stat(path)).mode & 0o7777

describe.skipIf(process.platform === "win32")(
  "file mutation mode preservation",
  () => {
    let workspace: string
    let ctx: ToolContext

    beforeEach(async () => {
      workspace = await mkdtemp(join(tmpdir(), "mode-mutation-"))
      ctx = { workspace, env: new LocalEnvironment(workspace) }
    })

    afterEach(async () => {
      await rm(workspace, { recursive: true, force: true })
    })

    async function makeExecutable(path: string, content: string) {
      const fullPath = join(workspace, path)
      await writeFile(fullPath, content, "utf8")
      await chmod(fullPath, executableMode)
      return fullPath
    }

    it("preserves executable bits when edit_file_tool updates a file", async () => {
      const target = await makeExecutable("script.sh", "#!/bin/sh\necho old\n")

      const result = await editFileTool.execute(
        {
          path: "script.sh",
          old_string: "old",
          new_string: "new",
        },
        ctx
      )

      expect(result).toContain("Replaced 1 occurrence")
      expect(await modeBits(target)).toBe(executableMode)
    })

    it("preserves executable bits when write_file_tool overwrites a file", async () => {
      const target = await makeExecutable("script.sh", "#!/bin/sh\necho old\n")

      const result = await writeFileTool.execute(
        {
          path: "script.sh",
          content: "#!/bin/sh\necho new\n",
          mode: "overwrite",
        },
        ctx
      )

      expect(result).toContain("Wrote")
      expect(await modeBits(target)).toBe(executableMode)
    })

    it("preserves executable bits when write_file_tool appends to a file", async () => {
      const target = await makeExecutable("script.sh", "#!/bin/sh\n")

      const result = await writeFileTool.execute(
        {
          path: "script.sh",
          content: "echo appended\n",
          mode: "append",
        },
        ctx
      )

      expect(result).toContain("Appended")
      expect(await modeBits(target)).toBe(executableMode)
    })

    it("preserves executable bits when apply_patch_tool updates a file", async () => {
      const target = await makeExecutable("script.sh", "#!/bin/sh\necho old\n")

      const result = await applyPatchTool.execute(
        {
          operations: [
            {
              type: "update",
              path: "script.sh",
              hunks: [{ old_string: "old", new_string: "new" }],
            },
          ],
        },
        ctx
      )

      expect(result).toContain("Applied patch")
      expect(await modeBits(target)).toBe(executableMode)
    })

    it("rejects a concurrent mode change when apply_patch_tool updates a file", async () => {
      const target = join(workspace, "script.sh")
      await writeFile(target, "#!/bin/sh\necho old\n", "utf8")
      await chmod(target, 0o644)

      const result = await applyPatchTool.execute(
        {
          operations: [
            {
              type: "update",
              path: "script.sh",
              hunks: [{ old_string: "old", new_string: "new" }],
            },
          ],
        },
        {
          ...ctx,
          gate: async () => {
            await chmod(target, executableMode)
            return "approved"
          },
        }
      )

      expect(result).toContain("ERROR[stale_file]")
      expect(await modeBits(target)).toBe(executableMode)
    })

    it("preserves source executable bits when apply_patch_tool moves a file with hunks", async () => {
      const source = await makeExecutable("old.sh", "#!/bin/sh\necho old\n")
      const destination = join(workspace, "new.sh")

      const result = await applyPatchTool.execute(
        {
          operations: [
            {
              type: "move",
              path: "old.sh",
              new_path: "new.sh",
              hunks: [{ old_string: "old", new_string: "new" }],
            },
          ],
        },
        ctx
      )

      expect(result).toContain("Applied patch")
      await expect(stat(source)).rejects.toThrow()
      expect(await modeBits(destination)).toBe(executableMode)
    })

    it("rejects a concurrent source mode change when apply_patch_tool moves a file with hunks", async () => {
      const source = join(workspace, "old.sh")
      const destination = join(workspace, "new.sh")
      await writeFile(source, "#!/bin/sh\necho old\n", "utf8")
      await chmod(source, 0o644)

      const result = await applyPatchTool.execute(
        {
          operations: [
            {
              type: "move",
              path: "old.sh",
              new_path: "new.sh",
              hunks: [{ old_string: "old", new_string: "new" }],
            },
          ],
        },
        {
          ...ctx,
          gate: async () => {
            await chmod(source, executableMode)
            return "approved"
          },
        }
      )

      expect(result).toContain("ERROR[stale_file]")
      expect(await modeBits(source)).toBe(executableMode)
      await expect(stat(destination)).rejects.toThrow()
    })

    it("uses the backend default mode for newly-added files", async () => {
      await makeExecutable("source.sh", "#!/bin/sh\necho source\n")
      const target = join(workspace, "added.txt")
      const expectedDefaultMode = 0o666 & ~process.umask()

      const result = await applyPatchTool.execute(
        {
          operations: [
            {
              type: "add",
              path: "added.txt",
              content: "created\n",
            },
          ],
        },
        ctx
      )

      expect(result).toContain("Applied patch")
      expect(await modeBits(target)).toBe(expectedDefaultMode)
      expect(await modeBits(target)).not.toBe(executableMode)
    })
  }
)
