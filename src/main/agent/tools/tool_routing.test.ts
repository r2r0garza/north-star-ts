import { describe, expect, it } from "vitest"
import {
  SEAT_BROWSER_ROUTING,
  browserToolDefinitions,
  seatBrowserToolDefinitions,
} from "./index"
import { runChecksTool } from "./qa_checks_tools"

// Plan 109.06: "explore with the browser, assert with Playwright" is stated
// where the model chooses a tool, in the definitions it reads.
describe("tool-choice routing in definitions", () => {
  it("run_checks says it is the way to produce repeatable proof", () => {
    const description = runChecksTool.definition.function.description
    expect(description).toMatch(
      /^The way to produce repeatable proof: run Playwright and command checks/
    )
    expect(description).toContain('`runner: "playwright"`')
  })

  it("every seat browser tool routes proof to run_checks", () => {
    expect(SEAT_BROWSER_ROUTING).toBe(
      "In Mission Control, use the browser for exploring and evidence. To prove a criterion, write a check and run it with run_checks."
    )
    expect(seatBrowserToolDefinitions.length).toBeGreaterThan(5)
    for (const definition of seatBrowserToolDefinitions)
      expect(
        definition.function.description.endsWith(` ${SEAT_BROWSER_ROUTING}`)
      ).toBe(true)
  })

  it("leaves the chat browser's descriptions alone", () => {
    for (const definition of browserToolDefinitions)
      expect(definition.function.description).not.toContain("run_checks")
  })
})
