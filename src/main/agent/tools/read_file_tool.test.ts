import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises"
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
  it("reads activated skill resources with exact path casing", async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), "skill-resource-"))
    try {
      await mkdir(join(skillRoot, "References"), { recursive: true })
      await writeFile(join(skillRoot, "References", "Template.txt"), "hello\n")

      const allowed = await readFileTool.execute(
        { path: "skill://demo/References/Template.txt" },
        {
          workspace,
          skillResourceRoots: { demo: skillRoot },
        }
      )
      const wrongCase = await readFileTool.execute(
        { path: "skill://demo/references/Template.txt" },
        {
          workspace,
          skillResourceRoots: { demo: skillRoot },
        }
      )

      expect(allowed).toContain("1\thello")
      expect(wrongCase).toContain("ERROR[not_allowed]")
    } finally {
      await rm(skillRoot, { recursive: true, force: true })
    }
  })

  it("rejects inactive, traversal, absolute, and symlink-escaping skill resources", async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), "skill-resource-"))
    const outside = await mkdtemp(join(tmpdir(), "skill-resource-outside-"))
    try {
      await writeFile(join(outside, "secret.txt"), "secret\n")
      await symlink(outside, join(skillRoot, "outside"))

      const inactive = await readFileTool.execute(
        { path: "skill://missing/template.txt" },
        { workspace, skillResourceRoots: { demo: skillRoot } }
      )
      const traversal = await readFileTool.execute(
        { path: "skill://demo/../secret.txt" },
        { workspace, skillResourceRoots: { demo: skillRoot } }
      )
      const absolute = await readFileTool.execute(
        { path: "skill://demo/%2Ftmp%2Fsecret.txt" },
        { workspace, skillResourceRoots: { demo: skillRoot } }
      )
      const symlinkEscape = await readFileTool.execute(
        { path: "skill://demo/outside/secret.txt" },
        { workspace, skillResourceRoots: { demo: skillRoot } }
      )

      expect(inactive).toContain("ERROR[not_allowed]")
      expect(traversal).toContain("ERROR[not_allowed]")
      expect(absolute).toContain("ERROR[not_allowed]")
      expect(symlinkEscape).toContain("ERROR[not_allowed]")
      expect(symlinkEscape).not.toContain("secret")
    } finally {
      await rm(skillRoot, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

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

    // Content lines carry the untrusted-data prefix from the trust envelope.
    expect(first).toContain("DATA: 1\trow-1\nDATA: 2\trow-2")
    expect(first).toContain('"hasMore":true')
    expect(first).toContain('"nextOffset":3')
    expect(next).toContain("DATA: 3\trow-3\nDATA: 4\trow-4")
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

  it("exposes an advancing cursor for oversized attachment lines", async () => {
    const attached = join(workspace, "long-attachment.txt")
    await writeFile(attached, `${"日本語".repeat(100_000)}\nsecond`)

    const first = await readFileTool.execute(
      { path: basename(attached), offset: 1 },
      { workspace: "", attachments: [attached] }
    )
    const next = await readFileTool.execute(
      { path: basename(attached), offset: 2 },
      { workspace: "", attachments: [attached] }
    )

    expect(first).toContain('"hasMore":true')
    expect(first).toContain('"nextOffset":2')
    expect(first).toContain('"lineTooLong":true')
    expect(first).toContain('"skippedLineRemainder":true')
    expect(first).not.toContain("�")
    expect(next).toContain("2\tsecond")
    expect(next).toContain('"hasMore":false')
  })

  it("fails closed for binary files", async () => {
    await writeFile(join(workspace, "bin.dat"), Buffer.from([1, 0, 2]))
    const result = await readFileTool.execute(
      { path: "bin.dat" },
      { workspace }
    )
    expect(result).toContain("ERROR[binary]")
  })

  it("recommends read_document for supported binary documents", async () => {
    await writeFile(join(workspace, "sample.pdf"), Buffer.from([0, 1, 0]))
    const result = await readFileTool.execute(
      { path: "sample.pdf" },
      { workspace }
    )

    expect(result).toContain("ERROR[binary]")
    expect(result).toContain("Use read_document")
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
