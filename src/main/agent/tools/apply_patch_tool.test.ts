import { describe, expect, it } from "vitest"
import { applyPatchTool } from "./apply_patch_tool"
import { revisionOfText } from "./file/mutation"
import type { ToolAction } from "../approval/types"
import type { Environment, StatInfo } from "../env/types"

function fakeEnv(): Environment & {
  files: Map<string, string>
  failNextRenameTo?: string
  createBeforeInstallTo?: string
} {
  const files = new Map<string, string>()
  const env = {
    files,
    failNextRenameTo: undefined as string | undefined,
    createBeforeInstallTo: undefined as string | undefined,
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
    chmod: async () => {},
    rename: async (from: string, to: string) => {
      if (env.failNextRenameTo === to) {
        env.failNextRenameTo = undefined
        throw new Error(`injected rename failure for ${to}`)
      }
      const content = files.get(from)
      if (content === undefined) throw new Error("ENOENT")
      files.set(to, content)
      files.delete(from)
    },
    installFileNoReplace: async (from: string, to: string) => {
      if (env.createBeforeInstallTo === to) {
        env.createBeforeInstallTo = undefined
        files.set(to, "external\n")
      }
      const content = files.get(from)
      if (content === undefined) throw new Error("ENOENT")
      if (files.has(to)) throw new Error("EEXIST")
      files.set(to, content)
    },
    removeFile: async (p: string) => {
      files.delete(p)
    },
    mkdirp: async () => {},
    stat: async (p: string): Promise<StatInfo> => {
      const content = files.get(p)
      if (content === undefined) throw new Error("ENOENT")
      return {
        size: Buffer.byteLength(content, "utf8"),
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

describe("apply_patch_tool", () => {
  it("commits mixed add, update, move, and delete operations", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "one\ntwo\n")
    env.files.set("old.txt", "move me\n")
    env.files.set("delete.txt", "remove me\n")

    const result = await applyPatchTool.execute(
      {
        operations: [
          { type: "add", path: "new.txt", content: "created\n" },
          {
            type: "update",
            path: "a.txt",
            hunks: [{ old_string: "two", new_string: "three" }],
          },
          { type: "move", path: "old.txt", new_path: "moved.txt" },
          { type: "delete", path: "delete.txt" },
        ],
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("Applied patch:")
    expect(env.files.get("new.txt")).toBe("created\n")
    expect(env.files.get("a.txt")).toBe("one\nthree\n")
    expect(env.files.get("moved.txt")).toBe("move me\n")
    expect(env.files.has("old.txt")).toBe(false)
    expect(env.files.has("delete.txt")).toBe(false)
  })

  it("passes one combined diff through the approval gate", async () => {
    const env = fakeEnv()
    const seen: ToolAction[] = []
    env.files.set("a.txt", "one\ntwo\n")

    await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "a.txt",
            hunks: [{ old_string: "two", new_string: "three" }],
          },
        ],
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

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      tool: "apply_patch_tool",
      kind: "file_edit",
      identity: "apply_patch:a.txt",
    })
    expect(seen[0].detail?.diff).toMatchObject({
      files: [
        {
          path: "a.txt",
          additions: 1,
          deletions: 1,
          oldRevision: revisionOfText("one\ntwo\n"),
        },
      ],
    })
  })

  it("rejects an invalid hunk before mutating any file", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "one\ntwo\n")
    env.files.set("b.txt", "alpha\n")

    const result = await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "a.txt",
            hunks: [{ old_string: "missing", new_string: "three" }],
          },
          {
            type: "update",
            path: "b.txt",
            hunks: [{ old_string: "alpha", new_string: "beta" }],
          },
        ],
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[no_match]")
    expect(env.files.get("a.txt")).toBe("one\ntwo\n")
    expect(env.files.get("b.txt")).toBe("alpha\n")
  })

  it("rejects a stale revision before approval", async () => {
    const env = fakeEnv()
    const seen: ToolAction[] = []
    env.files.set("a.txt", "current\n")

    const result = await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "a.txt",
            expected_revision: revisionOfText("old\n"),
            hunks: [{ old_string: "current", new_string: "next" }],
          },
        ],
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
    expect(env.files.get("a.txt")).toBe("current\n")
    expect(seen).toHaveLength(0)
  })

  it("rejects a concurrent change after approval without overwriting it", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "old\n")

    const result = await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "a.txt",
            hunks: [{ old_string: "old", new_string: "new" }],
          },
        ],
      },
      {
        workspace: "/ws",
        env,
        gate: async () => {
          env.files.set("a.txt", "external\n")
          return "approved"
        },
      }
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(env.files.get("a.txt")).toBe("external\n")
  })

  it("rolls back files when a commit rename fails", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "old a\n")
    env.files.set("b.txt", "old b\n")
    env.failNextRenameTo = "b.txt"

    const result = await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "a.txt",
            hunks: [{ old_string: "old a", new_string: "new a" }],
          },
          {
            type: "update",
            path: "b.txt",
            hunks: [{ old_string: "old b", new_string: "new b" }],
          },
        ],
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[commit_failed]")
    expect(env.files.get("a.txt")).toBe("old a\n")
    expect(env.files.get("b.txt")).toBe("old b\n")
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("rejects a concurrently-created add destination without deleting it during rollback", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "old a\n")
    env.createBeforeInstallTo = "new.txt"

    const result = await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "a.txt",
            hunks: [{ old_string: "old a", new_string: "new a" }],
          },
          { type: "add", path: "new.txt", content: "created\n" },
        ],
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(env.files.get("a.txt")).toBe("old a\n")
    expect(env.files.get("new.txt")).toBe("external\n")
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("rejects a concurrently-created move destination without overwriting it", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "old a\n")
    env.files.set("old.txt", "move me\n")
    env.createBeforeInstallTo = "moved.txt"

    const result = await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "a.txt",
            hunks: [{ old_string: "old a", new_string: "new a" }],
          },
          { type: "move", path: "old.txt", new_path: "moved.txt" },
        ],
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(env.files.get("a.txt")).toBe("old a\n")
    expect(env.files.get("old.txt")).toBe("move me\n")
    expect(env.files.get("moved.txt")).toBe("external\n")
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })
})
