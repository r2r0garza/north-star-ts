import { createServer, type IncomingMessage, type ServerResponse } from "http"
import type { AddressInfo } from "net"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { mintGrant, resolveGrant, revokeAllGrants } from "./grants"
import {
  askUserQuestionMcpTool,
  callAskUserQuestion,
} from "./tools/ask-user-question"
import { browserMcpTools, callBrowserTool } from "./tools/browser"
import {
  CLI_MCP_SERVER_NAME,
  CLI_MCP_TOKEN_ENV,
  type CliMcpGrant,
  type CliMcpInjection,
  type CliMcpProvider,
  type CliMcpBrowserSink,
  type CliMcpQuestionSink,
  type CliMcpToolName,
} from "./types"

// The one path the bridge answers on. Anything else 404s before authentication.
const MCP_PATH = "/mcp"
// JSON-RPC envelopes only — no file or blob uploads cross this bridge.
const MAX_BODY_BYTES = 256 * 1024
// A CLI turn issues one tool call at a time; the ceiling only exists so a
// misbehaving (or replaying) client can't pin the main process.
const MAX_CONCURRENT_REQUESTS = 16

// Identical response for missing, malformed, unknown, expired, and revoked
// tokens, so a caller learns nothing from the difference.
const UNAUTHORIZED = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32001, message: "Unauthorized" },
  id: null,
})

// Fully-qualified tool name as each client namespaces it. Claude prefixes MCP
// tools with `mcp__<server>__`; Codex joins with `__`.
export function qualifyToolName(
  provider: CliMcpProvider,
  tool: string
): string {
  return provider === "claude_code"
    ? `mcp__${CLI_MCP_SERVER_NAME}__${tool}`
    : `${CLI_MCP_SERVER_NAME}__${tool}`
}

interface Bridge {
  url: string
  close: () => Promise<void>
}

let bridge: Bridge | null = null
let starting: Promise<Bridge> | null = null
let inFlight = 0

// The tools this grant may see: the intersection of what the server implements
// and what the grant allows. Unknown names never reach here (mintGrant filters).
function grantedTools(grant: CliMcpGrant) {
  const tools: Array<{
    name: string
    description: string
    inputSchema: { type: "object"; [key: string]: unknown }
    annotations?: Record<string, unknown>
  }> = []
  if (grant.allowedTools.has("ask_user_question")) {
    tools.push(askUserQuestionMcpTool)
  }
  for (const tool of browserMcpTools) {
    if (grant.allowedTools.has(tool.name as CliMcpToolName)) tools.push(tool)
  }
  return tools
}

// Server instructions, returned on `initialize` and surfaced to the model by
// both CLIs. This is the in-protocol place to say how the server is meant to be
// used — a tool description alone loses to a CLI's own strong habit of just
// asking in prose. Deliberately narrow: it steers toward the granted tools and
// explicitly cedes everything else to the CLI's native ones, so it stays a
// server describing itself rather than North Star injecting a system prompt.
function buildInstructions(grant: CliMcpGrant): string | undefined {
  const lines: string[] = []
  if (grant.allowedTools.has("ask_user_question")) {
    lines.push(
      "Use `ask_user_question` whenever you would otherwise end your turn to ask the " +
        "user something — an ambiguous request, a fork in approach, a missing detail. " +
        "It renders a form with clickable options in the app and returns their answer " +
        "to you, so the turn keeps going instead of stopping for them to type a reply. " +
        "Asking in prose still reaches them, but costs them a round trip you don't have " +
        "to spend."
    )
  }
  if (grant.allowedTools.has("browser_navigate")) {
    lines.push(
      "The browser tools drive a real browser window inside North Star that the " +
        "user may be watching — not a headless fetch. Use them to open a page, " +
        "read it with `browser_snapshot`, see it with `browser_screenshot`, and " +
        "interact with it. `browser_handoff` passes control to the user for " +
        "anything only a human can do, such as a CAPTCHA or a login."
    )
  }
  if (lines.length === 0) return undefined
  return [
    "North Star is the desktop app hosting this session. The user is watching in its " +
      "UI, not a terminal.",
    ...lines,
    "These tools are additions to your own. Reading, editing, searching, and running " +
      "commands all stay with your native tools.",
  ].join("\n\n")
}

// A short line appended to Claude's own system prompt naming the granted tools.
//
// This exists because the gentler levers measurably do not work. Live against
// `claude -p` on the prompt "ask me a multiple choice question", Claude wrote the
// question as prose 6/6 times — 3 with a hedged tool description, 3 with a blunt
// imperative one — with MCP server instructions present in both. With this line
// it called the tool 4/4. Claude Code's own prompt steers hard toward asking
// directly, and neither a tool description nor server instructions outrank it.
//
// Deliberately narrow: it names this bridge's tools and nothing else. North Star
// mode prompts, skills, and the internal tool registry stay out of CLI turns
// (plan 045, Out of scope). Codex has no per-run append flag, so it relies on the
// tool description alone.
export function buildSystemPromptSteering(
  grant: CliMcpGrant,
  provider: CliMcpProvider
): string | null {
  if (!grant.allowedTools.has("ask_user_question")) return null
  const tool = qualifyToolName(provider, "ask_user_question")
  return (
    "You are running inside the North Star desktop app; the user is watching in its UI, " +
    "not a terminal. When you need something from the user — a choice between approaches, " +
    "a missing detail, or any question you would otherwise end your turn to ask — call the " +
    `${tool} tool instead of writing the question as prose.`
  )
}

