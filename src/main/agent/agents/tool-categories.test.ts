import { describe, it, expect } from "vitest"
import {
  agentToolAllowlist,
  agentToolsIncludeCategory,
  isUniversalTool,
} from "./tool-categories"
import type { AgentDefinition } from "./types"

function agent(tools?: string[], children?: string[]): AgentDefinition {
  return {
    name: "a",
    description: "d",
    tools,
    skills: undefined,
    children,
    userInvocable: true,
    body: "",
    path: "/x/a.agent.md",
    source: "/x",
  }
}

describe("agentToolAllowlist", () => {
  it("returns null when no agent or tools frontmatter omitted (no restriction)", () => {
    expect(agentToolAllowlist(null)).toBeNull()
    expect(agentToolAllowlist(agent(undefined))).toBeNull()
  })

  it("empty tools list still admits the read+search floor", () => {
    const allow = agentToolAllowlist(agent([]))!
    expect(allow).not.toBeNull()
    expect(allow.has("read_file_tool")).toBe(true)
    expect(allow.has("list_files_tool")).toBe(true)
    expect(allow.has("search_tool")).toBe(true)
    expect(allow.has("index_query_tool")).toBe(true)
    // but not mutating/execute tools
    expect(allow.has("edit_file_tool")).toBe(false)
    expect(allow.has("run_shell_tool")).toBe(false)
  })

  it("expands listed categories to their internal tool names (plus the floor)", () => {
    const allow = agentToolAllowlist(agent(["edit", "execute"]))!
    expect(allow.has("edit_file_tool")).toBe(true)
    expect(allow.has("write_file_tool")).toBe(true)
    expect(allow.has("run_shell_tool")).toBe(true)
    // floor is always present
    expect(allow.has("read_file_tool")).toBe(true)
    // categories not listed are excluded
    expect(allow.has("web_search")).toBe(false)
    expect(allow.has("browser_navigate")).toBe(false)
  })

  it("maps web/browser/agent/todo categories", () => {
    const allow = agentToolAllowlist(
      agent(["web", "browser", "agent", "todo"])
    )!
    expect(allow.has("web_search")).toBe(true)
    expect(allow.has("web_fetch")).toBe(true)
    expect(allow.has("browser_navigate")).toBe(true)
    expect(allow.has("browser_screenshot")).toBe(true)
    expect(allow.has("spawn_subagent")).toBe(true)
    expect(allow.has("todo_write")).toBe(true)
    expect(allow.has("run_todos_in_background")).toBe(true)
  })

  it("ignores unknown categories", () => {
    const allow = agentToolAllowlist(agent(["bogus"]))!
    // only the floor survives
    expect(allow.has("read_file_tool")).toBe(true)
    expect(allow.has("bogus")).toBe(false)
  })
})

describe("agentToolsIncludeCategory", () => {
  it("detects the agent category presence", () => {
    expect(agentToolsIncludeCategory(agent(["agent", "read"]), "agent")).toBe(
      true
    )
    expect(agentToolsIncludeCategory(agent(["read"]), "agent")).toBe(false)
    expect(agentToolsIncludeCategory(agent(undefined), "agent")).toBe(false)
  })
})

describe("isUniversalTool", () => {
  it("recognizes always-on infrastructure tools", () => {
    expect(isUniversalTool("ask_user_question")).toBe(true)
    expect(isUniversalTool("read_skill")).toBe(true)
    expect(isUniversalTool("write_plan")).toBe(true)
    expect(isUniversalTool("present_plan")).toBe(true)
    expect(isUniversalTool("run_shell_tool")).toBe(false)
  })
})
