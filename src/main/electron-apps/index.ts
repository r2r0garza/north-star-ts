import { app } from "electron"
import { readFileSync } from "fs"
import { join } from "path"
import { systemSlug } from "../config/system-name"
import { getBrowser } from "../settings/service"
import { ElectronAppManager, defaultProfileRoot } from "./manager"

// Settings → Browser → "Let the agent launch Electron apps" (default on).
// Off only stops offering the tools; live sessions keep their host Stop bar.
export function electronAppsEnabled(): boolean {
  return getBrowser().electronApps
}

let hostPackageName: string | null | undefined

export const electronApps = new ElectronAppManager({
  profileRoot: () => defaultProfileRoot(systemSlug()),
  // A target whose package name matches this app is North Star itself and
  // gets the --test-profile contract instead of the generic --user-data-dir.
  hostPackageName: () => {
    if (hostPackageName === undefined) {
      try {
        const raw = readFileSync(join(app.getAppPath(), "package.json"), "utf8")
        hostPackageName = (JSON.parse(raw) as { name?: string }).name ?? null
      } catch {
        hostPackageName = null
      }
    }
    return hostPackageName
  },
})
