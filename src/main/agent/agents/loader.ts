import { readFile, readdir, stat } from "fs/promises"
import path from "path"
import * as yaml from "js-yaml"
import type { AgentDefinition } from "./types"
import { agentSources } from "./sources"

export const MAX_AGENT_FILE_SIZE = 10 * 1024 * 1024 // 10MB DoS guard
const MAX_NAME = 64
const MAX_DESCRIPTION = 1024
const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/
const AGENT_SUFFIX = ".agent.md"

export function validateName(name: string, stem: string): string | null {
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
  if (name !== stem)
    return `name '${name}' must match file '${stem}${AGENT_SUFFIX}'`
  return null
}

// Tri-state list parse: returns `undefined` when the key is ABSENT, and an array
// (possibly empty) when the key is present. A bare `key:` (YAML null) or a
// non-array value is treated as present-but-empty ([]), so the "key present"
// signal survives — the undefined/[] distinction is load-bearing (see types.ts).
function parseList(
  data: Record<string, unknown>,
  key: string
): string[] | undefined {
  if (!(key in data)) return undefined
  const raw = data[key]
  if (!Array.isArray(raw)) return []
  return raw.map((v) => String(v).trim()).filter(Boolean)
}

export function parseAgent(
  content: string,
  agentPath: string,
  stem: string,
  source: string
): AgentDefinition | null {
  if (content.length > MAX_AGENT_FILE_SIZE) {
    console.warn(`Skipping ${agentPath}: content too large`)
    return null
  }

  const match = FRONTMATTER.exec(content)
  if (!match) {
    console.warn(`Skipping ${agentPath}: no valid YAML frontmatter`)
    return null
  }

  let fm: unknown
  try {
    fm = yaml.load(match[1])
  } catch (e) {
    console.warn(`Invalid YAML in ${agentPath}: ${e}`)
    return null
  }
  if (typeof fm !== "object" || fm === null) {
    console.warn(`Skipping ${agentPath}: frontmatter is not a mapping`)
    return null
  }
  const data = fm as Record<string, unknown>

  const name = String(data.name ?? "").trim()
  let description = String(data.description ?? "").trim()
  if (!name || !description) {
    console.warn(
      `Skipping ${agentPath}: missing required 'name' or 'description'`
    )
    return null
  }

  // Spec violations warn but still load (matches the skills loader's tolerance).
  const nameErr = validateName(name, stem)
  if (nameErr)
    console.warn(`Agent '${name}' in ${agentPath} violates spec: ${nameErr}`)

  if (description.length > MAX_DESCRIPTION)
    description = description.slice(0, MAX_DESCRIPTION)

  return {
    name,
    description,
    tools: parseList(data, "tools"),
    skills: parseList(data, "skills"),
    children: parseList(data, "children"),
    userInvocable: data["user-invocable"] === true,
    body: content.slice(match[0].length),
    path: agentPath,
    source,
  }
}

// Fields a serialized agent carries. Mirrors AgentDefinition minus the runtime-only
// `path`/`source` (derived from where the file lives, not written into it).
export interface AgentFields {
  name: string
  description: string
  tools?: string[]
  skills?: string[]
  children?: string[]
  userInvocable: boolean
  body: string
}

// Serialize an agent back to `<name>.agent.md` text. The exact inverse of
// parseAgent: emits YAML frontmatter (name/description always; tri-state lists only
// when present, so an omitted key round-trips to `undefined` and an empty list to
// `[]`; `userInvocable` under the hyphenated `user-invocable` key) then the raw body.
// The undefined-vs-[] distinction is load-bearing — never emit a key for `undefined`.
export function serializeAgent(fields: AgentFields): string {
  const fm: Record<string, unknown> = {
    name: fields.name,
    description: fields.description,
  }
  if (fields.tools !== undefined) fm.tools = fields.tools
  if (fields.skills !== undefined) fm.skills = fields.skills
  if (fields.children !== undefined) fm.children = fields.children
  fm["user-invocable"] = fields.userInvocable

  // flowLevel: -1 keeps YAML in block style; lineWidth: -1 disables line wrapping so
  // long descriptions aren't folded. An empty array serializes as `key: []`.
  const yamlText = yaml.dump(fm, { lineWidth: -1, flowLevel: -1 }).trimEnd()
  return `---\n${yamlText}\n---\n${fields.body}`
}

// List agents in a single source directory. Reads flat `<name>.agent.md` files
// (unlike skills, which live in per-skill subdirectories).
export async function listSource(sourceDir: string): Promise<AgentDefinition[]> {
  let entries: string[]
  try {
    entries = await readdir(sourceDir)
  } catch {
    return [] // source doesn't exist yet — fine
  }

  const agents: AgentDefinition[] = []
  for (const entry of entries) {
    if (!entry.endsWith(AGENT_SUFFIX)) continue
    const filePath = path.join(sourceDir, entry)
    try {
      if (!(await stat(filePath)).isFile()) continue
    } catch {
      continue // entry vanished or unreadable — skip
    }
    let content: string
    try {
      content = await readFile(filePath, "utf-8")
    } catch {
      continue
    }
    const stem = entry.slice(0, -AGENT_SUFFIX.length)
    const parsed = parseAgent(content, filePath, stem, sourceDir)
    if (parsed) agents.push(parsed)
  }
  return agents
}

// Load agents from sources in order. Later sources override earlier ones by name
// (last-wins) — enables user → workspace layering.
export async function loadAgents(sources: string[]): Promise<AgentDefinition[]> {
  const byName = new Map<string, AgentDefinition>()
  for (const source of sources) {
    for (const agent of await listSource(source)) byName.set(agent.name, agent)
  }
  return [...byName.values()]
}

// Resolve a single agent by name for the given workspace, honoring the same
// source order (workspace overrides user). Returns null if not found.
export async function loadAgent(
  name: string,
  workspace?: string
): Promise<AgentDefinition | null> {
  const agents = await loadAgents(agentSources(workspace))
  return agents.find((a) => a.name === name) ?? null
}
