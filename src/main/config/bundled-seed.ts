import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "fs"
import path from "path"
import { app } from "electron"
import { dataDirName } from "./system-name"

// Seeds a user-level dir (~/.<system>/skills, ~/.<system>/agents) from the
// app-bundled copies, tracking every entry ever seeded in a manifest
// (~/.<system>/bundled-seed.json, keyed by kind). Rules per bundled entry:
//
//   - already in the manifest → never touched again. If the user deleted it, it
//     stays deleted; if they edited it, their edits stay.
//   - not in the manifest, already present in the user dir → recorded, never
//     overwritten (the user's copy wins).
//   - not in the manifest, absent → copied in and recorded. This is how a
//     built-in added in a later release reaches existing users.
//
// Migration: a user dir that predates the manifest gets its missing bundled
// entries copied once — we can't tell "deleted" from "added since" without a
// record, so we err toward delivering them. From then on the manifest rules.
//
// Best-effort: failures are logged, never thrown — loaders tolerate a missing
// or partial dir.

export interface SeedOptions {
  kind: string // manifest key, e.g. "skills" or "agents"
  bundledDir: string
  userDir: string
  manifestPath: string
}

type Manifest = Record<string, string[]>

function readManifest(manifestPath: string): Manifest {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Manifest = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string")
      }
      return out
    }
  } catch {
    // missing or corrupt — start fresh
  }
  return {}
}

export function seedBundledEntries(opts: SeedOptions): void {
  const { kind, bundledDir, userDir, manifestPath } = opts
  try {
    mkdirSync(userDir, { recursive: true })
  } catch (err) {
    console.warn(`Could not create user ${kind} dir: ${err}`)
    return
  }

  let entries: string[]
  try {
    // Skip dotfiles (.DS_Store and friends) — they're never skills or agents.
    entries = readdirSync(bundledDir).filter((e) => !e.startsWith("."))
  } catch {
    return // no bundled entries to seed (or unreadable)
  }

  const manifest = readManifest(manifestPath)
  const seeded = new Set(manifest[kind] ?? [])
  let changed = false
  for (const entry of entries) {
    if (seeded.has(entry)) continue
    const dest = path.join(userDir, entry)
    if (!existsSync(dest)) {
      try {
        cpSync(path.join(bundledDir, entry), dest, { recursive: true })
      } catch (err) {
        console.warn(`Could not seed bundled ${kind} '${entry}': ${err}`)
        continue // not recorded, so the next launch retries
      }
    }
    seeded.add(entry)
    changed = true
  }
  if (!changed) return

  manifest[kind] = [...seeded].sort()
  try {
    mkdirSync(path.dirname(manifestPath), { recursive: true })
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  } catch (err) {
    console.warn(`Could not write bundled seed manifest: ${err}`)
  }
}

// ~/.<system>/bundled-seed.json — shared by the skills and agents seeders.
export function bundledSeedManifestPath(): string {
  return path.join(app.getPath("home"), dataDirName(), "bundled-seed.json")
}
