import { app } from "electron"
import path from "path"
import * as settingsService from "../../settings/service"
import { dataDirName, systemDisplayName } from "../../config/system-name"
import type {
  AgentScope,
  AgentSourceKind,
  ExternalAgentSourceKind,
} from "./types"

// The writable user-level agents home: ~/.<system>/agents. `dataDirName()` is
// derived from NEXT_system_name (".cowork" by default) — never hardcoded — so a
// rebrand relocates this dir exactly as it relocates the skills dir.
export function userAgentsDir(): string {
  return path.join(app.getPath("home"), dataDirName(), "agents")
}

// Resolve the ordered agent-source directories for a given workspace. Order
// matters: later sources override earlier ones by name (last-wins), so a
// workspace agent beats a user-level one of the same name. Mirrors skillSources().
//
//   1. user-level — ~/.<system>/agents, the writable home for personal agents.
//   2. custom     — extra folders the user registers in Settings → Capabilities.
//                   Applied across all conversation modes (chat/interactive/
//                   north_star) since they're read here from the settings service.
//   3. workspace  — <workspace>/.github/agents then <workspace>/.<system>/agents.
//                   Both zero-config: scanned when present, ignored otherwise.
//                   .<system>/agents comes last so it's the most-specific
//                   project override on a name collision.
//
// The ".<system>" dir name is customizable via NEXT_system_name (see
// config/system-name.ts); it defaults to ".cowork".
export function agentSources(workspace?: string): string[] {
  return agentSourceEntries(workspace).map((entry) => entry.path)
}

export interface AgentSourceEntry {
  path: string
  kind: AgentSourceKind
  sourceKind: ExternalAgentSourceKind
  scope: AgentScope
  label: string
}

export function agentSourceEntries(workspace?: string): AgentSourceEntry[] {
  const custom = settingsService.getAgentSources().folders
  const dataDir = dataDirName()
  const home = app.getPath("home")
  const entries: AgentSourceEntry[] = [
    {
      path: userAgentsDir(),
      kind: "user",
      sourceKind: "north_star",
      scope: "global",
      label: `Global ${systemDisplayName()}`,
    },
    ...custom.map((sourcePath) => ({
      path: sourcePath,
      kind: "custom" as const,
      sourceKind: "north_star" as const,
      scope: "custom" as const,
      label: path.basename(sourcePath),
    })),
    {
      path: path.join(home, ".copilot", "agents"),
      kind: "copilot",
      sourceKind: "copilot",
      scope: "global",
      label: "Global GitHub Copilot",
    },
    {
      path: path.join(home, ".cursor", "agents"),
      kind: "cursor",
      sourceKind: "cursor",
      scope: "global",
      label: "Global Cursor",
    },
    {
      path: path.join(home, ".claude", "agents"),
      kind: "claude",
      sourceKind: "claude",
      scope: "global",
      label: "Global Claude",
    },
    // Temporarily disabled with the global Codex agent directory: config.toml
    // can register agent TOML files that the lightweight parser cannot load.
    // {
    //   path: path.join(home, ".codex", "config.toml"),
    //   kind: "codex",
    //   sourceKind: "codex",
    //   scope: "global",
    //   label: "Global Codex config",
    // },
    // Temporarily disabled: the lightweight TOML loader does not support the
    // top-level, multiline format used by ~/.codex/agents/*.toml yet.
    // {
    //   path: path.join(home, ".codex", "agents"),
    //   kind: "codex",
    //   sourceKind: "codex",
    //   scope: "global",
    //   label: "Global Codex agents",
    // },
  ]
  if (workspace) {
    entries.push(
      {
        path: path.join(workspace, ".github", "agents"),
        kind: "github",
        sourceKind: "github",
        scope: "workspace",
        label: ".github/agents",
      },
      {
        path: path.join(workspace, ".copilot", "agents"),
        kind: "copilot",
        sourceKind: "copilot",
        scope: "workspace",
        label: ".copilot/agents",
      },
      {
        path: path.join(workspace, ".cursor", "agents"),
        kind: "cursor",
        sourceKind: "cursor",
        scope: "workspace",
        label: ".cursor/agents",
      },
      {
        path: path.join(workspace, ".claude", "agents"),
        kind: "claude",
        sourceKind: "claude",
        scope: "workspace",
        label: ".claude/agents",
      },
      // Temporarily disabled for the same reason as the global Codex config.
      // {
      //   path: path.join(workspace, ".codex", "config.toml"),
      //   kind: "codex",
      //   sourceKind: "codex",
      //   scope: "workspace",
      //   label: ".codex/config.toml",
      // },
      {
        path: path.join(workspace, ".codex", "agents"),
        kind: "codex",
        sourceKind: "codex",
        scope: "workspace",
        label: ".codex/agents",
      },
      {
        path: path.join(workspace, dataDir, "agents"),
        kind: "workspace",
        sourceKind: "north_star",
        scope: "workspace",
        label: `${dataDir}/agents`,
      }
    )
  }
  const seen = new Set<string>()
  return entries.filter((entry) => {
    const key = path.resolve(entry.path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
