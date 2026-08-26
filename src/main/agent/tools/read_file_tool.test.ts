import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { basename, join } from "path"
import { readFileTool } from "./read_file_tool"
import { truncateForModel } from "./output"

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "read-file-tool-"))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe("read_file_tool", () => {
  it("reads a large file with adjacent continuation metadata", async () => {
    const lines = Array.from({ length: 40_000 }, (_, i) => `row-${i + 1}`)
    await writeFile(join(workspace, "large.txt"), `${lines.join("\n")}\n`)

    const first = await readFileTool.execute(
      { path: "large.txt", offset: 1, limit: 2 },
      { workspace }
    )
    const next = await readFileTool.execute(
      { path: "large.txt", offset: 3, limit: 2 },
      { workspace }
    )

    expect(first).toContain("1\trow-1\n2\trow-2")
    expect(first).toContain('"hasMore":true')
    expect(first).toContain('"nextOffset":3')
    expect(next).toContain("3\trow-3\n4\trow-4")
    expect(next).toContain('"nextOffset":5')

    const final = await readFileTool.execute(
      { path: "large.txt", offset: 39_998, limit: 10 },
      { workspace }
    )
    expect(final).toContain("39998\trow-39998")
    expect(final).toContain("40000\trow-40000")
    expect(final).not.toContain("40001\t")
    expect(final).toContain('"hasMore":false')
  })

  it("caps huge requested limits server-side", async () => {
    await writeFile(join(workspace, "small.txt"), "a\nb\nc")
    const result = await readFileTool.execute(
      { path: "small.txt", limit: 999_999 },
      { workspace }
    )
    expect(result).toContain('"limitCapped":true')
  })

  it("keeps attachment reads behind the exact attachment allowlist", async () => {
    const attached = join(workspace, "attached.txt")
    await writeFile(attached, "hello\nattachment")

    const allowed = await readFileTool.execute(
      { path: basename(attached), limit: 1 },
      { workspace: "", attachments: [attached] }
    )
    const denied = await readFileTool.execute(
      { path: "missing.txt" },
      { workspace: "", attachments: [attached] }
    )

    expect(allowed).toContain("1\thello")
    expect(allowed).toContain('"hasMore":true')
    expect(denied).toContain("ERROR[not_allowed]")
    expect(denied).toContain("not an attached file")
  })

  it("fails closed for binary files", async () => {
    await writeFile(join(workspace, "bin.dat"), Buffer.from([1, 0, 2]))
    const result = await readFileTool.execute(
      { path: "bin.dat" },
      { workspace }
    )
    expect(result).toContain("ERROR[binary]")
  })
})

describe("truncateForModel", () => {
  it("uses caller-owned recovery hints instead of read_file advice", () => {
    const result = truncateForModel("a\nb\nc", {
      maxLines: 1,
      recoveryHint: "rerun command with a narrower filter",
      metadata: { tool: "shell" },
    })
    expect(result.text).toContain("rerun command with a narrower filter")
    expect(result.text).toContain('"tool":"shell"')
    expect(result.text).not.toContain("use read_file with offset")
  })
})
