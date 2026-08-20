import { describe, it, expect } from "vitest"
import {
  parseConfig,
  parseEntry,
  serializeConfig,
  isValidServerName,
} from "./loader"
import type { McpServerDef } from "../../db/types"

describe("mcp.json loader", () => {
  it("parses the { mcpServers: {...} } form, inferring transport", () => {
    const text = JSON.stringify({
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          env: { FOO: "bar" },
        },
        atlassian: { url: "https://mcp.atlassian.com/v1/sse" },
      },
    })
    const defs = parseConfig(text, "mcp.json")
    expect(defs).toHaveLength(2)
    const fs = defs.find((d) => d.name === "filesystem")!
    expect(fs.transport).toBe("stdio")
    expect(fs.command).toBe("npx")
    expect(fs.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/tmp",
    ])
    expect(fs.env).toEqual({ FOO: "bar" })
    const atl = defs.find((d) => d.name === "atlassian")!
    expect(atl.transport).toBe("http")
    expect(atl.url).toBe("https://mcp.atlassian.com/v1/sse")
  })

  it("accepts a bare server map (no mcpServers wrapper)", () => {
    const text = JSON.stringify({ gh: { url: "https://example.com/mcp" } })
    const defs = parseConfig(text, "mcp.json")
    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe("gh")
    expect(defs[0].transport).toBe("http")
  })

  it("skips malformed entries and invalid names, keeping the rest", () => {
    const text = JSON.stringify({
      mcpServers: {
        good: { command: "run" },
        "Bad Name": { command: "x" }, // invalid slug
        noconn: { env: { A: "b" } }, // neither command nor url
      },
    })
    const defs = parseConfig(text, "mcp.json")
    expect(defs.map((d) => d.name)).toEqual(["good"])
  })

  it("returns [] for invalid JSON without throwing", () => {
    expect(parseConfig("{ not json", "mcp.json")).toEqual([])
  })

  it("parseEntry rejects an entry with neither command nor url", () => {
    expect(parseEntry("x", {})).toBeNull()
    expect(parseEntry("x", { command: "run" })?.transport).toBe("stdio")
    expect(parseEntry("x", { url: "http://h/mcp" })?.transport).toBe("http")
  })

  it("round-trips defs through serialize → parse", () => {
    const defs: McpServerDef[] = [
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "pkg"],
        env: { TOKEN: "t" },
        url: null,
        headers: {},
      },
      {
        name: "atlassian",
        transport: "http",
        command: null,
        args: [],
        env: {},
        url: "https://mcp.example.com/mcp",
        headers: { "X-H": "v" },
      },
    ]
    const text = serializeConfig(defs)
    const parsed = parseConfig(text, "mcp.json")
    // Sorted by name in serialize; compare as sets.
    expect(parsed.find((d) => d.name === "filesystem")).toEqual(defs[0])
    expect(parsed.find((d) => d.name === "atlassian")).toEqual(defs[1])
  })

  it("serialize omits cross-transport fields (no url on stdio, no args on http)", () => {
    const text = serializeConfig([
      {
        name: "s",
        transport: "stdio",
        command: "run",
        args: [],
        env: {},
        url: null,
        headers: {},
      },
    ])
    expect(text).toContain('"command": "run"')
    expect(text).not.toContain('"url"')
    expect(text).not.toContain('"args"') // empty args omitted
  })

  it("validates the server-name slug", () => {
    expect(isValidServerName("my-server-1")).toBe(true)
    expect(isValidServerName("Bad")).toBe(false)
    expect(isValidServerName("dbl--hyphen")).toBe(false)
    expect(isValidServerName("")).toBe(false)
  })
})
