import { app } from "electron"
import path from "path"
import * as settingsService from "../../settings/service"
import { dataDirName } from "../../config/system-name"
import { MCP_CONFIG_FILENAME, type McpSourceKind } from "./types"

// The writable user-level MCP config dir: ~/.<system>. `dataDirName()` is derived
// from NEXT_system_name (".cowork" by default) — never hardcoded — so a rebrand
// relocates this exactly as it relocates the agents/skills dirs. The mcp.json
// lives directly in this dir (not a subfolder), mirroring the ecosystem where a
// single config file holds every server.
export function userMcpDir(): string {
  return path.join(app.getPath("home"), dataDirName())
}

// One MCP-source directory tagged with its kind, in load order. Later sources
// override earlier ones by server name (last-wins), so a workspace mcp.json beats
// a user-level one on a name collision. Mirrors agentSourceEntries().
//
//   1. user      — ~/.<system>/mcp.json
//   2. custom    — folders registered in Settings → Capabilities
//   3. github    — <workspace>/.github/mcp.json
//   4. workspace — <workspace>/.<system>/mcp.json (most-specific override)
export function mcpSourceEntries(
  workspace?: string
): Array<{ dir: string; kind: McpSourceKind }> {
  const custom = settingsService.getMcpSources().folders
  const dataDir = dataDirName()
  const entries: Array<{ dir: string; kind: McpSourceKind }> = [
    { dir: userMcpDir(), kind: "user" },
    ...custom.map((dir) => ({ dir, kind: "custom" as const })),
  ]
  if (workspace) {
    entries.push({ dir: path.join(workspace, ".github"), kind: "github" })
    entries.push({ dir: path.join(workspace, dataDir), kind: "workspace" })
  }
  return entries
}

// The ordered mcp.json file paths for a workspace (deduped), for the loader.
export function mcpSources(workspace?: string): string[] {
  return [
    ...new Set(
      mcpSourceEntries(workspace).map((e) =>
        path.join(e.dir, MCP_CONFIG_FILENAME)
      )
    ),
  ]
}
