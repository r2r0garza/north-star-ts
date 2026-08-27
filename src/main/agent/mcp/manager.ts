import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import type { McpServer } from "../../db/types"
import type { ToolEffects } from "../tools/types"
import { utf8SafePrefix } from "../tools/output"
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
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 256 * 1024
const DEFAULT_TOOL_ERROR_MAX_BYTES = 8 * 1024
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000
const DEFAULT_DISCOVERY_MAX_TOOLS = 128
const DEFAULT_DISCOVERY_MAX_TOOLS_PER_SERVER = 64
const DEFAULT_DISCOVERY_DESCRIPTION_MAX_BYTES = 4 * 1024
const DEFAULT_DISCOVERY_SCHEMA_MAX_BYTES = 32 * 1024
const DEFAULT_DISCOVERY_TOTAL_MAX_BYTES = 512 * 1024
const DEFAULT_DISCOVERY_SCHEMA_MAX_DEPTH = 24

export const MCP_TOOL_CALL_TIMEOUT_MS = envPositiveInt(
  "COWORK_MCP_TOOL_TIMEOUT_MS",
  DEFAULT_TOOL_CALL_TIMEOUT_MS
)
export const MCP_TOOL_OUTPUT_MAX_BYTES = envPositiveInt(
  "COWORK_MCP_TOOL_OUTPUT_MAX_BYTES",
  DEFAULT_TOOL_OUTPUT_MAX_BYTES
)
export const MCP_TOOL_ERROR_MAX_BYTES = envPositiveInt(
  "COWORK_MCP_TOOL_ERROR_MAX_BYTES",
  DEFAULT_TOOL_ERROR_MAX_BYTES
)
export const MCP_DISCOVERY_TIMEOUT_MS = envPositiveInt(
  "COWORK_MCP_DISCOVERY_TIMEOUT_MS",
  DEFAULT_DISCOVERY_TIMEOUT_MS
)
export const MCP_DISCOVERY_MAX_TOOLS = envPositiveInt(
  "COWORK_MCP_DISCOVERY_MAX_TOOLS",
  DEFAULT_DISCOVERY_MAX_TOOLS
)
export const MCP_DISCOVERY_MAX_TOOLS_PER_SERVER = envPositiveInt(
  "COWORK_MCP_DISCOVERY_MAX_TOOLS_PER_SERVER",
  DEFAULT_DISCOVERY_MAX_TOOLS_PER_SERVER
)
export const MCP_DISCOVERY_DESCRIPTION_MAX_BYTES = envPositiveInt(
  "COWORK_MCP_DISCOVERY_DESCRIPTION_MAX_BYTES",
  DEFAULT_DISCOVERY_DESCRIPTION_MAX_BYTES
)
export const MCP_DISCOVERY_SCHEMA_MAX_BYTES = envPositiveInt(
  "COWORK_MCP_DISCOVERY_SCHEMA_MAX_BYTES",
  DEFAULT_DISCOVERY_SCHEMA_MAX_BYTES
)
export const MCP_DISCOVERY_TOTAL_MAX_BYTES = envPositiveInt(
  "COWORK_MCP_DISCOVERY_TOTAL_MAX_BYTES",
  DEFAULT_DISCOVERY_TOTAL_MAX_BYTES
)
export const MCP_DISCOVERY_SCHEMA_MAX_DEPTH = envPositiveInt(
  "COWORK_MCP_DISCOVERY_SCHEMA_MAX_DEPTH",
  DEFAULT_DISCOVERY_SCHEMA_MAX_DEPTH
)

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
  private async ensureConnected(
    server: McpServer,
    signal?: AbortSignal
  ): Promise<Client> {
    const existing = this.pool.get(server.name)
    if (existing) return existing.client
    const { client, close } = await this.connect(server, signal)
    this.pool.set(server.name, { client, close })
    return client
  }

  // Open a fresh connection to a server (no pooling). Used by ensureConnected and
  // by testConnection (which closes immediately). For an HTTP server with stored
  // OAuth tokens, an OAuth provider is attached so the transport can refresh.
  private async connect(
    server: McpServer,
    signal?: AbortSignal
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
      try {
        await abortable(
          client.connect(transport, {
            signal,
            timeout: MCP_DISCOVERY_TIMEOUT_MS,
            maxTotalTimeout: MCP_DISCOVERY_TIMEOUT_MS,
          }),
          signal
        )
      } catch (err) {
        await transport.close().catch(() => {})
        throw err
      }
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
      await abortable(
        client.connect(transport, {
          signal,
          timeout: MCP_DISCOVERY_TIMEOUT_MS,
          maxTotalTimeout: MCP_DISCOVERY_TIMEOUT_MS,
        }),
        signal
      )
    } catch (err) {
      await transport.close().catch(() => {})
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
    onError?: (serverName: string, error: string) => void,
    signal?: AbortSignal
  ): Promise<McpToolDefinition[]> {
    const all = await loadServers(workspace)
    const wanted = all.filter((s) => s.enabled && serverNames.includes(s.name))
    const defs: McpToolDefinition[] = []
    let totalDefinitionBytes = 0
    await Promise.all(
      wanted.map(async (server) => {
        const scope = makeMcpDiscoveryScope(signal)
        try {
          const client = await this.ensureConnected(server, scope.signal)
          const { tools } = await abortable(
            client.listTools(undefined, {
              signal: scope.signal,
              timeout: MCP_DISCOVERY_TIMEOUT_MS,
              maxTotalTimeout: MCP_DISCOVERY_TIMEOUT_MS,
            }),
            scope.signal
          )
          if (tools.length > MCP_DISCOVERY_MAX_TOOLS_PER_SERVER) {
            onError?.(
              server.name,
              `omitted ${tools.length - MCP_DISCOVERY_MAX_TOOLS_PER_SERVER} MCP tools over the per-server discovery limit of ${MCP_DISCOVERY_MAX_TOOLS_PER_SERVER}.`
            )
          }
          let includedForServer = 0
          for (const tool of tools.slice(
            0,
            MCP_DISCOVERY_MAX_TOOLS_PER_SERVER
          )) {
            if (defs.length >= MCP_DISCOVERY_MAX_TOOLS) {
              onError?.(
                server.name,
                `omitted MCP tool "${tool.name}" because the global discovery limit of ${MCP_DISCOVERY_MAX_TOOLS} tools was reached.`
              )
              break
            }
            const def = buildBoundedToolDefinition(server.name, tool, onError)
            const bytes = Buffer.byteLength(JSON.stringify(def), "utf8")
            if (totalDefinitionBytes + bytes > MCP_DISCOVERY_TOTAL_MAX_BYTES) {
              onError?.(
                server.name,
                `omitted MCP tool "${tool.name}" because the serialized discovery budget of ${MCP_DISCOVERY_TOTAL_MAX_BYTES} bytes was reached.`
              )
              break
            }
            defs.push(def)
            includedForServer += 1
            totalDefinitionBytes += bytes
          }
          if (
            includedForServer === 0 &&
            tools.length > 0 &&
            defs.length >= MCP_DISCOVERY_MAX_TOOLS
          ) {
            onError?.(
              server.name,
              `all MCP tools from "${server.name}" were omitted by the global discovery limit.`
            )
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          // A broken server must never poison the pool — evict it so a later
          // turn retries a fresh connection.
          this.evict(server.name)
          onError?.(server.name, msg)
          console.warn(`[mcp] skipping server "${server.name}": ${msg}`)
        } finally {
          scope.dispose()
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
    workspace?: string,
    signal?: AbortSignal
  ): Promise<string> {
    const parsed = parsePrefixedName(prefixedName)
    if (!parsed) return `ERROR[mcp]: not an MCP tool name: ${prefixedName}`
    const server = await resolveEnabledServer(parsed.serverName, workspace)
    if (!server) {
      return `ERROR[mcp]: no enabled MCP server named "${parsed.serverName}".`
    }
    const callScope = makeMcpCallScope(signal, MCP_TOOL_CALL_TIMEOUT_MS)
    try {
      const client = await this.ensureConnected(server)
      const pending = client.callTool(
        {
          name: parsed.toolName,
          arguments: args,
        },
        undefined,
        {
          signal: callScope.signal,
          timeout: MCP_TOOL_CALL_TIMEOUT_MS,
          maxTotalTimeout: MCP_TOOL_CALL_TIMEOUT_MS,
        }
      )
      const result = await abortable(pending, callScope.signal)
      const text = flattenContent({ content: result.content })
      if (result.isError) return `ERROR[mcp]: ${text}`
      return text
    } catch (err) {
      this.evict(server.name)
      const msg = renderBoundedError(err, callScope.signal)
      return fitMcpTextWithNote(
        `ERROR[mcp]: ${parsed.serverName}.${parsed.toolName} failed: ${msg}`,
        "",
        MCP_TOOL_ERROR_MAX_BYTES
      )
    } finally {
      callScope.dispose()
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
    const scope = makeMcpDiscoveryScope(undefined)
    try {
      const { client, close } = await this.connect(server, scope.signal)
      try {
        const { tools } = await abortable(
          client.listTools(undefined, {
            signal: scope.signal,
            timeout: MCP_DISCOVERY_TIMEOUT_MS,
            maxTotalTimeout: MCP_DISCOVERY_TIMEOUT_MS,
          }),
          scope.signal
        )
        return { ok: true, toolCount: tools.length }
      } finally {
        await close().catch(() => {})
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      scope.dispose()
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

// Join content parts of an MCP tool result into a bounded string, noting
// non-text parts (images/resources) rather than dropping them silently. The
// returned string is capped UTF-8-safely and carries explicit truncation/content
// metadata when the server returns more than the budget.
export function flattenContent(result: { content?: unknown }): string {
  const parts = Array.isArray(result.content)
    ? (result.content as Array<Record<string, unknown>>)
    : []
  const state: FlattenState = {
    chunks: [],
    bytes: 0,
    truncated: false,
    partCount: parts.length,
    includedParts: 0,
    contentTypes: [],
    resources: [],
  }
  for (const part of parts) {
    if (state.truncated) break
    const type = typeof part.type === "string" ? part.type : "content"
    state.contentTypes.push(type)
    state.includedParts += 1
    if (part.type === "text" && typeof part.text === "string") {
      appendMcpChunk(state, part.text)
    } else if (part.type === "image") {
      appendMcpChunk(state, `[image: ${String(part.mimeType ?? "image")}]`)
    } else if (part.type === "resource") {
      const res = part.resource as { uri?: string; text?: string } | undefined
      const uri = res?.uri ?? "unknown"
      state.resources.push(uri)
      appendMcpChunk(state, res?.text ?? `[resource: ${uri}]`)
    } else {
      appendMcpChunk(state, `[${type}]`)
    }
  }
  if (parts.length === 0) return "(no content)"

  const body = state.chunks.join("\n").trim() || "(no content)"
  const metadata = mcpContentMetadata(state)
  if (!state.truncated && metadata === null) return body
  return fitMcpTextWithNote(
    body,
    `[metadata] ${JSON.stringify(metadata)}`,
    MCP_TOOL_OUTPUT_MAX_BYTES
  )
}

interface FlattenState {
  chunks: string[]
  bytes: number
  truncated: boolean
  partCount: number
  includedParts: number
  contentTypes: string[]
  resources: string[]
}

function appendMcpChunk(state: FlattenState, text: string): void {
  const separator = state.chunks.length > 0 ? "\n" : ""
  const available = MCP_TOOL_OUTPUT_MAX_BYTES - state.bytes
  const candidate = `${separator}${text}`
  const candidateBytes = Buffer.byteLength(candidate, "utf8")
  if (candidateBytes <= available) {
    state.chunks.push(text)
    state.bytes += candidateBytes
    return
  }

  state.truncated = true
  const prefix = utf8SafePrefix(candidate, Math.max(0, available)).text
  const chunk =
    state.chunks.length > 0 ? prefix.slice(separator.length) : prefix
  if (chunk) state.chunks.push(chunk)
  state.bytes = MCP_TOOL_OUTPUT_MAX_BYTES
}

function mcpContentMetadata(
  state: FlattenState
): Record<string, unknown> | null {
  if (!state.truncated && state.contentTypes.every((type) => type === "text")) {
    return null
  }
  return {
    truncated: state.truncated,
    maxBytes: MCP_TOOL_OUTPUT_MAX_BYTES,
    partCount: state.partCount,
    includedParts: state.includedParts,
    contentTypes: [...new Set(state.contentTypes)],
    resources: state.resources.slice(0, 20),
    resourcesTruncated: state.resources.length > 20,
  }
}

function fitMcpTextWithNote(
  text: string,
  note: string,
  maxBytes: number
): string {
  if (!note) return utf8SafePrefix(text, maxBytes).text
  const noteBytes = Buffer.byteLength(note, "utf8")
  if (noteBytes >= maxBytes) return utf8SafePrefix(note, maxBytes).text
  const separatorBytes = text.length > 0 ? 1 : 0
  const budget = Math.max(0, maxBytes - noteBytes - separatorBytes)
  const body = utf8SafePrefix(text, budget).text.trimEnd()
  return body ? `${body}\n${note}` : note
}

class McpCallTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`MCP tool call timed out after ${timeoutMs}ms.`)
    this.name = "McpCallTimeoutError"
  }
}

class McpDiscoveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`MCP discovery timed out after ${timeoutMs}ms.`)
    this.name = "McpDiscoveryTimeoutError"
  }
}

function buildBoundedToolDefinition(
  serverName: string,
  tool: {
    name: string
    description?: string
    inputSchema?: unknown
    annotations?: unknown
  },
  onError?: (serverName: string, error: string) => void
): McpToolDefinition {
  const fallbackSchema = { type: "object", properties: {} }
  const rawDescription =
    tool.description ?? `Tool ${tool.name} from ${serverName}.`
  const descriptionNote = `[metadata] MCP description truncated at ${MCP_DISCOVERY_DESCRIPTION_MAX_BYTES} bytes.`
  const description =
    Buffer.byteLength(rawDescription, "utf8") >
    MCP_DISCOVERY_DESCRIPTION_MAX_BYTES
      ? fitMcpTextWithNote(
          rawDescription,
          descriptionNote,
          MCP_DISCOVERY_DESCRIPTION_MAX_BYTES
        )
      : rawDescription
  if (description !== rawDescription) {
    onError?.(
      serverName,
      `truncated MCP tool "${tool.name}" description at ${MCP_DISCOVERY_DESCRIPTION_MAX_BYTES} bytes.`
    )
  }

  let parameters: Record<string, unknown> = fallbackSchema
  if (tool.inputSchema && typeof tool.inputSchema === "object") {
    const schema = tool.inputSchema as Record<string, unknown>
    const schemaBytes = safeJsonBytes(schema)
    const depth = jsonDepth(schema)
    if (schemaBytes > MCP_DISCOVERY_SCHEMA_MAX_BYTES) {
      onError?.(
        serverName,
        `replaced MCP tool "${tool.name}" input schema because it exceeded ${MCP_DISCOVERY_SCHEMA_MAX_BYTES} bytes.`
      )
    } else if (depth > MCP_DISCOVERY_SCHEMA_MAX_DEPTH) {
      onError?.(
        serverName,
        `replaced MCP tool "${tool.name}" input schema because it exceeded depth ${MCP_DISCOVERY_SCHEMA_MAX_DEPTH}.`
      )
    } else {
      parameters = schema
    }
  } else if (tool.inputSchema !== undefined) {
    onError?.(
      serverName,
      `replaced MCP tool "${tool.name}" input schema because it was not an object.`
    )
  }

  return {
    effects: effectsFromMcpTool(tool),
    type: "function",
    function: {
      name: prefixedToolName(serverName, tool.name),
      description,
      parameters,
    },
  }
}

function safeJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8")
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function jsonDepth(value: unknown, seen = new WeakSet<object>()): number {
  if (!value || typeof value !== "object") return 0
  if (seen.has(value)) return Number.POSITIVE_INFINITY
  seen.add(value)
  const entries = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>)
  let max = 0
  for (const child of entries) {
    max = Math.max(max, jsonDepth(child, seen))
  }
  seen.delete(value)
  return max + 1
}

function makeMcpDiscoveryScope(parent: AbortSignal | undefined): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new McpDiscoveryTimeoutError(MCP_DISCOVERY_TIMEOUT_MS))
  }, MCP_DISCOVERY_TIMEOUT_MS)
  ;(timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()

  const abortFromParent = () => {
    controller.abort(
      parent?.reason ??
        new DOMException("The operation was aborted.", "AbortError")
    )
  }
  if (parent?.aborted) abortFromParent()
  else parent?.addEventListener("abort", abortFromParent, { once: true })

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      parent?.removeEventListener("abort", abortFromParent)
    },
  }
}

function makeMcpCallScope(
  parent: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort(new McpCallTimeoutError(timeoutMs))
  }, timeoutMs)
  ;(timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()

  const abortFromParent = () => {
    controller.abort(
      parent?.reason ??
        new DOMException("The operation was aborted.", "AbortError")
    )
  }
  if (parent?.aborted) abortFromParent()
  else parent?.addEventListener("abort", abortFromParent, { once: true })

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      parent?.removeEventListener("abort", abortFromParent)
    },
  }
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort)
      reject(abortReason(signal))
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      }
    )
  })
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  )
}

function renderBoundedError(err: unknown, signal: AbortSignal): string {
  let msg: string
  if (signal.aborted) {
    const reason = abortReason(signal)
    msg =
      reason instanceof McpCallTimeoutError
        ? reason.message
        : "The MCP tool call was cancelled."
  } else {
    msg = err instanceof Error ? err.message : String(err)
  }
  return utf8SafePrefix(msg, MCP_TOOL_ERROR_MAX_BYTES).text
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
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
