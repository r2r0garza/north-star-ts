// Package the app with electron-builder, rebranding the packaged identity
// (productName + appId) from NEXT_system_name so `set the var, then build`
// renames the whole app — not just the runtime paths that read the var live.
//
// electron-builder bakes productName/appId at package time; they can't be read
// from process.env at runtime. Rather than mutate package.json (and dirty git),
// we pass them as `-c.*` CLI overrides here. The slug/display derivation MUST
// stay in sync with src/main/config/system-name.ts, which drives the runtime
// side (data dir, db filename, container prefix, window title).
//
// productName also determines Electron's userData dir (where the SQLite db
// lives), so renaming it starts the packaged app on a fresh data dir — expected
// for a rebrand, but worth calling out.

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

// Minimal .env.local reader — matches how dotenv loads it at runtime, without
// pulling dotenv into the build script. Missing file / var falls back to the
// default. process.env wins if the var is already exported in the shell.
function readEnvLocal(name) {
  if (process.env[name]?.trim()) return process.env[name].trim()
  let text
  try {
    text = readFileSync(join(root, ".env.local"), "utf8")
  } catch {
    return undefined
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    if (trimmed.slice(0, eq).trim() !== name) continue
    return trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
  }
  return undefined
}

const DEFAULT_NAME = "cowork"
const raw = readEnvLocal("NEXT_system_name") || DEFAULT_NAME
const slug =
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || DEFAULT_NAME
// Word separators become spaces, each word capitalized (rest left as typed):
// "acme-company" -> "Acme Company". Keep in sync with systemDisplayName() in
// src/main/config/system-name.ts.
const displayName = raw
  .split(/[-_\s]+/)
  .filter(Boolean)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  .join(" ")
const appId = `com.agentic.${slug}`

console.log(
  `[dist] Packaging as productName="${displayName}" appId="${appId}" (from NEXT_system_name="${raw}")`
)

// electron-vite build first (same as the old inline `dist` script), then
// electron-builder with the derived identity overriding package.json's build.*.
const steps = [
  ["electron-vite", ["build"]],
  [
    "electron-builder",
    [`-c.productName=${displayName}`, `-c.appId=${appId}`],
  ],
]

for (const [cmd, args] of steps) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
