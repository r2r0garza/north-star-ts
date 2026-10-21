import { expect, it } from "vitest"
import {
  acceptsToolActivity,
  activityLabel,
  executionArguments,
  withToolActivity,
} from "./tool-activity"

it("decorates built-in and MCP schemas without mutation or changing required arguments", () => {
  for (const name of ["exec_command", "mcp__server__inspect"]) {
    const definition = {
      type: "function",
      function: {
        name,
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      },
    }
    const decorated = withToolActivity(definition)
    expect(decorated).not.toBe(definition)
    expect(definition.function.parameters.properties).not.toHaveProperty(
      "_activity"
    )
    expect(decorated.function.parameters.required).toEqual(["command"])
    expect(decorated.function.parameters.additionalProperties).toBe(false)
    expect(acceptsToolActivity(decorated)).toBe(true)
    const original = {
      command: "echo test",
      _activity: "Inspecting test output",
    }
    expect(executionArguments(original)).toEqual({ command: "echo test" })
    expect(original._activity).toBe("Inspecting test output")
  }
})

it("strips whitespace variants of activity metadata without normalizing data keys", () => {
  const args = {
    " _activity": "Preparing a comparison chart",
    "_activity ": "Preparing another label",
    " title": "Keep this invalid artifact field",
    data: [{ " _activity": "A real row key" }],
  }
  expect(executionArguments(args)).toEqual({
    " title": "Keep this invalid artifact field",
    data: [{ " _activity": "A real row key" }],
  })
  expect(activityLabel(args)).toBe("Preparing a comparison chart")
  expect(args[" _activity"]).toBe("Preparing a comparison chart")
  expect(activityLabel({ ...args, _activity: "Canonical title" })).toBe(
    "Canonical title"
  )
})

it("leaves conflicting and unsupported schemas unchanged", () => {
  for (const parameters of [
    { type: "object", properties: { _activity: { type: "number" } } },
    { type: "array" },
    { type: "object", oneOf: [] },
    { type: "object", properties: [] },
  ]) {
    const definition = { function: { parameters } }
    expect(withToolActivity(definition)).toBe(definition)
    expect(acceptsToolActivity(definition)).toBe(false)
  }
})

it("normalizes short plain text descriptions and rejects invalid or overlong values", () => {
  expect(
    activityLabel({ _activity: "  Inspecting\n prompt   construction " })
  ).toBe("Inspecting prompt construction")
  for (const value of [null, 2, {}, "", "  ", "x".repeat(121)]) {
    expect(activityLabel({ _activity: value })).toBeUndefined()
  }
  expect(activityLabel(null)).toBeUndefined()
})
