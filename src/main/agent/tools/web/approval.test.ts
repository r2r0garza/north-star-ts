import { describe, expect, it } from "vitest"
import { webFetchAction, webFetchOrigin } from "./approval"

describe("web fetch approvals", () => {
  it("normalizes permissions to the URL origin", () => {
    expect(
      webFetchOrigin(new URL("https://DeepAgents.com:443/docs/agents"))
    ).toBe("https://deepagents.com")
    expect(webFetchOrigin(new URL("https://deepagents.com:8443/docs"))).toBe(
      "https://deepagents.com:8443"
    )
  })

  it("uses one identity for different paths on the same origin", () => {
    const agents = webFetchAction(new URL("https://deepagents.com/docs/agents"))
    const skills = webFetchAction(
      new URL("https://deepagents.com/docs/skills?version=2")
    )

    expect(agents.identity).toBe("web_fetch_origin:https://deepagents.com")
    expect(skills.identity).toBe(agents.identity)
    expect(skills.detail).toEqual({
      url: "https://deepagents.com/docs/skills?version=2",
      origin: "https://deepagents.com",
    })
  })

  it("keeps schemes and non-default ports isolated", () => {
    const https = webFetchAction(new URL("https://deepagents.com/docs"))
    const http = webFetchAction(new URL("http://deepagents.com/docs"))
    const alternatePort = webFetchAction(
      new URL("https://deepagents.com:8443/docs")
    )

    expect(http.identity).not.toBe(https.identity)
    expect(alternatePort.identity).not.toBe(https.identity)
  })
})
