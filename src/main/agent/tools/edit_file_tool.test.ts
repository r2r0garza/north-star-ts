import { describe, it, expect } from "vitest"
import { editFileTool } from "./edit_file_tool"
import { MUTATION_SOURCE_LIMITS, revisionOfText } from "./file/mutation"
import type { Environment } from "../env/types"
import type { ToolAction } from "../approval/types"

function fakeEnv(): Environment & {
  files: Map<string, string>
  modes: Map<string, number>
  statSizes: Map<string, number>
  readFileCalls: string[]
  failNextChmod: boolean
} {
  const files = new Map<string, string>()
  const modes = new Map<string, number>()
  const statSizes = new Map<string, number>()
  const readFileCalls: string[] = []
  const env = {
    files,
    modes,
    statSizes,
    readFileCalls,
    failNextChmod: false,
    resolve: async (p: string) => p,
    resolveLexical: (p: string) => p,
    readFile: async (p: string) => {
      readFileCalls.push(p)
      const content = files.get(p)
      if (content === undefined) throw new Error("ENOENT")
      return Buffer.from(content, "utf8")
    },
    readTextLines: async () => {
      throw new Error("not implemented")
    },
    writeFile: async (p: string, data: string) => {
      files.set(p, data)
      modes.set(p, 0o644)
    },
    chmod: async (p: string, mode: number) => {
      if (env.failNextChmod) {
        env.failNextChmod = false
        throw new Error(`injected chmod failure for ${p}`)
      }
      modes.set(p, mode & 0o7777)
    },
    rename: async (from: string, to: string) => {
      const content = files.get(from)
      if (content === undefined) throw new Error("ENOENT")
      files.set(to, content)
      const mode = modes.get(from)
      if (mode !== undefined) modes.set(to, mode)
      files.delete(from)
      modes.delete(from)
    },
    removeFile: async (p: string) => {
      files.delete(p)
      modes.delete(p)
    },
    mkdirp: async () => {},
    stat: async (p: string) => {
      if (!files.has(p)) throw new Error("ENOENT")
      return {
        size: statSizes.get(p) ?? Buffer.byteLength(files.get(p) ?? "", "utf8"),
        mode: modes.get(p) ?? 0o644,
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
    spawnCommand: async () => {
      throw new Error("not implemented")
    },
    search: async () => ({
      engine: "rg" as const,
      result: "content" as const,
      matches: [],
      files: [],
      counts: [],
      capped: false,
    }),
    dispose: async () => {},
  }
  return env
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

  it("rejects an oversized source before reading file content", async () => {
    const env = fakeEnv()
    env.files.set("huge.txt", "small placeholder")
    env.statSizes.set("huge.txt", MUTATION_SOURCE_LIMITS.maxFileBytes + 1)

    const result = await editFileTool.execute(
      { path: "huge.txt", old_string: "small", new_string: "large" },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[file_too_large]")
    expect(result).toContain("read_file_tool")
    expect(env.files.get("huge.txt")).toBe("small placeholder")
    expect(env.readFileCalls).toEqual([])
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

  it("leaves the original file intact when staged chmod fails", async () => {
    const env = fakeEnv()
    env.files.set("script.sh", "#!/bin/sh\necho old\n")
    env.modes.set("script.sh", 0o755)
    env.failNextChmod = true

    await expect(
      editFileTool.execute(
        { path: "script.sh", old_string: "old", new_string: "new" },
        { workspace: "/ws", env }
      )
    ).rejects.toThrow("injected chmod failure")

    expect(env.files.get("script.sh")).toBe("#!/bin/sh\necho old\n")
    expect(env.modes.get("script.sh")).toBe(0o755)
    expect([...env.files.keys()].filter((p) => p.includes(".tmp"))).toEqual([])
  })
})
