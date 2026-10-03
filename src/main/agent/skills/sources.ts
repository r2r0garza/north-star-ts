import { app } from "electron"
import path from "path"
import {
  bundledSeedManifestPath,
  seedBundledEntries,
} from "../../config/bundled-seed"
import * as settingsService from "../../settings/service"
import { dataDirName } from "../../config/system-name"

// The read-only skills that ship with the app: <app>/skills. In dev this is the
// repo's skills/ folder; when packaged it's bundled via build.files. No longer a
// live load source — instead it seeds the user-level dir once (see initUserSkills).
export function bundledSkillsDir(): string {
  return path.join(app.getAppPath(), "skills")
}

// The writable user-level skills home: ~/.<system>/skills. Its parent (~/.<system>)
// is the app's on-disk data dir. Kept as a single resolver so skillSources() and
// the startup seeder agree on the path.
export function userSkillsDir(): string {
  return path.join(app.getPath("home"), dataDirName(), "skills")
}

// Startup setup for the user-level skills dir: creates ~/.<system>/skills and
// copies in any app-bundled skill not seeded before. Seeding is tracked per skill
// in ~/.<system>/bundled-seed.json, so a user's edits/deletions to the built-ins
// stick across restarts (we never overwrite or resurrect), while built-ins added
// in a later release still arrive. See config/bundled-seed.ts. Called at startup.
export function initUserSkills(): void {
  seedBundledEntries({
    kind: "skills",
    bundledDir: bundledSkillsDir(),
    userDir: userSkillsDir(),
    manifestPath: bundledSeedManifestPath(),
  })
}

// Resolve the ordered skill source directories for a given workspace.
// Order matters: later sources override earlier ones by name (last-wins), so
// project skills beat user skills.
//
//   1. user-level   — ~/.<system>/skills, the writable home for user skills. Each
//                      app-bundled skill is copied here once, tracked per skill
//                      (see initUserSkills), so the built-ins live here as
//                      editable copies rather than being scanned read-only.
//   2. custom        — extra folders the user registers in Settings → Capabilities.
//   3. workspace     — <workspace>/.github/skills then <workspace>/.<system>/skills.
//                      Both are zero-config: scanned when present, ignored otherwise.
//                      .<system>/skills comes last so it remains the most-specific
//                      project override on a name collision.
//
// The app-bundled <app>/skills dir is deliberately NOT a live source — it only
// seeds the user dir (each skill once), so a user who edits or deletes a built-in isn't
// overridden by (or unable to remove) the shipped copy.
//
// The ".<system>" dir name is customizable via NEXT_system_name (see
// config/system-name.ts); it defaults to ".cowork".
//
// Custom folders are read from the settings service here so every caller
// (the agent turn and the skills:list IPC) picks them up without threading a
// param through. Duplicates are removed, keeping the first occurrence's position.
export function skillSources(workspace?: string): string[] {
  const custom = settingsService.getSkillSources().folders
  const dataDir = dataDirName()
  const sources = [userSkillsDir(), ...custom]
  if (workspace) {
    sources.push(path.join(workspace, ".github", "skills"))
    sources.push(path.join(workspace, dataDir, "skills"))
  }
  return [...new Set(sources)]
}
