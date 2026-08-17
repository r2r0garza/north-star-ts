import { readFile, mkdir, mkdtemp, rm, writeFile } from "fs/promises"
import { cpSync, existsSync } from "fs"
import path from "path"
import { tmpdir } from "os"
import AdmZip from "adm-zip"
import { MAX_SKILL_FILE_SIZE, parseSkill, validateName } from "./loader"

// Import a skill from disk into a writable source root, either as a single
// SKILL.md file or a .zip of a skill folder. The name is derived from the
// SKILL.md frontmatter (authoritative — no basename guessing) and must be a
// valid slug; the destination folder is <targetRoot>/<name>/. Collisions are
// rejected (the caller surfaces the message). Callers must have already
// validated that targetRoot is a writable skill root.

// A zip archive can hold at most this many entries — a cheap zip-bomb guard
// alongside the per-entry (MAX_SKILL_FILE_SIZE) and total-size caps below.
const MAX_ZIP_ENTRIES = 2000
// Total uncompressed bytes across all entries — the decompression-bomb ceiling.
const MAX_ZIP_TOTAL = 50 * 1024 * 1024 // 50MB

// Import a bare markdown file as a skill: parse its frontmatter for the name,
// validate, reject a collision, then write the file VERBATIM (byte-for-byte, no
// scaffold round-trip) as <targetRoot>/<name>/SKILL.md. Returns the new path.
export async function importSkillFromMarkdown(
  sourcePath: string,
  targetRoot: string
): Promise<string> {
  const content = await readFile(sourcePath, "utf-8")
  if (content.length > MAX_SKILL_FILE_SIZE) {
    throw new Error("Skill file is too large.")
  }
  const name = deriveName(content, sourcePath, targetRoot)
  const skillDir = path.join(targetRoot, name)
  if (existsSync(skillDir)) {
    throw new Error(`A skill named '${name}' already exists here.`)
  }
  await mkdir(skillDir, { recursive: true })
  const filePath = path.join(skillDir, "SKILL.md")
  await writeFile(filePath, content, "utf-8")
  return filePath
}

// Import a zipped skill folder: validate the archive (entry/size caps +
// zip-slip guard), locate the single SKILL.md (at the archive root or under one
// wrapping top-level folder), derive+validate the name, reject a collision,
// extract to a temp dir, then move the (prefix-stripped) folder into
// <targetRoot>/<name>/. Returns the new SKILL.md path.
export async function importSkillFromZip(
  sourcePath: string,
  targetRoot: string
): Promise<string> {
  let zip: AdmZip
  try {
    zip = new AdmZip(sourcePath)
  } catch {
    throw new Error("Could not read the zip archive — it may be corrupt.")
  }
  const entries = zip.getEntries()
  if (entries.length === 0) throw new Error("The zip archive is empty.")
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error("The zip archive has too many entries.")
  }

  // Validate every entry (zip-slip + size caps) and collect file entries.
  let total = 0
  const files: Array<{ rel: string; entry: AdmZip.IZipEntry }> = []
  for (const entry of entries) {
    const rel = normalizeEntryName(entry.entryName)
    if (rel === null) {
      throw new Error(`Refusing unsafe path in archive: ${entry.entryName}`)
    }
    if (entry.isDirectory) continue
    // Skip archiver cruft (macOS "Compress" adds __MACOSX/ + .DS_Store +
    // ._AppleDouble resource forks) so it doesn't trip the layout check or land
    // in the imported skill folder.
    if (isIgnorableEntry(rel)) continue
    const size = entry.header.size
    if (size > MAX_SKILL_FILE_SIZE) {
      throw new Error(`An entry in the archive is too large: ${rel}`)
    }
    total += size
    if (total > MAX_ZIP_TOTAL) {
      throw new Error("The zip archive is too large when uncompressed.")
    }
    files.push({ rel, entry })
  }
  if (files.length === 0) throw new Error("The zip archive has no files.")

  const prefix = resolveSkillPrefix(files.map((f) => f.rel))

  // Derive + validate the name from the located SKILL.md.
  const skillMd = files.find((f) => f.rel === prefix + "SKILL.md")!
  const name = deriveName(skillMd.entry.getData().toString("utf-8"), prefix + "SKILL.md", targetRoot)

  const skillDir = path.join(targetRoot, name)
  if (existsSync(skillDir)) {
    throw new Error(`A skill named '${name}' already exists here.`)
  }

  // Extract to a temp dir first (a partial/failed extraction never pollutes the
  // writable root), then move the folder into place.
  const tmp = await mkdtemp(path.join(tmpdir(), "skill-import-"))
  try {
    for (const { rel, entry } of files) {
      // Strip the wrapping-folder prefix so the SKILL.md lands at the folder root.
      const dest = path.join(tmp, rel.slice(prefix.length))
      await mkdir(path.dirname(dest), { recursive: true })
      await writeFile(dest, entry.getData())
    }
    cpSync(tmp, skillDir, { recursive: true })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
  return path.join(skillDir, "SKILL.md")
}

