import { describe, expect, it } from "vitest"

import { draftToDef, type Draft } from "./mcp-screen"

function baseDraft(overrides: Partial<Draft>): Draft {
  return {
    name: "example",
    transport: "stdio",
    command: "",
    args: [],
    env: {},
    envText: "",
    url: "",
    headers: {},
    headersText: "",
    ...overrides,
  }
}

describe("MCP server form draft", () => {
  it("parses stdio environment text only when saving", () => {
    const def = draftToDef(
      baseDraft({
        command: "node",
        envText: "API_TOKEN\nPATH=/usr/bin\nEMPTY=\n",
      })
    )

    expect(def.env).toEqual({
      PATH: "/usr/bin",
      EMPTY: "",
    })
  })

  it("parses HTTP headers text only when saving", () => {
    const def = draftToDef(
      baseDraft({
        transport: "http",
        url: "https://mcp.example.com/mcp",
        headersText: "Authorization\nX-Custom-Header=value",
      })
    )

    expect(def.headers).toEqual({
      "X-Custom-Header": "value",
    })
  })
})
