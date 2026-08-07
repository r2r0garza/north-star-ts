import { app } from "electron"
import path from "path"
import * as settingsService from "../../settings/service"
import { dataDirName } from "../../config/system-name"

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
  const custom = settingsService.getAgentSources().folders
  const dataDir = dataDirName()
  const sources = [userAgentsDir(), ...custom]
  if (workspace) {
    sources.push(path.join(workspace, ".github", "agents"))
    sources.push(path.join(workspace, dataDir, "agents"))
  }
  return [...new Set(sources)]
}
