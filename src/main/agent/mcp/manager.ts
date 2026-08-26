import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import type { McpServer } from "../../db/types"
import type { ToolEffects } from "../tools/types"
import { systemDisplayName } from "../../config/system-name"
import { McpOAuthProvider, startCallbackListener } from "./oauth"
import { loadServers, resolveEnabledServer } from "./resolve"

// The manager owns the live pool of MCP client connections. Connections are LAZY
// (opened on first use), POOLED (a connected client is reused across turns), and
// RESILIENT (a server that fails to connect is skipped, never aborting a batch).
//
// Server DEFINITIONS come from mcp.json files (via ./resolve — merged with the
// side-store enabled/OAuth state); the pool is keyed by server NAME (the mcp.json
// object key + tool prefix). Tools are exposed to the agent loop namespaced as
// `mcp__<server>__<tool>` so tools from different servers never collide and
// callTool can route by prefix.

// The separator between the server slug and the tool name in the prefixed name.
// Double underscore keeps it distinguishable from underscores inside either part.
const PREFIX = "mcp__"
const SEP = "__"

// A tool definition in the OpenAI-compatible shape the agent loop's `tools` array
// expects (same shape as Tool.definition in ../tools/types).
export interface McpToolDefinition {
  effects: ToolEffects
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

function effectsFromMcpTool(tool: { annotations?: unknown }): ToolEffects {
  const annotations =
    tool.annotations && typeof tool.annotations === "object"
      ? (tool.annotations as Record<string, unknown>)
      : {}
  const readOnly = annotations.readOnlyHint === true
  const destructive = annotations.destructiveHint === true
  return {
    readOnly,
    parallelSafe: false,
    idempotent: annotations.idempotentHint === true || readOnly,
    destructive,
    openWorld: true,
  }
}

// Build the agent-facing prefixed tool name for a server's tool.
export function prefixedToolName(serverName: string, toolName: string): string {
  return `${PREFIX}${serverName}${SEP}${toolName}`
}

// Parse a prefixed name back into (serverName, toolName). Returns null if the name
// isn't an MCP tool name. The server slug never contains "__" (validated
// [a-z0-9-]), so the FIRST "__" after the prefix splits server from tool.
export function parsePrefixedName(
  name: string
): { serverName: string; toolName: string } | null {
  if (!name.startsWith(PREFIX)) return null
  const rest = name.slice(PREFIX.length)
  const idx = rest.indexOf(SEP)
  if (idx <= 0) return null
  return {
    serverName: rest.slice(0, idx),
    toolName: rest.slice(idx + SEP.length),
  }
}

// A pooled, connected client plus the transport close fn. Keyed by server name.
interface PooledClient {
  client: Client
  close: () => Promise<void>
}

export class McpManager {
  private pool = new Map<string, PooledClient>()

  // Ensure a connected client for the given server, reusing a pooled one. Throws
  // (with a useful message) if the server can't be reached or needs auth — callers
  // that batch (listToolsFor) catch per-server so one failure is isolated.
  private async ensureConnected(server: McpServer): Promise<Client> {
    const existing = this.pool.get(server.name)
    if (existing) return existing.client
    const { client, close } = await this.connect(server)
    this.pool.set(server.name, { client, close })
    return client
  }

  // Open a fresh connection to a server (no pooling). Used by ensureConnected and
  // by testConnection (which closes immediately). For an HTTP server with stored
  // OAuth tokens, an OAuth provider is attached so the transport can refresh.
  private async connect(
    server: McpServer
  ): Promise<{ client: Client; close: () => Promise<void> }> {
    const client = new Client({
      name: systemDisplayName(),
      version: "1.0.0",
    })

    if (server.transport === "stdio") {
      if (!server.command) {
        throw new Error(
          `MCP server "${server.name}" has no command configured.`
        )
      }
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args,
        // Merge configured env over the inherited default env (PATH, etc.).
        env: { ...getInheritedEnv(), ...server.env },
      })
      await client.connect(transport)
      return { client, close: () => transport.close() }
    }

