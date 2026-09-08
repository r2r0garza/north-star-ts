import { describe, expect, it } from "vitest"
import { bridgeToolsFor } from "./index"
import { BROWSER_MCP_TOOL_NAMES } from "../mcp-server"

describe("CLI bridge tool selection", () => {
  it("grants the browser only when the turn actually has one", () => {
    const withBrowser = bridgeToolsFor({ hasBrowser: true })
    expect(withBrowser).toContain("ask_user_question")
    for (const name of BROWSER_MCP_TOOL_NAMES) {
      expect(withBrowser).toContain(name)
    }

    // A turn with no browser handle must not advertise browser tools — they
    // would resolve to "the agent browser isn't available" on every call.
    const withoutBrowser = bridgeToolsFor({ hasBrowser: false })
    expect(withoutBrowser).toEqual(["ask_user_question"])
  })

  it("withholds questions from a headless worker but keeps the browser", () => {
    const headless = bridgeToolsFor({
      suppressUserQuestions: true,
      hasBrowser: true,
    })
    expect(headless).not.toContain("ask_user_question")
    expect(headless).toContain("browser_navigate")
  })

  it("grants nothing at all for a headless, browserless turn", () => {
    expect(
      bridgeToolsFor({ suppressUserQuestions: true, hasBrowser: false })
    ).toEqual([])
  })
})
