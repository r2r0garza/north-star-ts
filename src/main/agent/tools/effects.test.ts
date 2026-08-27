import { describe, expect, it } from "vitest"
import { builtInTools, toolDefinitions } from "."

describe("tool effect metadata", () => {
  it("is declared for every built-in tool", () => {
    for (const tool of builtInTools) {
      expect(tool.effects, tool.definition.function.name).toEqual({
        readOnly: expect.any(Boolean),
        parallelSafe: expect.any(Boolean),
        idempotent: expect.any(Boolean),
        destructive: expect.any(Boolean),
        openWorld: expect.any(Boolean),
      })
    }
  })

  it("does not mark non-read-only tools as parallel-safe", () => {
    for (const tool of builtInTools) {
      expect(
        !tool.effects.parallelSafe || tool.effects.readOnly,
        tool.definition.function.name
      ).toBe(true)
    }
  })

  it("does not offer the legacy run_shell_tool in model-facing definitions", () => {
    const names = toolDefinitions.map((tool) => tool.function.name)
    expect(names).toContain("exec_command")
    expect(names).toContain("write_stdin")
    expect(names).toContain("poll_command")
    expect(names).toContain("terminate_command")
    expect(names).not.toContain("run_shell_tool")
  })
})
