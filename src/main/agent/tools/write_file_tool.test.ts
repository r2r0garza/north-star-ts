import { describe, it, expect, beforeEach } from "vitest"
import { writeFileTool } from "./write_file_tool"
import type { ToolContext } from "./types"
import type { Environment } from "../env/types"
import type { ToolAction, GateOutcome } from "../approval/types"

// A tiny in-memory Environment so the test exercises mode/append logic and the
// atomic-write orchestration (temp sibling → rename) without touching the host
// filesystem. Only the primitives write_file_tool uses are implemented.
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
    mkdirp: async () => {},
    stat: async () => {
      throw new Error("not implemented")
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

let env: ReturnType<typeof fakeEnv>
let ctx: ToolContext

beforeEach(() => {
  env = fakeEnv()
  ctx = { workspace: "/ws", env }
})

describe("write_file_tool", () => {
  it("creates a file by default (mode omitted)", async () => {
    const result = await writeFileTool.execute(
      { path: "a.txt", content: "hello" },
      ctx
    )
    expect(result).toBe("Wrote 5 bytes to a.txt.")
    expect(env.files.get("a.txt")).toBe("hello")
  })

  it("overwrites an existing file in create mode", async () => {
    env.files.set("a.txt", "old")
    await writeFileTool.execute(
      { path: "a.txt", content: "new", mode: "create" },
      ctx
    )
    expect(env.files.get("a.txt")).toBe("new")
  })

  it("appends onto existing content", async () => {
    env.files.set("a.txt", "part1")
    const result = await writeFileTool.execute(
      { path: "a.txt", content: "part2", mode: "append" },
      ctx
    )
    expect(result).toBe("Appended 5 bytes to a.txt.")
    expect(env.files.get("a.txt")).toBe("part1part2")
  })

  it("treats append to a missing file as a create (no error)", async () => {
    const result = await writeFileTool.execute(
      { path: "new.txt", content: "first", mode: "append" },
      ctx
    )
    expect(result).toBe("Appended 5 bytes to new.txt.")
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
})
