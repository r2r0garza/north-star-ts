import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"

// agentSources builds ~/.<dataDir>/agents plus workspace dirs. Pin the home and
// data-dir so tests read from predictable, isolated locations.
let home = ""
vi.mock("electron", () => ({ app: { getPath: () => home } }))
vi.mock("../../config/system-name", () => ({
  dataDirName: () => ".cowork",
  systemDisplayName: () => "Cowork",
}))
// agentSources() reads user-registered custom folders from the settings service;
// stub it (no DB in unit tests) so these tests cover only the built-in sources.
let customFolders: string[] = []
vi.mock("../../settings/service", () => ({
  getAgentSources: () => ({ folders: customFolders }),
}))

import { loadAgents, loadAgent, serializeAgent, validateName } from "./loader"
import { agentSources } from "./sources"
import { readFileSync } from "fs"

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
      path.join(home, ".copilot", "agents"),
      path.join(home, ".cursor", "agents"),
      path.join(home, ".claude", "agents"),
      path.join(ws, ".github", "agents"),
      path.join(ws, ".copilot", "agents"),
      path.join(ws, ".cursor", "agents"),
      path.join(ws, ".claude", "agents"),
      path.join(ws, ".codex", "agents"),
      path.join(ws, ".cowork", "agents"),
    ])
  })
  it("omits workspace dirs when no workspace is given", () => {
    expect(agentSources()).toEqual([
      path.join(home, ".cowork", "agents"),
      path.join(home, ".copilot", "agents"),
      path.join(home, ".cursor", "agents"),
      path.join(home, ".claude", "agents"),
    ])
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
mcp-servers: [atlassian, github]
user-invocable: true
---
You are a careful reviewer.`
    )
    const [a] = await loadAgents(agentSources())
    expect(a.name).toBe("reviewer")
    expect(a.description).toBe("Reviews code")
    expect(a.label).toBe("Cowork: reviewer")
    expect(a.tools).toEqual(["read", "search", "edit"])
    expect(a.skills).toEqual(["git-commit"])
    expect(a.children).toEqual(["researcher"])
    expect(a.mcpServers).toEqual(["atlassian", "github"])
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
    expect(a.mcpServers).toBeUndefined() // omitted → all enabled servers
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

describe("loadAgents source-qualified identity", () => {
  it("keeps same-name agents from different sources independently selectable", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"))
    writeAgent(userDir, "dup", `---\nname: dup\ndescription: user\n---\nu`)
    writeAgent(
      path.join(ws, ".cowork", "agents"),
      "dup",
      `---\nname: dup\ndescription: workspace\n---\nw`
    )
    const agents = await loadAgents(agentSources(ws))
    expect(agents.filter((a) => a.name === "dup")).toHaveLength(2)
    expect(agents.map((a) => a.refId)).toEqual([
      expect.stringContaining('"scope":"global"'),
      expect.stringContaining('"scope":"workspace"'),
    ])
    expect((await loadAgent("dup", ws))?.description).toBe("workspace")
    rmSync(ws, { recursive: true, force: true })
  })
})

describe("external provider parsing", () => {
  it("parses GitHub markdown agents without requiring name or .agent.md suffix", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"))
    const dir = path.join(ws, ".github", "agents")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "reviewer.md"),
      `---\ndescription: Reviews pull requests\ntools: [read, search]\n---\nReview carefully.`
    )
    const agent = (await loadAgents(agentSources(ws))).find(
      (a) => a.sourceKind === "github"
    )!
    expect(agent.name).toBe("reviewer")
    expect(agent.label).toBe("GitHub: reviewer")
    expect(agent.tools).toEqual(["read", "search"])
    expect(agent.userInvocable).toBe(true)
    rmSync(ws, { recursive: true, force: true })
  })

  it("labels Copilot markdown agents with Copilot identity", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"))
    const dir = path.join(ws, ".copilot", "agents")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "reviewer.md"),
      `---\ndescription: Reviews pull requests\ntools: [read, search]\n---\nReview carefully.`
    )
    const agent = (await loadAgents(agentSources(ws))).find(
      (a) => a.sourceKind === "copilot"
    )!
    expect(agent.name).toBe("reviewer")
    expect(agent.label).toBe("Copilot: reviewer")
    expect(agent.tools).toEqual(["read", "search"])
    expect(agent.userInvocable).toBe(true)
    rmSync(ws, { recursive: true, force: true })
  })

  it("parses Cursor and Claude markdown with source-specific identity", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"))
    mkdirSync(path.join(ws, ".cursor", "agents"), { recursive: true })
    mkdirSync(path.join(ws, ".claude", "agents"), { recursive: true })
    writeFileSync(
      path.join(ws, ".cursor", "agents", "reviewer.md"),
      `---\nname: reviewer\ndescription: Cursor reviewer\nreadonly: true\n---\nCursor body`
    )
    writeFileSync(
      path.join(ws, ".claude", "agents", "reviewer.md"),
      `---\nname: reviewer\ndescription: Claude reviewer\ntools: [Read]\nskills: [test]\n---\nClaude body`
    )
    const agents = await loadAgents(agentSources(ws))
    expect(agents.find((a) => a.sourceKind === "cursor")?.label).toBe(
      "Cursor: reviewer"
    )
    expect(agents.find((a) => a.sourceKind === "claude")?.skills).toEqual([
      "test",
    ])
    expect(agents.filter((a) => a.name === "reviewer")).toHaveLength(2)
    rmSync(ws, { recursive: true, force: true })
  })

  it("parses Codex config registry entries and avoids duplicate config files", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "ws-"))
    const codexDir = path.join(ws, ".codex")
    const agentsDir = path.join(codexDir, "agents")
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(
      path.join(codexDir, "config.toml"),
      `[agents.reviewer]\ndescription = "Codex reviewer"\nconfig_file = "agents/reviewer.toml"\n`
    )
    writeFileSync(
      path.join(agentsDir, "reviewer.toml"),
      `[agent]\nname = "reviewer"\ndescription = "Standalone description"\ndeveloper_instructions = "Codex body"\n`
    )
    const agents = (await loadAgents(agentSources(ws))).filter(
      (a) => a.sourceKind === "codex"
    )
    expect(agents).toHaveLength(1)
    expect(agents[0].name).toBe("reviewer")
    expect(agents[0].body).toBe("Codex body")
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

describe("serializeAgent round-trips through parseAgent", () => {
  // Write a serialized agent to disk, load it, and return the parsed definition,
  // so we assert the on-disk format is what the loader accepts.
  async function roundTrip(fields: Parameters<typeof serializeAgent>[0]) {
    writeFileSync(
      path.join(userDir, `${fields.name}.agent.md`),
      serializeAgent(fields)
    )
    const agents = await loadAgents(agentSources())
    return agents.find((a) => a.name === fields.name)!
  }

  it("preserves the tri-state distinction (undefined omits, [] emits empty)", async () => {
    const a = await roundTrip({
      name: "tri",
      description: "d",
      tools: ["read", "edit"], // list
      skills: [], // empty → key present but empty
      // children omitted → undefined
      userInvocable: true,
      body: "body text",
    })
    expect(a.tools).toEqual(["read", "edit"])
    expect(a.skills).toEqual([])
    expect(a.children).toBeUndefined()
    expect(a.userInvocable).toBe(true)
    expect(a.body).toBe("body text")
  })

  it("omits an undefined list key entirely from the frontmatter", () => {
    const text = serializeAgent({
      name: "x",
      description: "d",
      userInvocable: false,
      body: "b",
    })
    expect(text).not.toMatch(/tools:/)
    expect(text).not.toMatch(/skills:/)
    expect(text).not.toMatch(/children:/)
    expect(text).not.toMatch(/mcp-servers:/)
    expect(text).toMatch(/user-invocable: false/)
  })

  it("round-trips mcp-servers via the hyphenated frontmatter key", async () => {
    const a = await roundTrip({
      name: "mcp-agent",
      description: "d",
      mcpServers: ["atlassian"],
      userInvocable: false,
      body: "b",
    })
    expect(a.mcpServers).toEqual(["atlassian"])
    const raw = readFileSync(path.join(userDir, "mcp-agent.agent.md"), "utf-8")
    expect(raw).toMatch(/mcp-servers:/)
    expect(raw).not.toMatch(/mcpServers/)
  })

  it("emits mcp-servers: [] for a present-but-empty list (none)", async () => {
    const a = await roundTrip({
      name: "no-mcp",
      description: "d",
      mcpServers: [],
      userInvocable: false,
      body: "b",
    })
    expect(a.mcpServers).toEqual([])
  })

  it("uses the hyphenated user-invocable frontmatter key", async () => {
    const a = await roundTrip({
      name: "hyphen",
      description: "d",
      userInvocable: true,
      body: "b",
    })
    expect(a.userInvocable).toBe(true)
    const raw = readFileSync(path.join(userDir, "hyphen.agent.md"), "utf-8")
    expect(raw).toMatch(/user-invocable: true/)
    expect(raw).not.toMatch(/userInvocable/)
  })

  it("preserves a multi-line body verbatim after the closing fence", async () => {
    const body = "# Heading\n\nLine one.\nLine two.\n"
    const a = await roundTrip({
      name: "multiline",
      description: "d",
      userInvocable: false,
      body,
    })
    expect(a.body).toBe(body)
  })
})

describe("validateName", () => {
  it("accepts a valid lowercase-hyphen name matching the stem", () => {
    expect(validateName("my-agent", "my-agent")).toBeNull()
  })
  it("rejects a name that doesn't match the file stem", () => {
    expect(validateName("foo", "bar")).toMatch(/must match file/)
  })
  it("rejects uppercase, leading/trailing/double hyphens", () => {
    expect(validateName("Foo", "Foo")).toMatch(/lowercase/)
    expect(validateName("-foo", "-foo")).toMatch(/lowercase/)
    expect(validateName("foo--bar", "foo--bar")).toMatch(/lowercase/)
  })
})
