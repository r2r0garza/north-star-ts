import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { McpServer } from "../../db/types"
import {
  flattenContent,
  MCP_DISCOVERY_DESCRIPTION_MAX_BYTES,
  MCP_DISCOVERY_MAX_TOOLS_PER_SERVER,
  MCP_DISCOVERY_SCHEMA_MAX_BYTES,
  MCP_TOOL_CALL_TIMEOUT_MS,
  MCP_TOOL_ERROR_MAX_BYTES,
  MCP_TOOL_OUTPUT_MAX_BYTES,
  McpManager,
  parsePrefixedName,
  prefixedToolName,
} from "./manager"
import { loadServers, resolveEnabledServer } from "./resolve"

vi.mock("./resolve", () => ({
  loadServers: vi.fn(),
  resolveEnabledServer: vi.fn(),
}))

const mockedResolveEnabledServer = vi.mocked(resolveEnabledServer)
const mockedLoadServers = vi.mocked(loadServers)

describe("MCP tool name prefixing", () => {
  it("builds a namespaced name", () => {
    expect(prefixedToolName("atlassian", "createIssue")).toBe(
      "mcp__atlassian__createIssue"
    )
  })

  it("round-trips a simple name", () => {
    const name = prefixedToolName("github", "list_repos")
    expect(parsePrefixedName(name)).toEqual({
      serverName: "github",
      toolName: "list_repos",
    })
  })

  it("splits on the FIRST separator so a tool name may contain __", () => {
    // The server slug is validated [a-z0-9-] (never __), so the first __ after
    // the prefix is the boundary; the tool keeps any later __.
    expect(parsePrefixedName("mcp__srv__weird__tool")).toEqual({
      serverName: "srv",
      toolName: "weird__tool",
    })
  })

  it("returns null for a non-MCP name", () => {
    expect(parsePrefixedName("read_file_tool")).toBeNull()
  })

  it("returns null for a malformed prefixed name", () => {
    expect(parsePrefixedName("mcp__")).toBeNull()
    expect(parsePrefixedName("mcp__noseparator")).toBeNull()
    expect(parsePrefixedName("mcp____emptyserver")).toBeNull()
  })
})

