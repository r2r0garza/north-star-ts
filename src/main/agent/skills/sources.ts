import { app } from "electron"
import path from "path"

// Resolve the ordered skill source directories for a given workspace.
// Order matters: later sources override earlier ones by name (last-wins), so
// project skills beat user skills, which beat the app-bundled defaults.
//
//   1. app-bundled  — ships with the app (read-only in a packaged build).
//   2. user-level   — ~/.cowork/skills, the writable home for user skills.
//   3. workspace    — <workspace>/.cowork/skills, project-specific.
export function skillSources(workspace?: string): string[] {
  const sources = [
    path.join(app.getAppPath(), "skills"),
    path.join(app.getPath("home"), ".cowork", "skills"),
  ]
  if (workspace) sources.push(path.join(workspace, ".cowork", "skills"))
  return sources
}
