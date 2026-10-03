import { createHash } from "crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
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
// Refresh (plan 109.01): a bundled single-file entry whose content changed in a
// later release replaces the user's copy only when that copy is byte-for-byte
// what we last seeded (its SHA-256 is recorded under `hashes`). An edited copy
// is never touched. Copies seeded before hashes were recorded are recognized
// through `previousHashes`: the hashes of earlier bundled versions.
//
// Best-effort: failures are logged, never thrown — loaders tolerate a missing
// or partial dir.

export interface SeedOptions {
  kind: string // manifest key, e.g. "skills" or "agents"
  bundledDir: string
  userDir: string
  manifestPath: string
  // Entry name → SHA-256 of bundled versions shipped before hashes were
  // recorded, so an unedited old copy can still be refreshed.
  previousHashes?: Record<string, string[]>
}

interface Manifest {
  entries: Record<string, string[]>
  // "<kind>/<entry>" → SHA-256 of the content last seeded into the user dir.
  hashes: Record<string, string>
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function readManifest(manifestPath: string): Manifest {
  const manifest: Manifest = { entries: {}, hashes: {} }
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v))
          manifest.entries[k] = v.filter((x) => typeof x === "string")
        else if (k === "hashes" && v && typeof v === "object")
          for (const [entry, hash] of Object.entries(v))
            if (typeof hash === "string") manifest.hashes[entry] = hash
      }
    }
  } catch {
    // missing or corrupt — start fresh
  }
  return manifest
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
  const seeded = new Set(manifest.entries[kind] ?? [])
  let changed = false
  const recordHash = (entry: string, hash: string) => {
    if (manifest.hashes[`${kind}/${entry}`] === hash) return
    manifest.hashes[`${kind}/${entry}`] = hash
    changed = true
  }
  for (const entry of entries) {
    const source = path.join(bundledDir, entry)
    const dest = path.join(userDir, entry)
    if (seeded.has(entry)) {
      refreshEntry(entry, source, dest)
      continue
    }
    if (!existsSync(dest)) {
      try {
        cpSync(source, dest, { recursive: true })
      } catch (err) {
        console.warn(`Could not seed bundled ${kind} '${entry}': ${err}`)
        continue // not recorded, so the next launch retries
      }
      if (isFile(source)) recordHash(entry, sha256(source))
    }
    seeded.add(entry)
    changed = true
  }
  if (!changed) return

  const out: Record<string, unknown> = { ...manifest.entries }
  out[kind] = [...seeded].sort()
  out.hashes = Object.fromEntries(
    Object.entries(manifest.hashes).sort(([a], [b]) => a.localeCompare(b))
  )
  try {
    mkdirSync(path.dirname(manifestPath), { recursive: true })
    writeFileSync(manifestPath, JSON.stringify(out, null, 2) + "\n")
  } catch (err) {
    console.warn(`Could not write bundled seed manifest: ${err}`)
  }

  // A seeded single-file entry: deliver a changed bundled version over an
  // unedited copy; leave edited and deleted copies alone.
  function refreshEntry(entry: string, source: string, dest: string): void {
    if (!isFile(source) || !isFile(dest)) return
    try {
      const bundled = sha256(source)
      const current = sha256(dest)
      if (current === bundled) return recordHash(entry, bundled)
      const last = manifest.hashes[`${kind}/${entry}`]
      const unedited = last
        ? current === last
        : (opts.previousHashes?.[entry] ?? []).includes(current)
      if (!unedited) return
      cpSync(source, dest)
      recordHash(entry, bundled)
    } catch (err) {
      console.warn(`Could not refresh bundled ${kind} '${entry}': ${err}`)
    }
  }
}

// ~/.<system>/bundled-seed.json — shared by the skills and agents seeders.
export function bundledSeedManifestPath(): string {
  return path.join(app.getPath("home"), dataDirName(), "bundled-seed.json")
}
