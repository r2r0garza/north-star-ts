import path from "path"
import type { McpServer, McpServerDef } from "../../db/types"
import * as mcpState from "../../db/repositories/mcp-servers"
import { loadConfigFile } from "./loader"
import { MCP_CONFIG_FILENAME, type McpSourceKind } from "./types"
import { mcpSourceEntries } from "./sources"

// Join a file-parsed server def with its per-machine side-store state (enabled +
// hasOauth) and its source file, producing the McpServer the UI/manager consume.
function join(
  def: McpServerDef,
  filePath: string,
  sourceDir: string,
  oauthNames: Set<string>
): McpServer {
  return {
    ...def,
    path: filePath,
    source: sourceDir,
    enabled: mcpState.isEnabled(def.name),
    hasOauth: oauthNames.has(def.name),
  }
}

// Load the servers defined in a single source dir's mcp.json, joined with state.
export async function listServersInSource(
  sourceDir: string
): Promise<McpServer[]> {
  const filePath = path.join(sourceDir, MCP_CONFIG_FILENAME)
  const defs = await loadConfigFile(filePath)
  const oauthNames = mcpState.oauthNameSet()
  return defs.map((d) => join(d, filePath, sourceDir, oauthNames))
}

// Load ALL servers discoverable for a workspace, in source order with last-wins
// dedupe by name (a workspace mcp.json overrides a user-level one). Mirrors
// loadAgents. Each result carries the winning source's path/kind context.
export async function loadServers(workspace?: string): Promise<McpServer[]> {
  const oauthNames = mcpState.oauthNameSet()
  const byName = new Map<string, McpServer>()
  for (const { dir } of mcpSourceEntries(workspace)) {
    const filePath = path.join(dir, MCP_CONFIG_FILENAME)
    for (const def of await loadConfigFile(filePath)) {
      byName.set(def.name, join(def, filePath, dir, oauthNames))
    }
  }
  return [...byName.values()]
}

// The names of the ENABLED servers for a workspace — the set an unrestricted
// agent may use, and the pool the resolver hands to the agent loop.
export async function enabledServerNames(
  workspace?: string
): Promise<string[]> {
  return (await loadServers(workspace))
    .filter((s) => s.enabled)
    .map((s) => s.name)
}

// Resolve a single enabled server by name for a workspace (for the manager's
// connect path). Returns null if not found or disabled.
export async function resolveEnabledServer(
  name: string,
  workspace?: string
): Promise<McpServer | null> {
  const server = (await loadServers(workspace)).find((s) => s.name === name)
  return server && server.enabled ? server : null
}

// The kind of a source dir, for classifying a discovered server's writability.
export function sourceKindOf(
  sourceDir: string,
  workspace?: string
): McpSourceKind | null {
  const match = mcpSourceEntries(workspace).find(
    (e) => path.resolve(e.dir) === path.resolve(sourceDir)
  )
  return match?.kind ?? null
}
