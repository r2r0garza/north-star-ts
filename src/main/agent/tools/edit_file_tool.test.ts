import { describe, it, expect } from "vitest"
import { editFileTool } from "./edit_file_tool"
import { revisionOfText } from "./file/mutation"
import type { Environment } from "../env/types"
import type { ToolAction } from "../approval/types"

function fakeEnv(): Environment & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    resolve: async (p: string) => p,
    resolveLexical: (p: string) => p,
    readFile: async (p: string) => {
      const content = files.get(p)
      if (content === undefined) throw new Error("ENOENT")
      return Buffer.from(content, "utf8")
    },
    readTextLines: async () => {
      throw new Error("not implemented")
    },
    writeFile: async (p: string, data: string) => {
      files.set(p, data)
    },
    rename: async (from: string, to: string) => {
      const content = files.get(from)
      if (content === undefined) throw new Error("ENOENT")
      files.set(to, content)
      files.delete(from)
    },
    removeFile: async (p: string) => {
      files.delete(p)
    },
    mkdirp: async () => {},
    stat: async (p: string) => {
      if (!files.has(p)) throw new Error("ENOENT")
      return {
        size: Buffer.byteLength(files.get(p) ?? "", "utf8"),
        isFile: () => true,
        isDirectory: () => false,
      }
    },
    readdir: async () => [],
    exec: async () => ({
      stdout: Buffer.alloc(0),
      exitCode: 0,
      signal: null,
      timedOut: false,
    }),
    search: async () => ({ matches: [], capped: false }),
    dispose: async () => {},
  }
}

describe("edit_file_tool", () => {
  it("passes diff preview metadata through the approval gate", async () => {
    const env = fakeEnv()
    const seen: ToolAction[] = []
    env.files.set("a.txt", "one\ntwo\n")
    const result = await editFileTool.execute(
      { path: "a.txt", old_string: "two", new_string: "three" },
      {
        workspace: "/ws",
        env,
        gate: async (action) => {
          seen.push(action)
          return "approved"
        },
      }
    )
    expect(result).toContain("Replaced 1 occurrence in a.txt.")
    expect(seen[0].detail?.diff).toMatchObject({
      path: "a.txt",
      additions: 1,
      deletions: 1,
      oldRevision: revisionOfText("one\ntwo\n"),
    })
  })

  it("rejects a caller-supplied stale revision before approval", async () => {
    const env = fakeEnv()
    const seen: ToolAction[] = []
    env.files.set("a.txt", "current")
    const result = await editFileTool.execute(
      {
        path: "a.txt",
        old_string: "current",
        new_string: "next",
        expected_revision: revisionOfText("old"),
      },
      {
        workspace: "/ws",
        env,
        gate: async (action) => {
          seen.push(action)
          return "approved"
        },
      }
    )
    expect(result).toContain("ERROR[stale_file]")
    expect(env.files.get("a.txt")).toBe("current")
    expect(seen).toHaveLength(0)
  })

  it("rejects a concurrent change while waiting for approval", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "old")
    const result = await editFileTool.execute(
      { path: "a.txt", old_string: "old", new_string: "new" },
      {
        workspace: "/ws",
        env,
        gate: async () => {
          env.files.set("a.txt", "external")
          return "approved"
        },
      }
    )
    expect(result).toContain("ERROR[stale_file]")
    expect(env.files.get("a.txt")).toBe("external")
    expect([...env.files.keys()].filter((p) => p.includes(".tmp"))).toEqual([])
  })
})