    // HTTP transport.
    if (!server.url) {
      throw new Error(`MCP server "${server.name}" has no URL configured.`)
    }
    const url = new URL(server.url)
    // Attach an OAuth provider only if a token set is already stored; a plain
    // (no-auth or header-auth) server connects without one. The interactive
    // authorize() path handles first-time OAuth separately.
    const authProvider = server.hasOauth
      ? new McpOAuthProvider(
          server.name,
          server.name,
          // Redirect URL is unused on a token-refresh-only connection; a
          // placeholder loopback keeps clientMetadata well-formed.
          "http://127.0.0.1:0/callback"
        )
      : undefined
    const transport = new StreamableHTTPClientTransport(url, {
      authProvider,
      requestInit: hasHeaders(server) ? { headers: server.headers } : undefined,
    })
    try {
      await client.connect(transport)
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        throw new Error(
          `MCP server "${server.name}" requires authorization. Click "Authorize" in the MCP view.`
        )
      }
      throw err
    }
    return { client, close: () => transport.close() }
  }

  // List the tools offered by the given enabled servers (resolved from files for
  // `workspace`), namespaced. Resilient: a server that fails to connect/list is
  // skipped and the error surfaced via onError (the caller logs it); the batch
  // always returns whatever connected.
  async listToolsFor(
    serverNames: string[],
    workspace: string | undefined,
    onError?: (serverName: string, error: string) => void
  ): Promise<McpToolDefinition[]> {
    const all = await loadServers(workspace)
    const wanted = all.filter((s) => s.enabled && serverNames.includes(s.name))
    const defs: McpToolDefinition[] = []
    await Promise.all(
      wanted.map(async (server) => {
        try {
          const client = await this.ensureConnected(server)
          const { tools } = await client.listTools()
          for (const tool of tools) {
            defs.push({
              effects: effectsFromMcpTool(tool),
              type: "function",
              function: {
                name: prefixedToolName(server.name, tool.name),
                description:
                  tool.description ?? `Tool ${tool.name} from ${server.name}.`,
                // MCP's inputSchema IS a JSON Schema object — pass it straight
                // through as the function parameters. Fall back to an empty
                // object schema when a tool declares no inputs.
                parameters: (tool.inputSchema as
                  | Record<string, unknown>
                  | undefined) ?? {
                  type: "object",
                  properties: {},
                },
              },
            })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // A broken server must never poison the pool — evict it so a later
          // turn retries a fresh connection.
          this.evict(server.name)
          onError?.(server.name, msg)
          console.warn(`[mcp] skipping server "${server.name}": ${msg}`)
        }
      })
    )
    return defs
  }

  // Route a prefixed tool call to the owning server's client and flatten the MCP
  // content result to a string the agent loop persists as the tool result. The
  // server def is resolved from files for `workspace`.
  async callTool(
    prefixedName: string,
    args: Record<string, unknown>,
    workspace?: string
  ): Promise<string> {
    const parsed = parsePrefixedName(prefixedName)
    if (!parsed) return `ERROR[mcp]: not an MCP tool name: ${prefixedName}`
    const server = await resolveEnabledServer(parsed.serverName, workspace)
    if (!server) {
      return `ERROR[mcp]: no enabled MCP server named "${parsed.serverName}".`
    }
    try {
      const client = await this.ensureConnected(server)
      const result = await client.callTool({
        name: parsed.toolName,
        arguments: args,
      })
      const text = flattenContent({ content: result.content })
      if (result.isError) return `ERROR[mcp]: ${text}`
      return text
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.evict(server.name)
      return `ERROR[mcp]: ${parsed.serverName}.${parsed.toolName} failed: ${msg}`
    }
  }

  // Connect on demand and report the discovered tool count, without pooling — the
  // "Test connection" button. Resolves the server by name for `workspace`.
  async testConnection(
    serverName: string,
    workspace?: string
  ): Promise<{ ok: boolean; toolCount?: number; error?: string }> {
    const server = (await loadServers(workspace)).find(
      (s) => s.name === serverName
    )
    if (!server) return { ok: false, error: "Server not found." }
    try {
      const { client, close } = await this.connect(server)
      try {
        const { tools } = await client.listTools()
        return { ok: true, toolCount: tools.length }
      } finally {
        await close().catch(() => {})
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // Run the interactive OAuth authorization flow for an HTTP server: start a
  // loopback callback listener, attempt a connect (which triggers the browser
  // redirect via the provider), wait for the callback code, finishAuth, and
  // reconnect on a fresh transport to confirm. Tokens are persisted by the
  // provider's saveTokens (keyed by server name). Resolves ok/error.
  async authorize(
    serverName: string,
    workspace?: string
  ): Promise<{ ok: boolean; error?: string }> {
    const server = (await loadServers(workspace)).find(
      (s) => s.name === serverName
    )
    if (!server) return { ok: false, error: "Server not found." }
    if (server.transport !== "http" || !server.url) {
      return { ok: false, error: "OAuth is only supported for HTTP servers." }
    }
    // Evict any pooled (possibly unauthorized) connection first.
    await this.evictAsync(server.name)

    const provider = new McpOAuthProvider(
      server.name,
      server.name,
      "http://127.0.0.1:0/callback"
    )
    // We need the callback listener's port BEFORE the redirect is built, so the
    // provider advertises the right redirect_uri. state() is called by the SDK
    // during connect; we pre-generate one to bind the listener's CSRF check.
    const expectedState = provider.state()
    const listener = await startCallbackListener(expectedState)
    provider.setRedirectUrl(listener.redirectUrl)

    const url = new URL(server.url)
    try {
      const transport = new StreamableHTTPClientTransport(url, {
        authProvider: provider,
        requestInit: hasHeaders(server)
          ? { headers: server.headers }
          : undefined,
      })
      const client = new Client({ name: systemDisplayName(), version: "1.0.0" })
      try {
        await client.connect(transport)
        // Already authorized (tokens still valid) — nothing more to do.
        listener.close()
        await transport.close().catch(() => {})
        return { ok: true }
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err
        // The provider has opened the browser; wait for the redirect callback.
        const code = await listener.code
        await transport.finishAuth(code)
        await transport.close().catch(() => {})
        // Reconnect on a FRESH transport to confirm the tokens work (a started
        // transport cannot be restarted).
        const confirmTransport = new StreamableHTTPClientTransport(url, {
          authProvider: provider,
          requestInit: hasHeaders(server)
            ? { headers: server.headers }
            : undefined,
        })
        const confirmClient = new Client({
          name: systemDisplayName(),
          version: "1.0.0",
        })
        await confirmClient.connect(confirmTransport)
        await confirmTransport.close().catch(() => {})
        return { ok: true }
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      listener.close()
    }
  }

  // Drop a pooled client (e.g. after its config changed or it errored) WITHOUT
  // awaiting the close — fire-and-forget so callers stay synchronous. Keyed by
  // server name.
  evict(serverName: string): void {
    const pooled = this.pool.get(serverName)
    if (!pooled) return
    this.pool.delete(serverName)
    void pooled.close().catch(() => {})
  }

  // Await variant, for paths that must ensure the old connection is gone before
  // opening a new one (authorize).
  async evictAsync(serverName: string): Promise<void> {
    const pooled = this.pool.get(serverName)
    if (!pooled) return
    this.pool.delete(serverName)
    await pooled.close().catch(() => {})
  }

  // Disconnect every pooled client. Called on app quit.
  async disposeAll(): Promise<void> {
    const clients = [...this.pool.values()]
    this.pool.clear()
    await Promise.all(clients.map((c) => c.close().catch(() => {})))
  }
}

// Join text content parts of an MCP tool result into a single string, noting
// non-text parts (images/resources) rather than dropping them silently. Typed
// loosely because the SDK's content union is richer than we narrow here.
function flattenContent(result: { content?: unknown }): string {
  const parts = Array.isArray(result.content)
    ? (result.content as Array<Record<string, unknown>>)
    : []
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      chunks.push(part.text)
    } else if (part.type === "image") {
      chunks.push(`[image: ${String(part.mimeType ?? "image")}]`)
    } else if (part.type === "resource") {
      const res = part.resource as { uri?: string; text?: string } | undefined
      chunks.push(res?.text ?? `[resource: ${res?.uri ?? "unknown"}]`)
    } else {
      chunks.push(`[${String(part.type ?? "content")}]`)
    }
  }
  return chunks.join("\n").trim() || "(no content)"
}

function hasHeaders(server: McpServer): boolean {
  return Object.keys(server.headers).length > 0
}

// The env a spawned stdio server inherits: the current process env (PATH, HOME,
// …). Configured env vars are merged over this in connect().
function getInheritedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v
  }
  return env
}