// Parse frontmatter → name and hard-validate it (slug + name===dir rules). The
// dirName passed to parseSkill is irrelevant (it only warns); we validate the
// derived name against itself, exactly as skills:create does.
function deriveName(
  content: string,
  displayPath: string,
  source: string
): string {
  const parsed = parseSkill(content, displayPath, "", source)
  if (!parsed) {
    throw new Error(
      "The SKILL.md is missing valid frontmatter (name + description)."
    )
  }
  const err = validateName(parsed.name, parsed.name)
  if (err) throw new Error(err)
  return parsed.name
}

// Whether a (normalized, forward-slash) archive entry is OS/archiver metadata
// that should be dropped, not imported: macOS's __MACOSX/ sidecar tree, any
// .DS_Store, and ._-prefixed AppleDouble resource forks. Matched at any depth so
// a Finder-zipped "skill-name/" folder (which nests these under the top folder)
// still resolves to a clean single-folder layout.
function isIgnorableEntry(rel: string): boolean {
  const parts = rel.split("/")
  if (parts[0] === "__MACOSX") return true
  const base = parts[parts.length - 1]
  return base === ".DS_Store" || base.startsWith("._")
}

// Normalize a zip entry name to a safe, forward-slash relative path, or null if
// it's absolute or escapes the archive root (zip-slip). A trailing slash
// (directory entry) is preserved so the caller can skip it.
function normalizeEntryName(entryName: string): string | null {
  const trailing = entryName.endsWith("/")
  // Zip paths use forward slashes; treat backslashes as separators too so a
  // Windows-authored archive can't smuggle a traversal segment.
  const cleaned = entryName.replace(/\\/g, "/")
  if (path.posix.isAbsolute(cleaned)) return null
  const norm = path.posix.normalize(cleaned)
  if (norm === ".." || norm.startsWith("../") || norm.includes("/../")) {
    return null
  }
  if (norm.startsWith("/") || path.posix.isAbsolute(norm)) return null
  return trailing && !norm.endsWith("/") ? norm + "/" : norm
}

// Determine the layout of the archive's files and return the prefix to strip so
// SKILL.md lands at the skill-folder root. Accepts exactly one SKILL.md, either:
//   - at the archive root ("SKILL.md")         → prefix ""
//   - under one wrapping top-level folder ("foo/SKILL.md", everything under foo/)
//                                               → prefix "foo/"
// Rejects zero/multiple SKILL.md and a mixed layout (files outside the folder).
function resolveSkillPrefix(relPaths: string[]): string {
  const skillMds = relPaths.filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
  if (skillMds.length === 0) {
    throw new Error("The zip archive has no SKILL.md.")
  }
  if (skillMds.length > 1) {
    throw new Error("The zip archive has more than one SKILL.md.")
  }
  const skillMd = skillMds[0]
  if (skillMd === "SKILL.md") {
    return "" // root layout — everything is copied as-is
  }
  // Wrapping-folder layout: SKILL.md is "<folder>/SKILL.md". Every file must
  // live under that same top-level folder, else the layout is ambiguous.
  const prefix = skillMd.slice(0, skillMd.length - "SKILL.md".length) // "foo/"
  const topFolder = prefix.split("/")[0] + "/"
  const allUnder = relPaths.every((p) => p.startsWith(topFolder))
  if (!allUnder) {
    throw new Error(
      "The zip archive mixes files at the root with a skill folder — flatten it to one layout."
    )
  }
  // Guard against a deeper nest (e.g. "a/b/SKILL.md" with nothing at a/): the
  // SKILL.md must sit directly under the single wrapping folder.
  if (prefix !== topFolder) {
    throw new Error("The SKILL.md must be at the archive root or one folder deep.")
  }
  return prefix
}
