import { describe, expect, it } from "vitest"
import { agentToolAllowlist } from "./agents/tool-categories"
import type { AgentDefinition } from "./agents/types"
import { offeredToolNames, unavailableToolResult } from "./tool-availability"

const def = (name: string) => ({ function: { name } })

function agent(tools: string[]): AgentDefinition {
  return {
    name: "limited",
    description: "limited",
    tools,
    userInvocable: true,
    body: "body",
    path: "/x/limited.agent.md",
    source: "/x",
  }
}

describe("tool availability guard", () => {
  it("accepts only exact tool names offered in this model round", () => {
    const offered = offeredToolNames([def("read_file_tool")])

    expect(unavailableToolResult("read_file_tool", offered)).toBeNull()
    expect(unavailableToolResult("write_file_tool", offered)).toContain(
      "ERROR[tool_unavailable]"
    )
  })

  it("rejects fabricated MCP names before MCP prefix dispatch", () => {
    const offered = offeredToolNames([def("mcp__allowed__search")])

    expect(unavailableToolResult("mcp__allowed__search", offered)).toBeNull()
    expect(unavailableToolResult("mcp__withheld__delete", offered)).toContain(
      "ERROR[tool_unavailable]"
    )
  })

  it("rejects browser tools excluded by a custom-agent category allowlist", () => {
    const allowlist = agentToolAllowlist(agent(["read", "search"]))
    const offered = offeredToolNames(
      [def("read_file_tool"), def("search_tool"), def("browser_click")].filter(
        (tool) => allowlist?.has(tool.function.name)
      )
    )

    expect(unavailableToolResult("browser_click", offered)).toContain(
      "ERROR[tool_unavailable]"
    )
  })

  it("treats apply_patch_tool as an edit-category tool", () => {
    expect(agentToolAllowlist(agent(["edit"]))?.has("apply_patch_tool")).toBe(
      true
    )
  })

  it("rejects plan-mode-withheld modern shell and patch tool names", () => {
    const offered = offeredToolNames([
      def("read_file_tool"),
      def("list_files_tool"),
      def("search_tool"),
      def("write_plan"),
      def("present_plan"),
    ])

    for (const name of [
      "apply_patch_tool",
      "exec_command",
      "write_stdin",
      "poll_command",
      "terminate_command",
    ]) {
      expect(unavailableToolResult(name, offered)).toContain(
        "ERROR[tool_unavailable]"
      )
    }
  })
})
