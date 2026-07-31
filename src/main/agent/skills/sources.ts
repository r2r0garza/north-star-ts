import { app } from "electron"
import path from "path"
import * as settingsService from "../../settings/service"

// Resolve the ordered skill source directories for a given workspace.
// Order matters: later sources override earlier ones by name (last-wins), so
// project skills beat user skills, which beat the app-bundled defaults.
//
//   1. app-bundled  — ships with the app (read-only in a packaged build).
//   2. user-level   — ~/.cowork/skills, the writable home for user skills.
//   3. custom        — extra folders the user registers in Settings → Capabilities.
//   4. workspace     — <workspace>/.github/skills then <workspace>/.cowork/skills.
//                      Both are zero-config: scanned when present, ignored otherwise.
//                      .cowork/skills comes last so it remains the most-specific
//                      project override on a name collision.
//
// Custom folders are read from the settings service here so every caller
// (the agent turn and the skills:list IPC) picks them up without threading a
// param through. Duplicates are removed, keeping the first occurrence's position.
export function skillSources(workspace?: string): string[] {
  const custom = settingsService.getSkillSources().folders
  const sources = [
    path.join(app.getAppPath(), "skills"),
    path.join(app.getPath("home"), ".cowork", "skills"),
    ...custom,
  ]
  if (workspace) {
    sources.push(path.join(workspace, ".github", "skills"))
    sources.push(path.join(workspace, ".cowork", "skills"))
  }
  return [...new Set(sources)]
}
