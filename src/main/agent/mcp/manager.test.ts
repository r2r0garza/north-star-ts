import { describe, it, expect } from "vitest"
import { prefixedToolName, parsePrefixedName } from "./manager"

describe("MCP tool name prefixing", () => {
  it("builds a namespaced name", () => {
    expect(prefixedToolName("atlassian", "createIssue")).toBe(
      "mcp__atlassian__createIssue"
    )
  })

  it("round-trips a simple name", () => {
    const name = prefixedToolName("github", "list_repos")
    expect(parsePrefixedName(name)).toEqual({
      serverName: "github",
      toolName: "list_repos",
    })
  })

  it("splits on the FIRST separator so a tool name may contain __", () => {
    // The server slug is validated [a-z0-9-] (never __), so the first __ after
    // the prefix is the boundary; the tool keeps any later __.
    expect(parsePrefixedName("mcp__srv__weird__tool")).toEqual({
      serverName: "srv",
      toolName: "weird__tool",
    })
  })

  it("returns null for a non-MCP name", () => {
    expect(parsePrefixedName("read_file_tool")).toBeNull()
  })

  it("returns null for a malformed prefixed name", () => {
    expect(parsePrefixedName("mcp__")).toBeNull()
    expect(parsePrefixedName("mcp__noseparator")).toBeNull()
    expect(parsePrefixedName("mcp____emptyserver")).toBeNull()
  })
})
