import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "fs"
import { tmpdir } from "os"
import path from "path"

import { importAgentFromMarkdown } from "./import"

// A working root (the "writable source") plus a scratch dir for source files,
// torn down per test.
let root = ""
let scratch = ""

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agent-import-root-"))
  scratch = mkdtempSync(path.join(tmpdir(), "agent-import-src-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
})

// A valid <name>.agent.md with the given name. Deliberately hand-formatted (extra
// blank line, list flow) so the "verbatim" assertions can prove nothing reflows.
function agentMd(name: string): string {
  return `---
name: ${name}
description: A test agent that does things.
tools:
  - read_file_tool
user-invocable: true
---

You are ${name}. Do the thing.
`
}

// Write an <name>.agent.md file into scratch and return its path.
function writeAgent(fileName: string, content: string): string {
  const p = path.join(scratch, fileName)
  writeFileSync(p, content)
  return p
}

describe("importAgentFromMarkdown", () => {
  it("lands a parseable .agent.md under the target root, verbatim", async () => {
    const src = writeAgent("planner.agent.md", agentMd("planner"))
    const newPath = await importAgentFromMarkdown(src, root)
    expect(newPath).toBe(path.join(root, "planner.agent.md"))
    expect(existsSync(newPath)).toBe(true)
    // Written byte-for-byte — no serializeAgent round-trip / YAML reflow.
    expect(readFileSync(newPath, "utf-8")).toBe(agentMd("planner"))
  })

  it("rejects a file whose name is not <stem>.agent.md", async () => {
    const src = writeAgent("planner.md", agentMd("planner"))
    await expect(importAgentFromMarkdown(src, root)).rejects.toThrow(
      /\.agent\.md/
    )
  })

  it("rejects a file without valid frontmatter", async () => {
    const src = writeAgent("broken.agent.md", "no frontmatter here")
    await expect(importAgentFromMarkdown(src, root)).rejects.toThrow(
      /frontmatter/
    )
  })

  it("rejects when the frontmatter name does not match the file stem", async () => {
    // File stem is "wrong" but frontmatter name is "planner" — the loader's
    // hard rule (name === stem) must reject.
    const src = writeAgent("wrong.agent.md", agentMd("planner"))
    await expect(importAgentFromMarkdown(src, root)).rejects.toThrow(
      /must match file/
    )
  })

  it("rejects a collision with an existing agent in the target root", async () => {
    const src = writeAgent("planner.agent.md", agentMd("planner"))
    await importAgentFromMarkdown(src, root)
    // A second import of the same-named agent collides.
    const src2 = writeAgent("planner.agent.md", agentMd("planner"))
    await expect(importAgentFromMarkdown(src2, root)).rejects.toThrow(
      /already exists/
    )
  })
})
