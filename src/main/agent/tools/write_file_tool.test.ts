import { describe, it, expect, beforeEach } from "vitest"
import { writeFileTool } from "./write_file_tool"
import { MUTATION_SOURCE_LIMITS, revisionOfText } from "./file/mutation"
import type { ToolContext } from "./types"
import type { Environment } from "../env/types"
import type { ToolAction, GateOutcome } from "../approval/types"

// A tiny in-memory Environment so the test exercises mode/append logic and the
// atomic-write orchestration (temp sibling → rename) without touching the host
// filesystem. Only the primitives write_file_tool uses are implemented.
function fakeEnv(): Environment & {
  files: Map<string, string>
  statSizes: Map<string, number>
  readFileCalls: string[]
  failRemove: (path: string) => boolean
} {
  const files = new Map<string, string>()
  const statSizes = new Map<string, number>()
  const readFileCalls: string[] = []
  const enoent = (p: string) =>
    Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
  const env: Environment & {
    files: Map<string, string>
    statSizes: Map<string, number>
    readFileCalls: string[]
    failRemove: (path: string) => boolean
  } = {
    files,
    statSizes,
    readFileCalls,
    failRemove: (_path: string) => false,
    resolve: async (p: string) => p,
    resolveLexical: (p: string) => p,
    readFile: async (p: string) => {
      readFileCalls.push(p)
      const content = files.get(p)
      if (content === undefined) throw enoent(p)
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
      const content = files.get(from)
      if (content === undefined) throw enoent(from)
      files.set(to, content)
      files.delete(from)
    },
    installFileNoReplace: async (from: string, to: string) => {
      const content = files.get(from)
      if (content === undefined) throw enoent(from)
      if (files.has(to)) {
        throw Object.assign(new Error(`EEXIST: ${to}`), { code: "EEXIST" })
      }
      files.set(to, content)
    },
    removeFile: async (p: string) => {
      if (env.failRemove(p)) {
        throw new Error(`injected cleanup failure for ${p}`)
      }
      files.delete(p)
    },
    mkdirp: async () => {},
    stat: async (p: string) => {
      const content = files.get(p)
      if (content === undefined) throw enoent(p)
      return {
        size: statSizes.get(p) ?? Buffer.byteLength(content, "utf8"),
        mode: 0o644,
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

let env: ReturnType<typeof fakeEnv>
let ctx: ToolContext

beforeEach(() => {
  env = fakeEnv()
  ctx = { workspace: "/ws", env }
})

describe("write_file_tool", () => {
  it("rejects skill resource writes before resolving the workspace env", async () => {
    const result = await writeFileTool.execute(
      { path: "skill://demo/template.txt", content: "new" },
      ctx
    )

    expect(result).toContain("ERROR[not_allowed]")
    expect(result).toContain("read-only")
  })

  // staging.md feeds classifyAndDistribute directly, with none of the
  // provenance checks the extraction path applies. A tool write there is an
  // unvalidated door into durable memory.
  it("refuses to write automatic-memory files", async () => {
    const result = await writeFileTool.execute(
      {
        path: "/w/.cowork/skills/memory-recent/staging.md",
        content: "- an invented durable fact",
      },
      ctx
    )

    expect(result).toContain("ERROR[not_allowed]")
    expect(result).toContain("background service")
    expect(env.files.has("/w/.cowork/skills/memory-recent/staging.md")).toBe(
      false
    )
  })

  it("creates a file by default (mode omitted)", async () => {
    const result = await writeFileTool.execute(
      { path: "a.txt", content: "hello" },
      ctx
    )
    expect(result).toContain("Wrote 5 bytes to a.txt.")
    expect(env.files.get("a.txt")).toBe("hello")
  })

  it("treats an empty create revision placeholder as omitted", async () => {
    const result = await writeFileTool.execute(
      {
        path: "a.txt",
        content: "hello",
        mode: "create",
        expected_revision: "",
      },
      ctx
    )

    expect(result).toContain("Wrote 5 bytes to a.txt.")
    expect(env.files.get("a.txt")).toBe("hello")
  })

  it("reports cleanup_failed when a created file leaves its staged temp file", async () => {
    env.failRemove = (path) => path.includes(".north-star-")

    const result = await writeFileTool.execute(
      { path: "a.txt", content: "hello" },
      ctx
    )

    expect(result).toContain("ERROR[cleanup_failed]")
    expect(result).toContain("File content was written to a.txt")
    expect(result).toContain("success cleanup for a.txt")
    expect(result).toContain("injected cleanup failure")
    expect(env.files.get("a.txt")).toBe("hello")
    expect([...env.files.keys()].some((path) => path.includes(".tmp"))).toBe(
      true
    )
  })

  it("rejects an existing file in create mode", async () => {
    env.files.set("a.txt", "old")
    const result = await writeFileTool.execute(
      { path: "a.txt", content: "new", mode: "create" },
      ctx
    )
    expect(result).toContain("ERROR[already_exists]")
    expect(env.files.get("a.txt")).toBe("old")
  })

  it("overwrites an existing file in overwrite mode", async () => {
    env.files.set("a.txt", "old")
    const result = await writeFileTool.execute(
      { path: "a.txt", content: "new", mode: "overwrite" },
      ctx
    )
    expect(result).toContain("Wrote 3 bytes to a.txt.")
    expect(env.files.get("a.txt")).toBe("new")
  })

  it("reports cleanup_failed when an overwritten file leaves its backup", async () => {
    env.files.set("a.txt", "old")
    env.failRemove = (path) => path.includes(".north-star-")

    const result = await writeFileTool.execute(
      { path: "a.txt", content: "new", mode: "overwrite" },
      ctx
    )

    expect(result).toContain("ERROR[cleanup_failed]")
    expect(result).toContain("File content was written to a.txt")
    expect(result).toContain("success cleanup for a.txt")
    expect(env.files.get("a.txt")).toBe("new")
  })

  it("appends onto existing content", async () => {
    env.files.set("a.txt", "part1")
    const result = await writeFileTool.execute(
      { path: "a.txt", content: "part2", mode: "append" },
      ctx
    )
    expect(result).toContain("Appended 5 bytes to a.txt.")
    expect(env.files.get("a.txt")).toBe("part1part2")
  })

  it("rejects an oversized overwrite source before reading file content", async () => {
    env.files.set("huge.txt", "small placeholder")
    env.statSizes.set("huge.txt", MUTATION_SOURCE_LIMITS.maxFileBytes + 1)

    const result = await writeFileTool.execute(
      { path: "huge.txt", content: "new", mode: "overwrite" },
      ctx
    )

    expect(result).toContain("ERROR[file_too_large]")
    expect(result).toContain("read_file_tool")
    expect(env.files.get("huge.txt")).toBe("small placeholder")
    expect(env.readFileCalls).toEqual([])
  })

  it("rejects an oversized append source before reading file content", async () => {
    env.files.set("huge.txt", "small placeholder")
    env.statSizes.set("huge.txt", MUTATION_SOURCE_LIMITS.maxFileBytes + 1)

    const result = await writeFileTool.execute(
      { path: "huge.txt", content: "new", mode: "append" },
      ctx
    )

    expect(result).toContain("ERROR[file_too_large]")
    expect(env.files.get("huge.txt")).toBe("small placeholder")
    expect(env.readFileCalls).toEqual([])
  })

  it("treats append to a missing file as a create (no error)", async () => {
    const result = await writeFileTool.execute(
      { path: "new.txt", content: "first", mode: "append" },
      ctx
    )
    expect(result).toContain("Appended 5 bytes to new.txt.")
    expect(env.files.get("new.txt")).toBe("first")
  })

  it("builds a large file across one create + several append calls", async () => {
    await writeFileTool.execute(
      { path: "big.txt", content: "A", mode: "create" },
      ctx
    )
    await writeFileTool.execute(
      { path: "big.txt", content: "B", mode: "append" },
      ctx
    )
    await writeFileTool.execute(
      { path: "big.txt", content: "C", mode: "append" },
      ctx
    )
    expect(env.files.get("big.txt")).toBe("ABC")
  })

  it("rejects an invalid mode before touching the filesystem", async () => {
    const result = await writeFileTool.execute(
      { path: "a.txt", content: "x", mode: "prepend" },
      ctx
    )
    expect(result).toContain("ERROR[bad_args]")
    expect(env.files.has("a.txt")).toBe(false)
  })

  it("rejects empty revision placeholders for overwrite and append", async () => {
    env.files.set("a.txt", "old")

    const overwrite = await writeFileTool.execute(
      {
        path: "a.txt",
        content: "new",
        mode: "overwrite",
        expected_revision: "",
      },
      ctx
    )
    const append = await writeFileTool.execute(
      {
        path: "a.txt",
        content: "new",
        mode: "append",
        expected_revision: "",
      },
      ctx
    )

    expect(overwrite).toContain("ERROR[bad_args]")
    expect(overwrite).toContain("real revision")
    expect(append).toContain("ERROR[bad_args]")
    expect(append).toContain("real revision")
    expect(env.files.get("a.txt")).toBe("old")
  })

  it("rejects invented create revisions as stale instead of creating the file", async () => {
    const result = await writeFileTool.execute(
      {
        path: "a.txt",
        content: "hello",
        mode: "create",
        expected_revision: "0".repeat(64),
      },
      ctx
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(result).toContain("Current revision: missing")
    expect(env.files.has("a.txt")).toBe(false)
  })

  it("requires a path and string content", async () => {
    expect(await writeFileTool.execute({ content: "x" }, ctx)).toContain(
      "ERROR[bad_args]"
    )
    expect(
      await writeFileTool.execute({ path: "a.txt", content: 5 }, ctx)
    ).toContain("ERROR[bad_args]")
  })

  it("gates on the target path identity for both create and append", async () => {
    const seen: ToolAction[] = []
    const gate = async (action: ToolAction): Promise<GateOutcome> => {
      seen.push(action)
      return "approved"
    }
    const gatedCtx: ToolContext = { workspace: "/ws", env, gate }
    await writeFileTool.execute(
      { path: "a.txt", content: "x", mode: "create" },
      gatedCtx
    )
    await writeFileTool.execute(
      { path: "a.txt", content: "y", mode: "append" },
      gatedCtx
    )
    // Same path → same identity for both calls, so one allowlist approval would
    // cover a whole multi-chunk write rather than re-prompting per chunk.
    expect(seen).toHaveLength(2)
    expect(seen[0].identity).toBe("file_write:a.txt")
    expect(seen[1].identity).toBe("file_write:a.txt")
    expect(seen[0].detail?.diff).toMatchObject({
      path: "a.txt",
      additions: 1,
      deletions: 0,
    })
  })

  it("returns denied when the gate denies", async () => {
    const gate = async (): Promise<GateOutcome> => "denied"
    const result = await writeFileTool.execute(
      { path: "a.txt", content: "x" },
      { workspace: "/ws", env, gate }
    )
    expect(result).toContain("ERROR[denied]")
    expect(env.files.has("a.txt")).toBe(false)
  })

  it("rejects a caller-supplied stale revision before approval", async () => {
    const seen: ToolAction[] = []
    env.files.set("a.txt", "current")
    const result = await writeFileTool.execute(
      {
        path: "a.txt",
        content: "new",
        mode: "overwrite",
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
    env.files.set("a.txt", "old")
    const result = await writeFileTool.execute(
      { path: "a.txt", content: "new", mode: "overwrite" },
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

  it("does not replace a destination concurrently created during create install", async () => {
    env.installFileNoReplace = async () => {
      env.files.set("a.txt", "external")
      throw Object.assign(new Error("EEXIST: a.txt"), { code: "EEXIST" })
    }
    env.rename = async () => {
      throw new Error("rename should not be used for create installs")
    }

    const result = await writeFileTool.execute(
      { path: "a.txt", content: "new", mode: "create" },
      ctx
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(env.files.get("a.txt")).toBe("external")
    expect([...env.files.keys()].filter((p) => p.includes(".tmp"))).toEqual([])
  })

  it("does not replace a destination concurrently created during append-to-missing install", async () => {
    env.installFileNoReplace = async () => {
      env.files.set("a.txt", "external")
      throw Object.assign(new Error("EEXIST: a.txt"), { code: "EEXIST" })
    }
    env.rename = async () => {
      throw new Error(
        "rename should not be used for append-to-missing installs"
      )
    }

    const result = await writeFileTool.execute(
      { path: "a.txt", content: "new", mode: "append" },
      ctx
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(env.files.get("a.txt")).toBe("external")
    expect([...env.files.keys()].filter((p) => p.includes(".tmp"))).toEqual([])
  })

  it("does not overwrite an external change made just before existing-file backup", async () => {
    env.files.set("a.txt", "old")
    const rename = env.rename
    env.rename = async (from, to) => {
      if (from === "a.txt" && to.includes(".north-star-")) {
        env.files.set("a.txt", "external")
      }
      await rename(from, to)
    }

    const result = await writeFileTool.execute(
      { path: "a.txt", content: "new", mode: "overwrite" },
      ctx
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(env.files.get("a.txt")).toBe("external")
    expect([...env.files.keys()].filter((p) => p.includes(".tmp"))).toEqual([])
  })

  it("does not overwrite an external change made after existing-file backup", async () => {
    env.files.set("a.txt", "old")
    env.installFileNoReplace = async () => {
      env.files.set("a.txt", "external")
      throw Object.assign(new Error("EEXIST: a.txt"), { code: "EEXIST" })
    }

    const result = await writeFileTool.execute(
      { path: "a.txt", content: "new", mode: "overwrite" },
      ctx
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(env.files.get("a.txt")).toBe("external")
    expect([...env.files.keys()].filter((p) => p.includes(".tmp"))).toEqual([])
  })

  it("does not treat an unreadable destination as safely absent", async () => {
    env.files.set("a.txt", "old")
    env.readFile = async (p) => {
      if (p === "a.txt") {
        throw Object.assign(new Error("EACCES: a.txt"), { code: "EACCES" })
      }
      const content = env.files.get(p)
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" })
      }
      return Buffer.from(content, "utf8")
    }

    const result = await writeFileTool.execute(
      { path: "a.txt", content: "new", mode: "overwrite" },
      ctx
    )

    expect(result).toContain("ERROR[read_failed]")
    expect(env.files.get("a.txt")).toBe("old")
    expect([...env.files.keys()].filter((p) => p.includes(".tmp"))).toEqual([])
  })

  it("fails closed when the backend lacks a no-replace install primitive", async () => {
    env.installFileNoReplace = undefined

    const result = await writeFileTool.execute(
      { path: "a.txt", content: "new", mode: "create" },
      ctx
    )

    expect(result).toContain("ERROR[stale_file]")
    expect(env.files.has("a.txt")).toBe(false)
    expect([...env.files.keys()].filter((p) => p.includes(".tmp"))).toEqual([])
  })
})
