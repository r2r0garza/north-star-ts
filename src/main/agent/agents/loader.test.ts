import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"

// agentSources builds ~/.<dataDir>/agents plus workspace dirs. Pin the home and
// data-dir so tests read from predictable, isolated locations.
let home = ""
vi.mock("electron", () => ({ app: { getPath: () => home } }))
vi.mock("../../config/system-name", () => ({ dataDirName: () => ".cowork" }))
// agentSources() reads user-registered custom folders from the settings service;
// stub it (no DB in unit tests) so these tests cover only the built-in sources.
let customFolders: string[] = []
vi.mock("../../settings/service", () => ({
  getAgentSources: () => ({ folders: customFolders }),
}))

import { loadAgents, loadAgent } from "./loader"
import { agentSources } from "./sources"

let userDir = ""

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "agents-"))
  userDir = path.join(home, ".cowork", "agents")
  mkdirSync(userDir, { recursive: true })
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function writeAgent(dir: string, stem: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${stem}.agent.md`), content)
}

describe("agentSources", () => {
  it("resolves user dir, then workspace .github and .cowork (last-wins order)", () => {
    const ws = "/tmp/ws"
    expect(agentSources(ws)).toEqual([
      path.join(home, ".cowork", "agents"),
      path.join(ws, ".github", "agents"),
      path.join(ws, ".cowork", "agents"),
    ])
  })
  it("omits workspace dirs when no workspace is given", () => {
    expect(agentSources()).toEqual([path.join(home, ".cowork", "agents")])
  })
})

describe("loadAgents frontmatter parsing", () => {
  it("parses a full definition and strips frontmatter from the body", async () => {
    writeAgent(
      userDir,
      "reviewer",
      `---
name: reviewer
description: Reviews code
tools: [read, search, edit]
skills: [git-commit]
children: [researcher]
user-invocable: true
---
You are a careful reviewer.`
    )
    const [a] = await loadAgents(agentSources())
    expect(a.name).toBe("reviewer")
    expect(a.description).toBe("Reviews code")
    expect(a.tools).toEqual(["read", "search", "edit"])
    expect(a.skills).toEqual(["git-commit"])
    expect(a.children).toEqual(["researcher"])
    expect(a.userInvocable).toBe(true)
    expect(a.body).toBe("You are a careful reviewer.")
  })

  it("preserves the tri-state distinction between omitted and empty lists", async () => {
    // tools omitted, skills empty, children present-but-empty.
    writeAgent(
      userDir,
      "sparse",
      `---
name: sparse
description: d
skills: []
children: []
---
body`
    )
    const [a] = await loadAgents(agentSources())
    expect(a.tools).toBeUndefined() // omitted → all tools
    expect(a.skills).toEqual([]) // empty → no skills
    expect(a.children).toEqual([]) // empty → any child
  })

  it("defaults user-invocable to false when omitted", async () => {
    writeAgent(userDir, "hidden", `---\nname: hidden\ndescription: d\n---\nb`)
    const [a] = await loadAgents(agentSources())
    expect(a.userInvocable).toBe(false)
  })

  it("skips files without frontmatter or required fields", async () => {
    writeAgent(userDir, "nofm", "just text, no frontmatter")
    writeAgent(userDir, "noname", `---\ndescription: d\n---\nb`)
    expect(await loadAgents(agentSources())).toEqual([])
  })

  it("ignores non-.agent.md files", async () => {
    writeFileSync(path.join(userDir, "notes.md"), "# notes")
    expect(await loadAgents(agentSources())).toEqual([])
  })
})

describe("loadAgents source precedence", () => {
  it("lets a workspace agent override a user agent of the same name (last-wins)", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"))
    writeAgent(userDir, "dup", `---\nname: dup\ndescription: user\n---\nu`)
    writeAgent(
      path.join(ws, ".cowork", "agents"),
      "dup",
      `---\nname: dup\ndescription: workspace\n---\nw`
    )
    const agents = await loadAgents(agentSources(ws))
    expect(agents).toHaveLength(1)
    expect(agents[0].description).toBe("workspace")
    rmSync(ws, { recursive: true, force: true })
  })
})

describe("loadAgent", () => {
  it("resolves a single agent by name", async () => {
    writeAgent(userDir, "a", `---\nname: a\ndescription: d\n---\nb`)
    expect((await loadAgent("a"))?.name).toBe("a")
    expect(await loadAgent("missing")).toBeNull()
  })
})
