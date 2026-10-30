import { app } from "electron"
import { mkdirSync } from "fs"
import { isAbsolute, join, resolve } from "path"

// Test-instance startup contract (plan 119). `--test-profile=<absolute dir>`
// moves every per-user location this app resolves — Electron userData (SQLite,
// settings, logs, Chromium profile) and home (~/.<system> skills, agents, MCP,
// venv, chats) — under that dir before any module asks for one. Imported first
// in index.ts so the redirect precedes every app.getPath()/homedir() caller.
// It isolates this app's own storage only: it is not a filesystem or network
// sandbox, and .env.local is still read from the app path.
export const TEST_PROFILE_FLAG = "--test-profile="

export type TestProfile = { root: string; userData: string; home: string }

// null when the flag is absent; throws on a present-but-unusable value so a bad
// launch fails closed instead of silently opening the personal profile.
export function parseTestProfile(argv: readonly string[]): TestProfile | null {
  const values = argv
    .filter((arg) => arg.startsWith(TEST_PROFILE_FLAG))
    .map((arg) => arg.slice(TEST_PROFILE_FLAG.length))
  if (values.length === 0) return null
  if (values.length > 1) throw new Error("--test-profile given more than once")
  const value = values[0]
  if (!value || !isAbsolute(value))
    throw new Error("--test-profile must be an absolute directory path")
  const root = resolve(value)
  return { root, userData: join(root, "user-data"), home: join(root, "home") }
}

let active: TestProfile | null = null

export function testProfile(): TestProfile | null {
  return active
}

function apply(): void {
  let profile: TestProfile | null
  try {
    profile = parseTestProfile(process.argv)
  } catch (error) {
    console.error(`Refusing to start: ${(error as Error).message}`)
    process.exit(2)
  }
  if (!profile) return
  mkdirSync(profile.userData, { recursive: true })
  mkdirSync(profile.home, { recursive: true })
  app.setPath("userData", profile.userData)
  app.setPath("home", profile.home)
  // os.homedir() and child processes read HOME, not app.getPath("home").
  process.env.HOME = profile.home
  if (process.platform === "win32") process.env.USERPROFILE = profile.home
  active = profile
}

apply()
