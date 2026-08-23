import { app } from "electron"

// Single source of truth for the app's customizable "system name". Set
// NEXT_system_name in .env.local (loaded by dotenv in index.ts before any of
// these run) to override the name during development. In packaged builds,
// electron-builder bakes the productName into Electron's app name, so when the
// env var is absent we derive the runtime paths from app.getName(). The name
// drives the on-disk data dir (~/.<slug>), the skills lookup dirs
// (<root>/.<slug>/skills), the SQLite filename (<slug>.db), the agent container
// name prefix, and the display name (window title).
//
// IMPORTANT: read the env var lazily (inside these functions), never at module
// top-level. ES imports are hoisted above index.ts's loadEnv() call, so a
// top-level read would run before .env.local is loaded and always see the
// default. This mirrors how the COWORK_ENV_* vars are read on demand.

const DEFAULT_NAME = "cowork"

function rawName(): string {
  const value = process.env.NEXT_system_name?.trim()
  if (value) return value
  try {
    const appName = app.getName?.().trim()
    if (appName) return appName
  } catch {
    // Some test/runtime harnesses provide a partial Electron app shim.
  }
  return DEFAULT_NAME
}

// Filesystem- and identifier-safe slug: lowercased, with any run of characters
// outside [a-z0-9-] folded to a single "-" and edges trimmed. Used for the data
// dir (.<slug>), the db filename, the container prefix, and the appId segment.
export function systemSlug(): string {
  const slug = rawName()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || DEFAULT_NAME
}

// Human-facing name (window title; packaged productName). Word separators
// (-, _, whitespace) become spaces and each word is capitalized, so
// "cowork" → "Cowork" and "acme-company" → "Acme Company". Only the first
// letter of each word is forced upper; the rest is left as typed, so an
// intentionally-cased "myApp" stays "MyApp".
export function systemDisplayName(): string {
  return rawName()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

// The dotfile data-directory name, e.g. ".cowork".
export function dataDirName(): string {
  return `.${systemSlug()}`
}

// The main agent's brand name (from MAIN_AGENT_NAME in .env.local), used to
// label the per-view empty-session headings (e.g. "North Star - Chat"). Read
// lazily for the same reason as rawName() above (ES imports hoist above
// loadEnv()). Defaults to "North Star" so an unset var keeps the prior heading.
const DEFAULT_AGENT_NAME = "North Star"

export function mainAgentName(): string {
  const value = process.env.MAIN_AGENT_NAME?.trim()
  return value ? value : DEFAULT_AGENT_NAME
}
