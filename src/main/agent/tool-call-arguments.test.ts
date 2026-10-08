import { describe, expect, it } from "vitest"
import { replayToolCallArguments } from "./tool-call-arguments"

describe("replayToolCallArguments", () => {
  it("preserves valid argument JSON exactly", () => {
    const argumentsText = ' { "path": "a.ts", "content": "hello" } '
    expect(replayToolCallArguments(argumentsText)).toBe(argumentsText)
  })

  it("encodes invalid JSON as data without guessing executable arguments", () => {
    for (const argumentsText of [
      "",
      '{"path": "src/db/_realistic.ts"',
      '{"content":"unescaped\ntext"}',
    ]) {
      expect(JSON.parse(replayToolCallArguments(argumentsText))).toEqual({
        _invalid_tool_arguments: argumentsText,
      })
    }
  })
})
