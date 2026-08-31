import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { listFilesTool } from "./list_files_tool"
import type { DirEntry, Environment, ListDirResult } from "../env/types"

let workspace: string
let external: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "list-files-tool-ws-"))
  external = await mkdtemp(join(tmpdir(), "list-files-tool-external-"))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(external, { recursive: true, force: true })
})

describe("list_files_tool", () => {
  it("lists ordinary in-workspace directories", async () => {
    await mkdir(join(workspace, "src"), { recursive: true })
    await writeFile(join(workspace, "src", "index.ts"), "export {}\n")

    const result = await listFilesTool.execute({ path: "src" }, { workspace })

    expect(result).toContain('"index.ts"')
  })

  it("lists activated skill resource directories", async () => {
    const skillRoot = await mkdtemp(join(tmpdir(), "list-skill-resource-"))
    try {
      await mkdir(join(skillRoot, "references"), { recursive: true })
      await writeFile(join(skillRoot, "references", "template.html"), "")

      const result = await listFilesTool.execute(
        { path: "skill://dashboard/references" },
        { workspace, skillResourceRoots: { dashboard: skillRoot } }
      )

      expect(result).toContain('"template.html"')
    } finally {
      await rm(skillRoot, { recursive: true, force: true })
    }
  })

  it("rejects workspace symlinks to external directories without listing names", async () => {
    await writeFile(join(external, "external-sentinel.txt"), "secret\n")
    await symlink(external, join(workspace, "outside"))

    const result = await listFilesTool.execute(
      { path: "outside" },
      { workspace }
    )

    expect(result).toContain("ERROR[not_allowed]")
    expect(result).toContain("outside the workspace")
    expect(result).not.toContain("external-sentinel")
  })

  it("lists workspace symlinks that resolve inside the workspace", async () => {
    await mkdir(join(workspace, "actual"), { recursive: true })
    await writeFile(join(workspace, "actual", "inside.txt"), "ok\n")
    await symlink(join(workspace, "actual"), join(workspace, "link"))

    const result = await listFilesTool.execute({ path: "link" }, { workspace })

    expect(result).toContain("inside.txt")
  })

  it("sorts and caps overlarge listings with explicit truncation metadata", async () => {
    const entries = Array.from({ length: 2005 }, (_, index) =>
      entry(`file-${String(2004 - index).padStart(4, "0")}.txt`)
    )
    const env = fakeEnv({ entries, truncated: true, capReason: "entryCount" })

    const result = await listFilesTool.execute(
      { path: "." },
      { workspace, env }
    )
    const lines = result.split("\n")

    expect(lines[0]).toBe('"file-0000.txt"')
    expect(lines[1999]).toBe('"file-1999.txt"')
    expect(result).not.toContain("file-2000.txt")
    expect(result).toContain('"truncated":true')
    expect(result).toContain('"entriesShown":2000')
    expect(result).toContain("not a complete directory listing")
  })

  it("caps rendered UTF-8 bytes without splitting names", async () => {
    const longName = `${"日本語🚀".repeat(300)}.txt`
    const entries = Array.from({ length: 80 }, (_, index) =>
      entry(`${String(index).padStart(2, "0")}-${longName}`)
    )
    const env = fakeEnv({ entries, truncated: true, capReason: "nameBytes" })

    const result = await listFilesTool.execute(
      { path: "." },
      { workspace, env }
    )
    const listing = result.split("\n[metadata] ")[0]

    expect(Buffer.byteLength(listing, "utf8")).toBeLessThanOrEqual(128 * 1024)
    expect(listing).not.toContain("\ufffd")
    expect(result).toContain('"capReason":"nameBytes"')
  })

  it("renders one JSON-escaped line per entry, with directory type from metadata", async () => {
    const entries = [
      entry("plain.txt"),
      entry("has\nnewline.txt"),
      entry("has\rcarriage.txt"),
      entry("has\ttab.txt"),
      entry('quote"backslash\\.txt'),
      entry("日本語🚀.txt"),
      entry("dirish", "file"),
      entry("directory\nname", "dir"),
    ]
    const env = fakeEnv({ entries, truncated: false })

    const result = await listFilesTool.execute(
      { path: "." },
      { workspace, env }
    )

    expect(result.split("\n")).toEqual([
      '"directory\\nname"/',
      '"dirish"',
      '"has\\ttab.txt"',
      '"has\\nnewline.txt"',
      '"has\\rcarriage.txt"',
      '"plain.txt"',
      '"quote\\"backslash\\\\.txt"',
      '"日本語🚀.txt"',
    ])
  })
})

function entry(name: string, kind: "file" | "dir" = "file"): DirEntry {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
  }
}

function fakeEnv(result: ListDirResult): Environment {
  return {
    resolve: async (path) => path,
    resolveLexical: (path) => path,
    readFile: async () => Buffer.from(""),
    readTextLines: async () => ({
      text: "",
      startLine: 1,
      endLine: 0,
      hasMore: false,
      fileBytes: 0,
      truncated: false,
    }),
    writeFile: async () => {},
    chmod: async () => {},
    rename: async () => {},
    removeFile: async () => {},
    mkdirp: async () => {},
    stat: async () => ({
      size: 0,
      isFile: () => false,
      isDirectory: () => true,
    }),
    readdir: async () => result.entries,
    listDir: async () => result,
    exec: async () => ({
      stdout: Buffer.from(""),
      exitCode: 0,
      signal: null,
      timedOut: false,
    }),
    spawnCommand: async () => ({
      onData: () => {},
      onExit: () => {},
      write: () => {},
      closeStdin: () => {},
      interrupt: () => {},
      kill: () => {},
    }),
    search: async () => ({
      engine: "rg",
      result: "content",
      matches: [],
      files: [],
      counts: [],
      capped: false,
    }),
    dispose: async () => {},
  }
}
