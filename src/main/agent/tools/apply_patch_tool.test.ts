import { describe, expect, it } from "vitest"
import { applyPatchTool } from "./apply_patch_tool"
import { revisionOfText } from "./file/mutation"
import type { ToolAction } from "../approval/types"
import type { Environment, StatInfo } from "../env/types"

function fakeEnv(): Environment & {
  files: Map<string, string>
  modes: Map<string, number>
  renameCalls: Array<{ from: string; to: string }>
  renameAttempts: Array<{ from: string; to: string }>
  failRename?: (from: string, to: string) => boolean
  failNextRenameTo?: string
  failNextChmod: boolean
  failRemove?: (path: string) => boolean
  createBeforeInstallTo?: string
  onWriteFile?: (path: string) => void
} {
  const files = new Map<string, string>()
  const modes = new Map<string, number>()
  const renameCalls: Array<{ from: string; to: string }> = []
  const renameAttempts: Array<{ from: string; to: string }> = []
  const env = {
    files,
    modes,
    renameCalls,
    renameAttempts,
    failRename: undefined as
      | undefined
      | ((from: string, to: string) => boolean),
    failNextRenameTo: undefined as string | undefined,
    failNextChmod: false,
    failRemove: undefined as undefined | ((path: string) => boolean),
    createBeforeInstallTo: undefined as string | undefined,
    onWriteFile: undefined as undefined | ((path: string) => void),
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
      if (!modes.has(p)) modes.set(p, 0o644)
      env.onWriteFile?.(p)
    },
    chmod: async (p: string, mode: number) => {
      if (!files.has(p)) throw new Error("ENOENT")
      if (env.failNextChmod) {
        env.failNextChmod = false
        throw new Error(`injected chmod failure for ${p}`)
      }
      modes.set(p, mode & 0o7777)
    },
    rename: async (from: string, to: string) => {
      renameAttempts.push({ from, to })
      if (env.failRename?.(from, to)) {
        throw new Error(`injected rename failure from ${from} to ${to}`)
      }
      if (env.failNextRenameTo === to) {
        env.failNextRenameTo = undefined
        throw new Error(`injected rename failure for ${to}`)
      }
      const content = files.get(from)
      if (content === undefined) throw new Error("ENOENT")
      files.set(to, content)
      const mode = modes.get(from)
      if (mode !== undefined) modes.set(to, mode)
      else modes.delete(to)
      files.delete(from)
      modes.delete(from)
      renameCalls.push({ from, to })
    },
    installFileNoReplace: async (from: string, to: string) => {
      if (env.createBeforeInstallTo === to) {
        env.createBeforeInstallTo = undefined
        files.set(to, "external\n")
        modes.set(to, 0o644)
      }
      const content = files.get(from)
      if (content === undefined) throw new Error("ENOENT")
      if (files.has(to)) throw new Error("EEXIST")
      files.set(to, content)
      const mode = modes.get(from)
      if (mode !== undefined) modes.set(to, mode)
      else modes.delete(to)
    },
    removeFile: async (p: string) => {
      if (env.failRemove?.(p)) {
        throw new Error(`injected remove failure for ${p}`)
      }
      files.delete(p)
      modes.delete(p)
    },
    mkdirp: async () => {},
    stat: async (p: string): Promise<StatInfo> => {
      const content = files.get(p)
      if (content === undefined) throw new Error("ENOENT")
      return {
        size: Buffer.byteLength(content, "utf8"),
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

  it("rejects a concurrent mode change after approval without overwriting it", async () => {
    const env = fakeEnv()
    env.files.set("script.sh", "#!/bin/sh\necho old\n")
    env.modes.set("script.sh", 0o644)

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
        workspace: "/ws",
        env,
        gate: async () => {
          env.modes.set("script.sh", 0o755)
          return "approved"
        },
      }
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(result).toContain("Current mode: 755")
    expect(env.files.get("script.sh")).toBe("#!/bin/sh\necho old\n")
    expect(env.modes.get("script.sh")).toBe(0o755)
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("rejects a content change during patch staging before any backup rename", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "old a\n")
    env.files.set("b.txt", "old b\n")
    let stagedWrites = 0
    env.onWriteFile = (path) => {
      if (!path.includes(".north-star-")) return
      stagedWrites += 1
      if (stagedWrites === 2) {
        env.files.set("a.txt", "external a\n")
      }
    }

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

    expect(result).toContain("ERROR[stale_file]")
    expect(env.renameCalls).toEqual([])
    expect(env.files.get("a.txt")).toBe("external a\n")
    expect(env.files.get("b.txt")).toBe("old b\n")
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("rejects a mode change during patch staging before any backup rename", async () => {
    const env = fakeEnv()
    env.files.set("a.sh", "#!/bin/sh\necho old a\n")
    env.files.set("b.sh", "#!/bin/sh\necho old b\n")
    env.modes.set("a.sh", 0o644)
    env.modes.set("b.sh", 0o644)
    let stagedWrites = 0
    env.onWriteFile = (path) => {
      if (!path.includes(".north-star-")) return
      stagedWrites += 1
      if (stagedWrites === 2) {
        env.modes.set("a.sh", 0o755)
      }
    }

    const result = await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "a.sh",
            hunks: [{ old_string: "old a", new_string: "new a" }],
          },
          {
            type: "update",
            path: "b.sh",
            hunks: [{ old_string: "old b", new_string: "new b" }],
          },
        ],
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(result).toContain("Current mode: 755")
    expect(env.renameCalls).toEqual([])
    expect(env.files.get("a.sh")).toBe("#!/bin/sh\necho old a\n")
    expect(env.files.get("b.sh")).toBe("#!/bin/sh\necho old b\n")
    expect(env.modes.get("a.sh")).toBe(0o755)
    expect(env.modes.get("b.sh")).toBe(0o644)
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("rejects a concurrent source mode change before moving with hunks", async () => {
    const env = fakeEnv()
    env.files.set("old.sh", "#!/bin/sh\necho old\n")
    env.modes.set("old.sh", 0o644)

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
        workspace: "/ws",
        env,
        gate: async () => {
          env.modes.set("old.sh", 0o755)
          return "approved"
        },
      }
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(env.files.get("old.sh")).toBe("#!/bin/sh\necho old\n")
    expect(env.modes.get("old.sh")).toBe(0o755)
    expect(env.files.has("new.sh")).toBe(false)
    expect(env.modes.has("new.sh")).toBe(false)
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("rejects a moved source content change during staging before any backup rename", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "old a\n")
    env.files.set("old.txt", "move old\n")
    let stagedWrites = 0
    env.onWriteFile = (path) => {
      if (!path.includes(".north-star-")) return
      stagedWrites += 1
      if (stagedWrites === 2) {
        env.files.set("old.txt", "external move\n")
      }
    }

    const result = await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "a.txt",
            hunks: [{ old_string: "old a", new_string: "new a" }],
          },
          {
            type: "move",
            path: "old.txt",
            new_path: "z.txt",
            hunks: [{ old_string: "old", new_string: "new" }],
          },
        ],
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(env.renameCalls).toEqual([])
    expect(env.files.get("a.txt")).toBe("old a\n")
    expect(env.files.get("old.txt")).toBe("external move\n")
    expect(env.files.has("z.txt")).toBe(false)
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("preserves unchanged modes when applying an approved patch", async () => {
    const env = fakeEnv()
    env.files.set("script.sh", "#!/bin/sh\necho old\n")
    env.modes.set("script.sh", 0o755)

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
        workspace: "/ws",
        env,
        gate: async () => "approved",
      }
    )

    expect(result).toContain("Applied patch:")
    expect(env.files.get("script.sh")).toBe("#!/bin/sh\necho new\n")
    expect(env.modes.get("script.sh")).toBe(0o755)
  })

  it("commits normally when final validation sees no staging-time changes", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "old a\n")
    env.files.set("b.txt", "old b\n")

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

    expect(result).toContain("Applied patch:")
    expect(env.files.get("a.txt")).toBe("new a\n")
    expect(env.files.get("b.txt")).toBe("new b\n")
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("removes a staged file when writing it persists content and then fails", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "old\n")
    env.modes.set("a.txt", 0o644)
    env.onWriteFile = (path) => {
      if (path.includes(".north-star-")) {
        throw new Error("injected write failure after persist")
      }
    }

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
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[commit_failed]")
    expect(result).toContain("injected write failure after persist")
    expect(env.files.get("a.txt")).toBe("old\n")
    expect(env.modes.get("a.txt")).toBe(0o644)
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("removes a staged file when preserving its mode fails", async () => {
    const env = fakeEnv()
    env.files.set("script.sh", "#!/bin/sh\necho old\n")
    env.modes.set("script.sh", 0o755)
    env.failNextChmod = true

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
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[commit_failed]")
    expect(result).toContain("injected chmod failure")
    expect(env.files.get("script.sh")).toBe("#!/bin/sh\necho old\n")
    expect(env.modes.get("script.sh")).toBe(0o755)
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("removes every staged file when writing a later entry fails", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "old a\n")
    env.files.set("b.txt", "old b\n")
    env.modes.set("a.txt", 0o600)
    env.modes.set("b.txt", 0o640)
    let stagedWrites = 0
    env.onWriteFile = (path) => {
      if (!path.includes(".north-star-")) return
      stagedWrites += 1
      if (stagedWrites === 2) {
        throw new Error("injected later write failure after persist")
      }
    }

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
    expect(env.modes.get("a.txt")).toBe(0o600)
    expect(env.modes.get("b.txt")).toBe(0o640)
    expect(env.renameCalls).toEqual([])
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("does not restore nonexistent backups when the first backup rename fails", async () => {
    const env = fakeEnv()
    for (const [path, mode] of [
      ["a.txt", 0o600],
      ["b.txt", 0o640],
      ["c.txt", 0o644],
    ] as const) {
      env.files.set(path, `old ${path[0]}\n`)
      env.modes.set(path, mode)
    }
    env.failRename = (from) => from === "a.txt"

    const result = await applyPatchTool.execute(
      {
        operations: ["a", "b", "c"].map((name) => ({
          type: "update" as const,
          path: `${name}.txt`,
          hunks: [{ old_string: `old ${name}`, new_string: `new ${name}` }],
        })),
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[commit_failed]")
    expect(result).not.toContain("ERROR[rollback_failed]")
    expect(env.renameAttempts).toHaveLength(1)
    expect(env.renameAttempts[0]).toMatchObject({ from: "a.txt" })
    expect(
      env.renameAttempts.some(({ to }) =>
        ["a.txt", "b.txt", "c.txt"].includes(to)
      )
    ).toBe(false)
    expect(env.files.get("a.txt")).toBe("old a\n")
    expect(env.files.get("b.txt")).toBe("old b\n")
    expect(env.files.get("c.txt")).toBe("old c\n")
    expect(env.modes.get("a.txt")).toBe(0o600)
    expect(env.modes.get("b.txt")).toBe(0o640)
    expect(env.modes.get("c.txt")).toBe(0o644)
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("restores only completed backups when a middle backup rename fails", async () => {
    const env = fakeEnv()
    for (const [path, mode] of [
      ["a.txt", 0o600],
      ["b.txt", 0o640],
      ["c.txt", 0o644],
    ] as const) {
      env.files.set(path, `old ${path[0]}\n`)
      env.modes.set(path, mode)
    }
    env.failRename = (from) => from === "b.txt"

    const result = await applyPatchTool.execute(
      {
        operations: ["a", "b", "c"].map((name) => ({
          type: "update" as const,
          path: `${name}.txt`,
          hunks: [{ old_string: `old ${name}`, new_string: `new ${name}` }],
        })),
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[commit_failed]")
    expect(result).not.toContain("ERROR[rollback_failed]")
    expect(env.renameAttempts.map(({ from }) => from)).toEqual([
      "a.txt",
      "b.txt",
      expect.stringContaining(".north-star-"),
    ])
    expect(env.renameAttempts[2]).toMatchObject({ to: "a.txt" })
    expect(
      env.renameAttempts.some(
        ({ from, to }) => from === "c.txt" || to === "b.txt" || to === "c.txt"
      )
    ).toBe(false)
    expect(env.files.get("a.txt")).toBe("old a\n")
    expect(env.files.get("b.txt")).toBe("old b\n")
    expect(env.files.get("c.txt")).toBe("old c\n")
    expect(env.modes.get("a.txt")).toBe(0o600)
    expect(env.modes.get("b.txt")).toBe(0o640)
    expect(env.modes.get("c.txt")).toBe(0o644)
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("reports rollback_failed when restoring a completed backup fails", async () => {
    const env = fakeEnv()
    env.files.set("a.txt", "old a\n")
    env.modes.set("a.txt", 0o600)
    let backedUp = false
    env.failRename = (from, to) => {
      if (from === "a.txt") {
        backedUp = true
        return false
      }
      return backedUp && to === "a.txt"
    }

    const result = await applyPatchTool.execute(
      {
        operations: [
          {
            type: "update",
            path: "a.txt",
            hunks: [{ old_string: "old a", new_string: "new a" }],
          },
        ],
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[rollback_failed]")
    expect(result).toContain("injected rename failure")
    expect(env.renameAttempts).toHaveLength(3)
    expect(env.renameAttempts[2]).toMatchObject({ to: "a.txt" })
    expect(env.files.has("a.txt")).toBe(false)
    const temporaryFiles = [...env.files.entries()].filter(([path]) =>
      path.includes(".north-star-")
    )
    expect(temporaryFiles).toHaveLength(1)
    expect(temporaryFiles[0]?.[1]).toBe("old a\n")
    expect(env.modes.get(temporaryFiles[0]![0])).toBe(0o600)
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

  it("reports rollback_failed when removing an installed add destination fails", async () => {
    const env = fakeEnv()
    env.files.set("z.txt", "old z\n")
    env.failNextRenameTo = "z.txt"
    env.failRemove = (path) => path === "a.txt"

    const result = await applyPatchTool.execute(
      {
        operations: [
          { type: "add", path: "a.txt", content: "created\n" },
          {
            type: "update",
            path: "z.txt",
            hunks: [{ old_string: "old z", new_string: "new z" }],
          },
        ],
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[rollback_failed]")
    expect(result).toContain("remove_failed:a.txt")
    expect(result).toContain("injected remove failure for a.txt")
    expect(env.files.get("a.txt")).toBe("created\n")
    expect(env.files.get("z.txt")).toBe("old z\n")
    expect(
      [...env.files.keys()].filter((p) => p.includes(".north-star-"))
    ).toEqual([])
  })

  it("reports rollback_failed when removing an installed move destination fails", async () => {
    const env = fakeEnv()
    env.files.set("old.txt", "move me\n")
    env.files.set("z.txt", "old z\n")
    env.failNextRenameTo = "z.txt"
    env.failRemove = (path) => path === "a-moved.txt"

    const result = await applyPatchTool.execute(
      {
        operations: [
          { type: "move", path: "old.txt", new_path: "a-moved.txt" },
          {
            type: "update",
            path: "z.txt",
            hunks: [{ old_string: "old z", new_string: "new z" }],
          },
        ],
      },
      { workspace: "/ws", env }
    )

    expect(result).toContain("ERROR[rollback_failed]")
    expect(result).toContain("remove_failed:a-moved.txt")
    expect(result).toContain("injected remove failure for a-moved.txt")
    expect(env.files.get("a-moved.txt")).toBe("move me\n")
    expect(env.files.get("old.txt")).toBe("move me\n")
    expect(env.files.get("z.txt")).toBe("old z\n")
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
