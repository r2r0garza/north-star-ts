import { execFile } from "child_process"
import { promisify } from "util"
import { shell } from "electron"

// Opens a workspace file in the user's chosen IDE. The behavior the user wants:
// open the REPO ROOT first (so an already-open IDE window is focused, or the
// folder opens fresh), THEN open the specific file in that same window. We do
// this as two sequential launches — it works uniformly across the VS Code family
// and JetBrains, where a single "folder + file" invocation would differ per IDE.
//
// "system" is the zero-config default: hand the file to the OS
// (shell.openPath), which opens it in whatever app is registered for the type.

const run = promisify(execFile)

// Each known IDE. `mac` is the LaunchServices app name used with `open -a`
// (robust on macOS — no PATH/CLI dependency, and focuses an existing window).
// `cli` is the command-line launcher used on Windows/Linux (and as a mac
// fallback). Order here drives the Settings dropdown order.
export interface IdeEntry {
  id: string
  label: string
  mac: string
  cli: string
}

export const IDES: IdeEntry[] = [
  { id: "vscode", label: "VS Code", mac: "Visual Studio Code", cli: "code" },
  { id: "cursor", label: "Cursor", mac: "Cursor", cli: "cursor" },
  { id: "windsurf", label: "Windsurf", mac: "Windsurf", cli: "windsurf" },
  { id: "zed", label: "Zed", mac: "Zed", cli: "zed" },
  { id: "sublime", label: "Sublime Text", mac: "Sublime Text", cli: "subl" },
  { id: "webstorm", label: "WebStorm", mac: "WebStorm", cli: "webstorm" },
  { id: "intellij", label: "IntelliJ IDEA", mac: "IntelliJ IDEA", cli: "idea" },
  { id: "pycharm", label: "PyCharm", mac: "PyCharm", cli: "pycharm" },
]

// The setting value: a known IDE id, or "system" for the OS default.
export type IdeChoice = "system" | string

// GUI-launched apps on macOS inherit a minimal PATH that usually omits the dirs
// where IDE CLIs install (`/usr/local/bin`, Homebrew, VS Code's shell command).
// Augment PATH for the CLI fallback so `code`/`cursor`/etc. resolve.
const EXTRA_PATHS = [
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
  process.env.HOME ? `${process.env.HOME}/.local/bin` : "",
].filter(Boolean)

function augmentedEnv(): NodeJS.ProcessEnv {
  const current = process.env.PATH ?? ""
  const merged = [current, ...EXTRA_PATHS].filter(Boolean).join(":")
  return { ...process.env, PATH: merged }
}

// Launch `target` (a folder or file path) in the given IDE. Resolves true on a
// successful launch, false if the IDE couldn't be launched (missing app/CLI).
async function launch(entry: IdeEntry, target: string): Promise<boolean> {
  if (process.platform === "darwin") {
    try {
      // `open -a <App> <path>` focuses a running instance or launches it.
      await run("open", ["-a", entry.mac, target])
      return true
    } catch {
      // App not installed under that name — fall through to the CLI attempt.
    }
  }
  try {
    await run(entry.cli, [target], { env: augmentedEnv() })
    return true
  } catch {
    return false
  }
}

// Open `absFile` in the chosen IDE, opening `workspace` (the repo root) first so
// an existing window is reused. Returns "" on success, or a short error string
// (mirrors shell.openPath's contract) so the caller/renderer can surface it.
export async function openInIde(
  workspace: string,
  absFile: string,
  ide: IdeChoice
): Promise<string> {
  // Default / unknown id → OS default app for the file type.
  const entry = ide === "system" ? null : IDES.find((i) => i.id === ide)
  if (!entry) return shell.openPath(absFile)

  // Open the root first (focus/launch the project window), then the file. If the
  // root launch fails the IDE almost certainly isn't installed — fall back to the
  // OS default rather than leaving the click dead.
  const rootOk = await launch(entry, workspace)
  if (!rootOk) return shell.openPath(absFile)
  await launch(entry, absFile)
  return ""
}
