import { describe, it, expect } from "vitest"
import { resolveMcpServers } from "./mcp-access"
import type { AgentDefinition } from "./types"

// Build a minimal AgentDefinition carrying only the mcpServers tri-state.
function agent(mcpServers: AgentDefinition["mcpServers"]): AgentDefinition {
  return {
    name: "a",
    description: "d",
    mcpServers,
    userInvocable: true,
    body: "",
    path: "",
    source: "user",
  }
}

const ENABLED = ["atlassian", "github", "filesystem"]

describe("resolveMcpServers", () => {
  it("returns all enabled servers when there is no custom agent", () => {
    expect(resolveMcpServers(null, ENABLED)).toEqual(ENABLED)
  })

  it("returns all enabled servers when mcpServers is undefined", () => {
    expect(resolveMcpServers(agent(undefined), ENABLED)).toEqual(ENABLED)
  })

  it("returns none when mcpServers is an empty list", () => {
    expect(resolveMcpServers(agent([]), ENABLED)).toEqual([])
  })

  it("returns only the listed servers that are also enabled", () => {
    expect(resolveMcpServers(agent(["github", "atlassian"]), ENABLED)).toEqual([
      "atlassian",
      "github",
    ])
  })

  it("silently drops a listed server that is not enabled", () => {
    expect(
      resolveMcpServers(agent(["github", "disabled-one"]), ENABLED)
    ).toEqual(["github"])
  })

  it("returns a copy, not the caller's array", () => {
    const result = resolveMcpServers(null, ENABLED)
    expect(result).not.toBe(ENABLED)
  })
})
