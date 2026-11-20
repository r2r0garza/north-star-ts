// Self-update from GitHub Releases. Hand-rolled instead of electron-updater
// because the mac build is ad-hoc signed ("identity": "-"), which Squirrel.Mac
// refuses to update, and releases ship plain .dmg/.exe assets (no latest*.yml).
import { app, dialog } from "electron"
import { spawn } from "child_process"
import { createWriteStream } from "fs"
import { join } from "path"
import { Readable } from "stream"
import { pipeline } from "stream/promises"

const LATEST_RELEASE =
  "https://api.github.com/repos/r2r0garza/north-star-ts/releases/latest"

type Asset = { name: string; browser_download_url: string }

// shortcut: numeric major.minor.patch only, prerelease tags ignored; use semver if we ship prereleases.
export function isNewer(tag: string, current: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, "").split("-")[0].split(".").map((n) => Number(n) || 0)
  const [a, b] = [parse(tag), parse(current)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

// electron-builder names: mac arm64 "<Name>-1.2.3-arm64.dmg", mac x64 "<Name>-1.2.3.dmg",
// windows "<Name> Setup 1.2.3.exe".
export function pickAsset(
  assets: Asset[],
  platform: NodeJS.Platform,
  arch: string
): Asset | undefined {
  if (platform === "win32") return assets.find((a) => a.name.endsWith(".exe"))
  if (platform !== "darwin") return undefined
  const dmgs = assets.filter((a) => a.name.endsWith(".dmg"))
  return arch === "arm64"
    ? dmgs.find((a) => a.name.includes("arm64"))
    : dmgs.find((a) => !a.name.includes("arm64"))
}

function install(file: string): void {
  if (process.platform === "win32") {
    // Same flags electron-updater passes to an electron-builder NSIS installer.
    spawn(file, ["--updated", "/S", "--force-run"], {
      detached: true,
      stdio: "ignore",
    }).unref()
  } else {
    // .../X.app/Contents/MacOS/X -> .../X.app
    const appPath = join(process.execPath, "..", "..", "..")
    const script = `
      while kill -0 "$1" 2>/dev/null; do sleep 0.5; done
      mnt=$(mktemp -d)
      hdiutil attach -nobrowse -readonly -mountpoint "$mnt" "$2" || exit 1
      src=$(ls -d "$mnt"/*.app | head -1)
      [ -n "$src" ] && rm -rf "$3" && ditto "$src" "$3"
      hdiutil detach "$mnt" -quiet
      xattr -dr com.apple.quarantine "$3" 2>/dev/null
      open "$3"`
    spawn("/bin/sh", ["-c", script, "sh", String(process.pid), file, appPath], {
      detached: true,
      stdio: "ignore",
    }).unref()
  }
  app.quit()
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return
  const res = await fetch(LATEST_RELEASE, {
    headers: { Accept: "application/vnd.github+json" },
  })
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`)
  const release = (await res.json()) as { tag_name: string; assets: Asset[] }
  if (!isNewer(release.tag_name, app.getVersion())) return
  const asset = pickAsset(release.assets, process.platform, process.arch)
  if (!asset) return

  const file = join(app.getPath("temp"), asset.name)
  const dl = await fetch(asset.browser_download_url)
  if (!dl.ok || !dl.body) throw new Error(`Download failed: HTTP ${dl.status}`)
  await pipeline(Readable.fromWeb(dl.body as never), createWriteStream(file))

  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Restart and update", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: `Version ${release.tag_name.replace(/^v/, "")} is ready to install`,
    detail: `You have ${app.getVersion()}. The app will restart to finish updating.`,
  })
  if (response === 0) install(file)
}
