import { describe, expect, it } from "vitest"
import { builtInTools } from "."

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
})