// One MCP server per request. Stateless Streamable HTTP needs no session map,
// and building the server from the authenticated grant means tool registration
// is scoped to the caller rather than filtered after the fact.
function buildServer(grant: CliMcpGrant): Server {
  const server = new Server(
    { name: CLI_MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: buildInstructions(grant) }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: grantedTools(grant),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name as CliMcpToolName
    // Fail closed: a tool this grant doesn't hold is reported as unknown, the
    // same as a name the server never implemented.
    if (!grant.allowedTools.has(name)) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        isError: true,
      }
    }
    if (name === "ask_user_question") {
      return callAskUserQuestion(request.params.arguments, grant)
    }
    return callBrowserTool(name, request.params.arguments, grant)
  })
  return server
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function send(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) return
  res.writeHead(status, { "content-type": "application/json" })
  res.end(body)
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  allowedHosts: string[]
): Promise<void> {
  const path = (req.url ?? "").split("?")[0]
  if (path !== MCP_PATH) {
    send(res, 404, JSON.stringify({ error: "not_found" }))
    return
  }
  // Stateless: no standalone SSE stream to open and no session to delete.
  if (req.method !== "POST") {
    res.setHeader("allow", "POST")
    send(res, 405, JSON.stringify({ error: "method_not_allowed" }))
    return
  }

  // Authenticate BEFORE any MCP handling — initialize, list, and call all
  // require a live grant.
  const grant = resolveGrant(req.headers.authorization)
  if (!grant) {
    send(res, 401, UNAUTHORIZED)
    return
  }

  if (inFlight >= MAX_CONCURRENT_REQUESTS) {
    send(res, 429, JSON.stringify({ error: "too_many_requests" }))
    return
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readBody(req))
  } catch (error) {
    const tooLarge =
      error instanceof Error && error.message === "payload_too_large"
    send(
      res,
      tooLarge ? 413 : 400,
      JSON.stringify({ error: tooLarge ? "payload_too_large" : "invalid_json" })
    )
    return
  }

  inFlight += 1
  const transport = new StreamableHTTPServerTransport({
    // Stateless: no server-push, subscriptions, or transport session state.
    sessionIdGenerator: undefined,
    // Loopback belt-and-braces on top of the bind address. An absent Origin
    // (every CLI client) passes; a browser-supplied one must match.
    enableDnsRebindingProtection: true,
    allowedHosts,
    allowedOrigins: allowedHosts.map((host) => `http://${host}`),
  })
  const server = buildServer(grant)
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, parsed)
  } catch (error) {
    // Never leak a stack trace, absolute path, or token to the client.
    console.error("[mcp-bridge] request failed:", error)
    send(res, 500, JSON.stringify({ error: "internal_error" }))
  } finally {
    inFlight -= 1
    res.on("close", () => {
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    })
  }
}

async function start(): Promise<Bridge> {
  const http = createServer()
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject)
    // Loopback only, ephemeral port. Never 0.0.0.0, never a fixed port.
    http.listen(0, "127.0.0.1", () => {
      http.removeListener("error", reject)
      resolve()
    })
  })
  const port = (http.address() as AddressInfo).port
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  http.on("request", (req, res) => {
    void handle(req, res, allowedHosts).catch((error) => {
      console.error("[mcp-bridge] unhandled request error:", error)
      send(res, 500, JSON.stringify({ error: "internal_error" }))
    })
  })
  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections?.()
        http.close(() => resolve())
      }),
  }
}

// Start the listener on first use and keep it for the app process lifetime.
// Concurrent callers share one start.
export function getCliMcpBridge(): Promise<Bridge> {
  if (bridge) return Promise.resolve(bridge)
  if (!starting) {
    starting = start()
      .then((started) => {
        bridge = started
        return started
      })
      .finally(() => {
        starting = null
      })
  }
  return starting
}

export interface GrantCliMcpAccessInput {
  conversationId: string
  workingDirectory: string
  // null for a Chat conversation: its CLI working directory is app-owned, not an
  // indexed project, so workspace-scoped tools are simply not granted.
  workspace: string | null
  provider: CliMcpProvider
  tools: readonly CliMcpToolName[]
  question?: CliMcpQuestionSink | null
  browser?: CliMcpBrowserSink | null
}

// Mint a per-turn grant and return everything the runner needs to inject the
// bridge into its child. Throws if the listener can't start — the caller must
// fail the turn rather than run with a partial contract.
export async function grantCliMcpAccess(
  input: GrantCliMcpAccessInput
): Promise<CliMcpInjection> {
  const started = await getCliMcpBridge()
  const minted = mintGrant({
    conversationId: input.conversationId,
    workingDirectory: input.workingDirectory,
    workspace: input.workspace,
    provider: input.provider,
    tools: input.tools,
    question: input.question ?? null,
    browser: input.browser ?? null,
  })
  return {
    url: started.url,
    tokenEnv: CLI_MCP_TOKEN_ENV,
    token: minted.token,
    allowedTools: [...minted.grant.allowedTools].map((tool) =>
      qualifyToolName(input.provider, tool)
    ),
    systemPromptSteering: buildSystemPromptSteering(
      minted.grant,
      input.provider
    ),
    revoke: minted.revoke,
  }
}

// Torn down from Electron's will-quit path alongside the MCP client pool.
export async function closeCliMcpBridge(): Promise<void> {
  revokeAllGrants()
  const current = bridge
  bridge = null
  if (current) await current.close()
}