describe("MCP tool call lifecycle", () => {
  const server: McpServer = {
    name: "srv",
    transport: "stdio",
    command: "mcp-server",
    args: [],
    env: {},
    url: null,
    headers: {},
    path: "/tmp/mcp.json",
    source: "/tmp",
    enabled: true,
    hasOauth: false,
  }

  beforeEach(() => {
    mockedResolveEnabledServer.mockResolvedValue(server)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it("settles and evicts when an MCP call exceeds the hard deadline", async () => {
    vi.useFakeTimers()
    const callTool = vi.fn(() => new Promise<never>(() => {}))
    const close = vi.fn(async () => {})
    const manager = managerWithPooledClient("srv", { callTool }, close)

    const resultPromise = manager.callTool(prefixedToolName("srv", "hang"), {})
    await vi.advanceTimersByTimeAsync(MCP_TOOL_CALL_TIMEOUT_MS)
    const result = await resultPromise

    expect(result).toContain("ERROR[mcp]")
    expect(result).toContain("timed out")
    expect(close).toHaveBeenCalledTimes(1)
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
      MCP_TOOL_ERROR_MAX_BYTES
    )
  })

  it("passes a turn abort signal and settles promptly when stopped", async () => {
    const abort = new AbortController()
    const callTool = vi.fn(() => new Promise<never>(() => {}))
    const close = vi.fn(async () => {})
    const manager = managerWithPooledClient("srv", { callTool }, close)

    const resultPromise = manager.callTool(
      prefixedToolName("srv", "slow"),
      {},
      undefined,
      abort.signal
    )
    abort.abort()
    const result = await resultPromise

    expect(result).toContain("cancelled")
    expect(callTool).toHaveBeenCalledWith(
      { name: "slow", arguments: {} },
      undefined,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeout: MCP_TOOL_CALL_TIMEOUT_MS,
        maxTotalTimeout: MCP_TOOL_CALL_TIMEOUT_MS,
      })
    )
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("bounds oversized rejected error messages", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("語".repeat(10_000))
    })
    const close = vi.fn(async () => {})
    const manager = managerWithPooledClient("srv", { callTool }, close)

    const result = await manager.callTool(prefixedToolName("srv", "boom"), {})

    expect(result).toContain("ERROR[mcp]")
    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
      MCP_TOOL_ERROR_MAX_BYTES
    )
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe("MCP discovery lifecycle and definition bounds", () => {
  const server: McpServer = {
    name: "srv",
    transport: "stdio",
    command: "mcp-server",
    args: [],
    env: {},
    url: null,
    headers: {},
    path: "/tmp/mcp.json",
    source: "/tmp",
    enabled: true,
    hasOauth: false,
  }

  beforeEach(() => {
    mockedLoadServers.mockResolvedValue([server])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("passes a turn abort signal to MCP tool discovery and evicts on stop", async () => {
    const abort = new AbortController()
    const listTools = vi.fn(() => new Promise<never>(() => {}))
    const close = vi.fn(async () => {})
    const manager = managerWithPooledClient("srv", { listTools }, close)
    const errors: string[] = []

    const resultPromise = manager.listToolsFor(
      ["srv"],
      undefined,
      (_server, err) => errors.push(err),
      abort.signal
    )
    abort.abort()
    const result = await resultPromise

    expect(result).toEqual([])
    expect(listTools).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeout: expect.any(Number),
        maxTotalTimeout: expect.any(Number),
      })
    )
    expect(errors.join("\n")).toContain("This operation was aborted")
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("bounds MCP tool counts, descriptions, and schemas while keeping valid tools", async () => {
    const tools = [
      {
        name: "oversized",
        description: "語".repeat(MCP_DISCOVERY_DESCRIPTION_MAX_BYTES),
        inputSchema: {
          type: "object",
          properties: {
            blob: {
              type: "string",
              description: "x".repeat(MCP_DISCOVERY_SCHEMA_MAX_BYTES),
            },
          },
        },
      },
      ...Array.from(
        { length: MCP_DISCOVERY_MAX_TOOLS_PER_SERVER + 5 },
        (_, idx) => ({
          name: `valid${idx}`,
          description: `valid ${idx}`,
          inputSchema: { type: "object", properties: {} },
        })
      ),
    ]
    const manager = managerWithPooledClient("srv", {
      listTools: vi.fn(async () => ({ tools })),
    })
    const errors: string[] = []

    const defs = await manager.listToolsFor(
      ["srv"],
      undefined,
      (_server, err) => errors.push(err)
    )

    expect(defs).toHaveLength(MCP_DISCOVERY_MAX_TOOLS_PER_SERVER)
    expect(defs[0].function.name).toBe("mcp__srv__oversized")
    expect(
      Buffer.byteLength(defs[0].function.description, "utf8")
    ).toBeLessThanOrEqual(MCP_DISCOVERY_DESCRIPTION_MAX_BYTES)
    expect(defs[0].function.description).toContain("description truncated")
    expect(defs[0].function.parameters).toEqual({
      type: "object",
      properties: {},
    })
    expect(defs.some((def) => def.function.name === "mcp__srv__valid0")).toBe(
      true
    )
    expect(errors.join("\n")).toContain("per-server discovery limit")
    expect(errors.join("\n")).toContain("description")
    expect(errors.join("\n")).toContain("input schema")
  })
})

describe("MCP content flattening", () => {
  it("caps oversized text output with explicit UTF-8-safe metadata", () => {
    const result = flattenContent({
      content: [{ type: "text", text: "語".repeat(100_000) }],
    })

    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
      MCP_TOOL_OUTPUT_MAX_BYTES
    )
    expect(result).toContain("[metadata]")
    expect(result).toContain('"truncated":true')
    expect(result).toContain('"maxBytes":262144')
    expect(result).not.toContain("\uFFFD")
  })

  it("preserves resource and content-type metadata while bounding resource text", () => {
    const result = flattenContent({
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///large.txt",
            text: "x".repeat(MCP_TOOL_OUTPUT_MAX_BYTES * 2),
          },
        },
      ],
    })

    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
      MCP_TOOL_OUTPUT_MAX_BYTES
    )
    expect(result).toContain("[metadata]")
    expect(result).toContain('"contentTypes":["resource"]')
    expect(result).toContain('"resources":["file:///large.txt"]')
  })
})

function managerWithPooledClient(
  serverName: string,
  client: {
    callTool?: ReturnType<typeof vi.fn>
    listTools?: ReturnType<typeof vi.fn>
  },
  close: () => Promise<void> = async () => {}
): McpManager {
  const manager = new McpManager()
  ;(
    manager as unknown as {
      pool: Map<string, { client: unknown; close: () => Promise<void> }>
    }
  ).pool.set(serverName, { client, close })
  return manager
}
