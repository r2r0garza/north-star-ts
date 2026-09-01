import { describe, expect, it } from "vitest"
import { agentDisplay } from "./agent-display"

describe("agentDisplay", () => {
  it("turns a durable agent reference into friendly display metadata", () => {
    const value =
      'agentref:v1:{"sourceKind":"cursor","scope":"global","definitionPath":"/Users/me/.cursor/agents/researcher.md","nativeName":"researcher"}'

    expect(agentDisplay(value)).toEqual({
      name: "researcher",
      source: "Cursor",
      scope: "Global",
    })
  })

  it("prefers current catalog metadata", () => {
    expect(
      agentDisplay("agentref:v1:{}", {
        nativeName: "current-name",
        sourceKind: "north_star",
        scope: "workspace",
      })
    ).toEqual({
      name: "current-name",
      source: "North Star",
      scope: "Workspace",
    })
  })

  it("leaves legacy plain agent names readable", () => {
    expect(agentDisplay("legacy-agent")).toEqual({
      name: "legacy-agent",
      source: null,
      scope: null,
    })
  })

  it("does not throw on a malformed reference", () => {
    expect(agentDisplay("agentref:v1:{broken")).toEqual({
      name: "agentref:v1:{broken",
      source: null,
      scope: null,
    })
  })
})
