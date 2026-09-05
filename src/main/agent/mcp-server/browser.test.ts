import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { cancelAllQuestions, resolveQuestion } from "../questions/broker"
import { revokeAllGrants } from "./grants"
import { closeCliMcpBridge, grantCliMcpAccess } from "./server"
import { BROWSER_MCP_TOOL_NAMES } from "./tools/browser"
import type { CliMcpToolName } from "./types"

// A stand-in for BrowserManager.handleForTurn — records what the bridge drove.
function fakeBrowser() {
  return {
    calls: [] as Array<[string, unknown[]]>,
    handle: {
      navigate: vi.fn(async (url: string) => ({ url, title: "Example" })),
      screenshot: vi.fn(async () => ({
        jpeg: Buffer.from("fake-jpeg-bytes"),
        width: 1280,
        height: 720,
      })),
      snapshot: vi.fn(async () => "- button [ref_1] Sign in"),
      describeRef: vi.fn(() => ({
        ref: "ref_1",
        target: "Sign in",
        url: "https://example.com",
        origin: "https://example.com",
      })),
      click: vi.fn(async () => ({ url: "https://example.com", title: "x" })),
      hover: vi.fn(async () => ({ url: "https://example.com", title: "x" })),
      drag: vi.fn(async () => ({ url: "https://example.com", title: "x" })),
      type: vi.fn(async () => ({ url: "https://example.com", title: "x" })),
      selectOption: vi.fn(async () => ({ selected: ["a"] })),
      wait: vi.fn(async () => ({ url: "https://example.com", title: "x" })),
      console: vi.fn(() => ({ entries: [], nextCursor: 0 })),
      network: vi.fn(() => ({ entries: [], nextCursor: 0 })),
      dialog: vi.fn(() => null),
      handleDialog: vi.fn(async () => ({ url: "x", title: "x" })),
      evaluate: vi.fn(async () => ({ value: "42" })),
      back: vi.fn(async () => ({ url: "https://example.com", title: "x" })),
      close: vi.fn(() => true),
      reveal: vi.fn(),
      state: vi.fn(() => null),
    },
  }
}

async function connect(token: string, url: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  )
  return client
}

async function grantWithBrowser(
  input: {
    tools?: CliMcpToolName[]
    withBrowser?: boolean
  } = {}
) {
  const abort = new AbortController()
  const browser = fakeBrowser()
  const events: any[] = []
  const injection = await grantCliMcpAccess({
    conversationId: "conv-browser",
    workingDirectory: "/tmp/ws",
    workspace: "/tmp/ws",
    provider: "claude_code",
    tools: input.tools ?? (BROWSER_MCP_TOOL_NAMES as CliMcpToolName[]),
    question: { emit: (e) => events.push(e), signal: abort.signal },
    browser:
      input.withBrowser === false
        ? null
        : { browser: browser.handle as never, signal: abort.signal },
  })
  return { injection, browser, abort, events }
}

describe("browser tools over the CLI MCP bridge", () => {
  beforeEach(() => {
    revokeAllGrants()
    cancelAllQuestions()
  })
  afterAll(async () => {
    cancelAllQuestions()
    await closeCliMcpBridge()
  })

  it("lists every browser tool with its internal schema", async () => {
    const { injection } = await grantWithBrowser()
    const client = await connect(injection.token, injection.url)
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((t) => t.name).sort()).toEqual(
        [...BROWSER_MCP_TOOL_NAMES].sort()
      )
      const navigate = listed.tools.find((t) => t.name === "browser_navigate")!
      // Schema comes from the internal definition, so it cannot drift.
      expect(navigate.inputSchema.required).toEqual(["url"])
      expect(navigate.description).toContain("agent browser")
      // Descriptions are carried over verbatim, per the CLIs having no browser
      // of their own to compete with.
      expect(navigate.description).not.toContain("EVERY")
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("navigates without ever raising an approval — a CLI turn is pre-approved", async () => {
    const { injection, browser, events } = await grantWithBrowser()
    const client = await connect(injection.token, injection.url)
    try {
      const result = (await client.callTool({
        name: "browser_navigate",
        arguments: { url: "https://example.com" },
      })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(result.isError).toBeFalsy()
      expect(browser.handle.navigate).toHaveBeenCalledWith(
        "https://example.com"
      )
      // No approval event, and nothing was denied by a missing gate.
      expect(events.filter((e) => e.type === "approval")).toHaveLength(0)
      expect(result.content[0].text).not.toContain("denied")
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("returns a screenshot as a real MCP image block", async () => {
    const { injection } = await grantWithBrowser()
    const client = await connect(injection.token, injection.url)
    try {
      const result = (await client.callTool({
        name: "browser_screenshot",
        arguments: {},
      })) as {
        content: Array<{
          type: string
          text?: string
          mimeType?: string
          data?: string
        }>
      }
      const image = result.content.find((c) => c.type === "image")
      expect(image?.mimeType).toBe("image/jpeg")
      expect(image?.data).toBe(
        Buffer.from("fake-jpeg-bytes").toString("base64")
      )
      // The tool's "this context can't display images" fallback must not fire.
      expect(result.content[0].text).not.toContain("can't display images")
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("reads the page through snapshot", async () => {
    const { injection, browser } = await grantWithBrowser()
    const client = await connect(injection.token, injection.url)
    try {
      const result = (await client.callTool({
        name: "browser_snapshot",
        arguments: {},
      })) as { content: Array<{ text: string }> }
      expect(browser.handle.snapshot).toHaveBeenCalled()
      expect(result.content[0].text).toContain("Sign in")
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("routes browser_handoff through the same question panel", async () => {
    const { injection, events } = await grantWithBrowser()
    const client = await connect(injection.token, injection.url)
    try {
      const call = client.callTool({
        name: "browser_handoff",
        arguments: { reason: "Solve the CAPTCHA" },
      })
      for (let i = 0; i < 200 && events.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 10))
      }
      expect(events[0]?.type).toBe("question")
      resolveQuestion(events[0].requestId, [
        { selected: [events[0].questions[0].options[0].label] },
      ])
      const result = (await call) as { isError?: boolean }
      expect(result.isError).toBeFalsy()
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("reports the browser unavailable rather than hanging when none is attached", async () => {
    const { injection } = await grantWithBrowser({ withBrowser: false })
    const client = await connect(injection.token, injection.url)
    try {
      const result = (await client.callTool({
        name: "browser_navigate",
        arguments: { url: "https://example.com" },
      })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("isn't available")
    } finally {
      await client.close()
      injection.revoke()
    }
  })

  it("serves only the browser tools the grant names", async () => {
    const { injection } = await grantWithBrowser({
      tools: ["browser_navigate", "browser_snapshot"],
    })
    const client = await connect(injection.token, injection.url)
    try {
      expect(
        (await client.listTools()).tools.map((t) => t.name).sort()
      ).toEqual(["browser_navigate", "browser_snapshot"])
      // An implemented-but-ungranted tool fails closed.
      const result = (await client.callTool({
        name: "browser_evaluate",
        arguments: { expression: "1+1" },
      })) as { isError?: boolean; content: Array<{ text: string }> }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain("Unknown tool")
    } finally {
      await client.close()
      injection.revoke()
    }
  })
})
