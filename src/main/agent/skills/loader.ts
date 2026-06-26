import { readFile, readdir, stat } from "fs/promises"
import path from "path"
import * as yaml from "js-yaml"
import type { SkillMetadata } from "./types"

const MAX_SKILL_FILE_SIZE = 10 * 1024 * 1024 // 10MB DoS guard
const MAX_NAME = 64
const MAX_DESCRIPTION = 1024
const MAX_COMPATIBILITY = 500
const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/

function validateName(name: string, dirName: string): string | null {
  if (!name) return "name is required"
  if (name.length > MAX_NAME) return "name exceeds 64 characters"
  if (name.startsWith("-") || name.endsWith("-") || name.includes("--"))
    return "name must be lowercase alphanumeric with single hyphens only"
  for (const c of name) {
    if (c === "-") continue
    const isLower = c.toLowerCase() === c && c.toUpperCase() !== c
    const isDigit = c >= "0" && c <= "9"
    if (!isLower && !isDigit)
      return "name must be lowercase alphanumeric with single hyphens only"
  }
  if (name !== dirName) return `name '${name}' must match directory name '${dirName}'`
  return null
}

function parseSkill(
  content: string,
  skillPath: string,
  dirName: string,
  source: string
): SkillMetadata | null {
  if (content.length > MAX_SKILL_FILE_SIZE) {
    console.warn(`Skipping ${skillPath}: content too large`)
    return null
  }

  const match = FRONTMATTER.exec(content)
  if (!match) {
    console.warn(`Skipping ${skillPath}: no valid YAML frontmatter`)
    return null
  }

  let fm: unknown
  try {
    fm = yaml.load(match[1])
  } catch (e) {
    console.warn(`Invalid YAML in ${skillPath}: ${e}`)
    return null
  }
  if (typeof fm !== "object" || fm === null) {
    console.warn(`Skipping ${skillPath}: frontmatter is not a mapping`)
    return null
  }
  const data = fm as Record<string, unknown>

  const name = String(data.name ?? "").trim()
  let description = String(data.description ?? "").trim()
  if (!name || !description) {
    console.warn(`Skipping ${skillPath}: missing required 'name' or 'description'`)
    return null
  }

  // Spec violations warn but still load (backwards-compat), matching deepagents.
  const nameErr = validateName(name, dirName)
  if (nameErr) console.warn(`Skill '${name}' in ${skillPath} violates spec: ${nameErr}`)

  if (description.length > MAX_DESCRIPTION) description = description.slice(0, MAX_DESCRIPTION)

  let compatibility = String(data.compatibility ?? "").trim() || undefined
  if (compatibility && compatibility.length > MAX_COMPATIBILITY)
    compatibility = compatibility.slice(0, MAX_COMPATIBILITY)

  // allowed-tools: space-delimited string; tolerate trailing commas (Claude Code style).
  const rawTools = data["allowed-tools"]
  const allowedTools =
    typeof rawTools === "string"
      ? rawTools
          .split(/\s+/)
          .map((t) => t.replace(/,/g, ""))
          .filter(Boolean)
      : []

  const rawMeta = data.metadata
  const metadata: Record<string, string> = {}
  if (rawMeta && typeof rawMeta === "object") {
    for (const [k, v] of Object.entries(rawMeta)) metadata[String(k)] = String(v)
  }

  return {
    name,
    description,
    path: skillPath,
    body: content.slice(match[0].length),
    source,
    license: String(data.license ?? "").trim() || undefined,
    compatibility,
    metadata,
    allowedTools,
  }
}

// List skills in a single source directory.
async function listSource(sourceDir: string): Promise<SkillMetadata[]> {
  let entries: string[]
  try {
    entries = await readdir(sourceDir)
  } catch {
    return [] // source doesn't exist yet — fine
  }

  const skills: SkillMetadata[] = []
  for (const entry of entries) {
    const dir = path.join(sourceDir, entry)
    try {
      if (!(await stat(dir)).isDirectory()) continue
    } catch {
      continue // entry vanished or unreadable — skip
    }

    const skillMd = path.join(dir, "SKILL.md")
    let content: string
    try {
      content = await readFile(skillMd, "utf-8")
    } catch {
      continue // no SKILL.md in this dir — skip
    }
    const parsed = parseSkill(content, skillMd, entry, sourceDir)
    if (parsed) skills.push(parsed)
  }
  return skills
}

// Load skills from sources in order. Later sources override earlier ones by
// name (last-wins) — enables base → user → project layering.
export async function loadSkills(sources: string[]): Promise<SkillMetadata[]> {
  const byName = new Map<string, SkillMetadata>()
  for (const source of sources) {
    for (const skill of await listSource(source)) byName.set(skill.name, skill)
  }
  return [...byName.values()]
}
