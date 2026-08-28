import { describe, it, expect } from "vitest"
import { resolveMcpServers } from "./mcp-access"
import type { AgentDefinition } from "./types"

// Build a minimal AgentDefinition carrying only the mcpServers tri-state.
function agent(mcpServers: AgentDefinition["mcpServers"]): AgentDefinition {
  const ref = {
    sourceKind: "north_star" as const,
    scope: "global" as const,
    definitionPath: "/x/a.agent.md",
    nativeName: "a",
  }
  return {
    name: "a",
    nativeName: "a",
    description: "d",
    mcpServers,
    userInvocable: true,
    body: "",
    path: ref.definitionPath,
    source: "/x",
    ref,
    refId: `agentref:v1:${JSON.stringify(ref)}`,
    sourceKind: "north_star",
    scope: "global",
    label: "North Star: a",
    diagnostics: [],
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
