import type { McpServer } from "../../db/types"

// The shape the MCP view/UI renders for one server: the file def joined with its
// per-machine state (enabled + hasOauth) and its source. Currently identical to
// McpServer, kept as a named alias so a future derived/masked field has a home
// (mirrors AccountView). Re-exported through preload for the renderer.
export type McpServerView = McpServer

// The mcp.json config-file name discovered inside each source dir. One file holds
// MANY servers, keyed by name (unlike agents, where one file is one agent):
//   { "mcpServers": { "<name>": { command, args, env } | { url, headers } } }
export const MCP_CONFIG_FILENAME = "mcp.json"

// Where an mcp.json was found, mirroring AgentSourceKind:
//   user      — ~/.<system>/mcp.json (the writable personal config)
//   custom    — a folder the user registered in Settings (removable, writable)
//   github    — <workspace>/.github/mcp.json (zero-config, workspace-scoped, RO)
//   workspace — <workspace>/.<system>/mcp.json (workspace-scoped, RO)
export type McpSourceKind = "user" | "custom" | "github" | "workspace"

// One mcp-source directory surfaced to Settings → Capabilities (with a count).
export interface McpSourceRow {
  path: string
  kind: McpSourceKind
  serverCount: number
}

// One source folder as a node in the MCP view's tree: the source dir, a display
// label, and its loaded servers. `kind` drives writability in the UI (user/custom
// editable; github/workspace read-only). Mirrors AgentFolder.
export interface McpFolder {
  path: string
  label: string
  kind: McpSourceKind
  servers: McpServer[]
}

// The nested catalog for the MCP view. Global is the user config; Workspace and
// Custom each expand to a list of folders. Enumerates ALL known workspaces (not
// just the active conversation's) so the view works with no active session.
// Mirrors AgentTree.
export interface McpTree {
  global: McpFolder[]
  workspaces: Array<{ label: string; path: string; folders: McpFolder[] }>
  custom: McpFolder[]
}
