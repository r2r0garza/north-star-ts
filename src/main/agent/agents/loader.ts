import { readFile, readdir, realpath, stat } from "fs/promises"
import path from "path"
import * as yaml from "js-yaml"
import type {
  AgentCompatibilityDiagnostic,
  AgentDefinition,
  AgentRef,
  ExternalAgentSourceKind,
} from "./types"
import {
  agentSourceEntries,
  agentSources,
  type AgentSourceEntry,
} from "./sources"
import { systemDisplayName } from "../../config/system-name"

export const MAX_AGENT_FILE_SIZE = 10 * 1024 * 1024 // 10MB DoS guard
const MAX_NAME = 64
const MAX_DESCRIPTION = 1024
const FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/
const AGENT_SUFFIX = ".agent.md"
const MARKDOWN_SUFFIX = ".md"
const TOML_SUFFIX = ".toml"

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

// Claude Code commonly serializes `tools` as a comma-separated YAML scalar
// (`tools: Read, Write, Bash`) rather than an array. Accept both forms at the
// loader boundary so direct Claude sources and verbatim imports retain the tool
// rules that the capability-policy layer translates at runtime. Other tri-state
// lists stay strict arrays via parseList.
function parseToolList(
  data: Record<string, unknown>,
  key: string
): string[] | undefined {
  if (!(key in data)) return undefined
  const raw = data[key]
  if (Array.isArray(raw))
    return raw.map((v) => String(v).trim()).filter(Boolean)
  if (typeof raw === "string")
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  return []
}

function sourceLabel(kind: ExternalAgentSourceKind): string {
  switch (kind) {
    case "north_star":
      return systemDisplayName()
    case "github":
      return "GitHub"
    case "copilot":
      return "Copilot"
    case "cursor":
      return "Cursor"
    case "claude":
      return "Claude"
    case "codex":
      return "Codex"
  }
}

function serializeAgentRef(ref: AgentRef): string {
  return `agentref:v1:${JSON.stringify(ref)}`
}

function normalizeDefinitionPath(agentPath: string): string {
  return path.resolve(agentPath)
}

function inferSourceEntry(source: string): AgentSourceEntry {
  const resolved = path.resolve(source)
  const normalized = resolved.split(path.sep).join("/")
  const scope =
    normalized.includes("/.github/agents") ||
    normalized.includes("/.copilot/agents") ||
    normalized.includes("/.cursor/agents") ||
    normalized.includes("/.claude/agents") ||
    normalized.includes("/.codex/")
      ? normalized.startsWith(
          path
            .resolve(process.env.HOME ?? "")
            .split(path.sep)
            .join("/")
        )
        ? "global"
        : "workspace"
      : "custom"
  if (normalized.endsWith("/.github/agents")) {
    return {
      path: source,
      kind: "github",
      sourceKind: "github",
      scope,
      label: path.basename(source),
    }
  }
  if (normalized.endsWith("/.copilot/agents")) {
    return {
      path: source,
      kind: "copilot",
      sourceKind: "copilot",
      scope,
      label: ".copilot/agents",
    }
  }
  if (normalized.endsWith("/.cursor/agents")) {
    return {
      path: source,
      kind: "cursor",
      sourceKind: "cursor",
      scope,
      label: ".cursor/agents",
    }
  }
  if (normalized.endsWith("/.claude/agents")) {
    return {
      path: source,
      kind: "claude",
      sourceKind: "claude",
      scope,
      label: ".claude/agents",
    }
  }
  if (
    normalized.endsWith("/.codex/agents") ||
    normalized.endsWith("/.codex/config.toml")
  ) {
    return {
      path: source,
      kind: "codex",
      sourceKind: "codex",
      scope,
      label: path.basename(source),
    }
  }
  if (normalized.endsWith("/.cowork/agents")) {
    const home = path
      .resolve(process.env.HOME ?? "")
      .split(path.sep)
      .join("/")
    return {
      path: source,
      kind: normalized.startsWith(home + "/") ? "user" : "workspace",
      sourceKind: "north_star",
      scope: normalized.startsWith(home + "/") ? "global" : "workspace",
      label: ".cowork/agents",
    }
  }
  return {
    path: source,
    kind: "custom",
    sourceKind: "north_star",
    scope,
    label: path.basename(source),
  }
}

function makeBaseDefinition(input: {
  sourceKind: ExternalAgentSourceKind
  scope: AgentDefinition["scope"]
  agentPath: string
  source: string
  nativeName: string
  description: string
  body: string
  userInvocable: boolean
  sourceMetadata?: unknown
  diagnostics?: AgentCompatibilityDiagnostic[]
}): AgentDefinition {
  const ref: AgentRef = {
    sourceKind: input.sourceKind,
    scope: input.scope,
    definitionPath: normalizeDefinitionPath(input.agentPath),
    nativeName: input.nativeName,
  }
  return {
    name: input.nativeName,
    nativeName: input.nativeName,
    description:
      input.description.length > MAX_DESCRIPTION
        ? input.description.slice(0, MAX_DESCRIPTION)
        : input.description,
    userInvocable: input.userInvocable,
    body: input.body,
    path: input.agentPath,
    source: input.source,
    ref,
    refId: serializeAgentRef(ref),
    sourceKind: input.sourceKind,
    scope: input.scope,
    label: `${sourceLabel(input.sourceKind)}: ${input.nativeName}`,
    sourceMetadata: input.sourceMetadata,
    diagnostics: input.diagnostics ?? [],
  }
}

export function parseAgent(
  content: string,
  agentPath: string,
  stem: string,
  source: string,
  sourceKind: ExternalAgentSourceKind = "north_star",
  scope: AgentDefinition["scope"] = "custom"
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
    ...makeBaseDefinition({
      sourceKind,
      scope,
      agentPath,
      source,
      nativeName: name,
      description,
      userInvocable: data["user-invocable"] === true,
      body: content.slice(match[0].length),
      sourceMetadata: data,
    }),
    tools: parseToolList(data, "tools"),
    skills: parseList(data, "skills"),
    children: parseList(data, "children"),
    mcpServers: parseList(data, "mcp-servers"),
  }
}

function parseMarkdownFrontmatter(content: string): {
  data: Record<string, unknown>
  body: string
  error?: string
} {
  const match = FRONTMATTER.exec(content)
  if (!match) return { data: {}, body: content, error: "no YAML frontmatter" }
  try {
    const fm = yaml.load(match[1])
    if (typeof fm !== "object" || fm === null) {
      return {
        data: {},
        body: content.slice(match[0].length),
        error: "frontmatter is not a mapping",
      }
    }
    return {
      data: fm as Record<string, unknown>,
      body: content.slice(match[0].length),
    }
  } catch (e) {
    return {
      data: {},
      body: content.slice(match[0].length),
      error: `invalid YAML: ${e}`,
    }
  }
}

function parseExternalMarkdownAgent(
  content: string,
  agentPath: string,
  stem: string,
  entry: AgentSourceEntry
): AgentDefinition | null {
  if (content.length > MAX_AGENT_FILE_SIZE) return null
  const parsed = parseMarkdownFrontmatter(content)
  const diagnostics: AgentCompatibilityDiagnostic[] = []
  if (parsed.error) {
    diagnostics.push({
      severity: "error",
      code: "invalid_frontmatter",
      message: parsed.error,
    })
  }
  const data = parsed.data
  const nativeName = String(data.name ?? stem).trim()
  const description = String(data.description ?? "").trim()
  if (!nativeName) return null
  if (!description) {
    diagnostics.push({
      severity:
        entry.sourceKind === "github" || entry.sourceKind === "copilot"
          ? "error"
          : "warning",
      code: "missing_description",
      message: "description is missing",
    })
  }
  const userInvocable =
    "user-invocable" in data ? data["user-invocable"] !== false : true
  const agent = makeBaseDefinition({
    sourceKind: entry.sourceKind,
    scope: entry.scope,
    agentPath,
    source: entry.path,
    nativeName,
    description,
    body: parsed.body,
    userInvocable,
    sourceMetadata: data,
    diagnostics,
  })
  if (entry.sourceKind === "claude") {
    agent.tools = parseToolList(data, "tools")
    agent.skills = parseList(data, "skills")
    agent.sourceMetadata = {
      ...data,
      disallowedTools: parseToolList(data, "disallowedTools"),
      mcpServers: data.mcpServers,
    }
  } else if (entry.sourceKind === "cursor") {
    agent.sourceMetadata = {
      ...data,
      readonly: data.readonly,
      is_background: data.is_background,
    }
  } else if (entry.sourceKind === "github" || entry.sourceKind === "copilot") {
    agent.tools = parseList(data, "tools")
    agent.mcpServers = parseList(data, "mcp-servers")
  }
  return agent
}

function parseTomlStringValue(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"')
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }
  return trimmed || undefined
}

function parseCodexToml(
  content: string
): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let current: string | null = null
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const section = /^\[([^\]]+)\]$/.exec(trimmed)
    if (section) {
      current = section[1]
      sections[current] = sections[current] ?? {}
      continue
    }
    if (!current) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    sections[current][trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
  }
  return sections
}

function codexAgentFromToml(
  content: string,
  agentPath: string,
  nativeName: string,
  entry: AgentSourceEntry,
  metadata: Record<string, unknown> = {}
): AgentDefinition {
  const sections = parseCodexToml(content)
  const root = sections.agent ?? sections[""] ?? {}
  const name =
    parseTomlStringValue(root.name ?? "") ??
    parseTomlStringValue(metadata.name as string) ??
    nativeName
  const description =
    parseTomlStringValue(root.description ?? "") ??
    parseTomlStringValue(metadata.description as string) ??
    ""
  const body =
    parseTomlStringValue(root.developer_instructions ?? "") ??
    parseTomlStringValue(root.instructions ?? "") ??
    ""
  return makeBaseDefinition({
    sourceKind: "codex",
    scope: entry.scope,
    agentPath,
    source: entry.path,
    nativeName: name,
    description,
    body,
    userInvocable: true,
    sourceMetadata: {
      ...metadata,
      sections,
      sandbox_mode: parseTomlStringValue(root.sandbox_mode ?? ""),
    },
  })
}

// Fields a serialized agent carries. Mirrors AgentDefinition minus the runtime-only
// `path`/`source` (derived from where the file lives, not written into it).
export interface AgentFields {
  name: string
  description: string
  tools?: string[]
  skills?: string[]
  children?: string[]
  mcpServers?: string[]
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
  if (fields.mcpServers !== undefined) fm["mcp-servers"] = fields.mcpServers
  fm["user-invocable"] = fields.userInvocable

  // flowLevel: -1 keeps YAML in block style; lineWidth: -1 disables line wrapping so
  // long descriptions aren't folded. An empty array serializes as `key: []`.
  const yamlText = yaml.dump(fm, { lineWidth: -1, flowLevel: -1 }).trimEnd()
  return `---\n${yamlText}\n---\n${fields.body}`
}

// List agents in a single source directory. Reads flat `<name>.agent.md` files
// (unlike skills, which live in per-skill subdirectories).
export async function listSource(
  sourceDir: string,
  entry?: AgentSourceEntry
): Promise<AgentDefinition[]> {
  const sourceEntry = entry ?? inferSourceEntry(sourceDir)
  if (sourceEntry.sourceKind === "codex" && sourceDir.endsWith("config.toml")) {
    return listCodexConfig(sourceEntry)
  }
  let entries: string[]
  try {
    entries = await readdir(sourceDir)
  } catch {
    return [] // source doesn't exist yet — fine
  }

  const agents: AgentDefinition[] = []
  for (const entry of entries) {
    if (
      sourceEntry.sourceKind === "north_star" &&
      !entry.endsWith(AGENT_SUFFIX)
    )
      continue
    if (
      sourceEntry.sourceKind !== "north_star" &&
      !entry.endsWith(MARKDOWN_SUFFIX) &&
      !entry.endsWith(TOML_SUFFIX)
    )
      continue
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
    const stem = entry.endsWith(AGENT_SUFFIX)
      ? entry.slice(0, -AGENT_SUFFIX.length)
      : entry.replace(/\.[^.]+$/, "")
    const parsed =
      sourceEntry.sourceKind === "north_star"
        ? parseAgent(
            content,
            filePath,
            stem,
            sourceDir,
            sourceEntry.sourceKind,
            sourceEntry.scope
          )
        : sourceEntry.sourceKind === "codex" && entry.endsWith(TOML_SUFFIX)
          ? codexAgentFromToml(content, filePath, stem, sourceEntry)
          : parseExternalMarkdownAgent(content, filePath, stem, sourceEntry)
    if (parsed) agents.push(parsed)
  }
  return agents
}

async function listCodexConfig(
  entry: AgentSourceEntry
): Promise<AgentDefinition[]> {
  let content: string
  try {
    content = await readFile(entry.path, "utf-8")
  } catch {
    return []
  }
  const sections = parseCodexToml(content)
  const agents: AgentDefinition[] = []
  const baseDir = path.dirname(entry.path)
  for (const [section, values] of Object.entries(sections)) {
    if (!section.startsWith("agents.")) continue
    const nativeName = section.slice("agents.".length)
    const configFile = parseTomlStringValue(values.config_file ?? "")
    const description = parseTomlStringValue(values.description ?? "") ?? ""
    if (configFile) {
      const configPath = path.isAbsolute(configFile)
        ? configFile
        : path.join(baseDir, configFile)
      try {
        const agentContent = await readFile(configPath, "utf-8")
        agents.push(
          codexAgentFromToml(agentContent, configPath, nativeName, entry, {
            registry: values,
            name: nativeName,
            description,
          })
        )
        continue
      } catch {
        agents.push(
          makeBaseDefinition({
            sourceKind: "codex",
            scope: entry.scope,
            agentPath: configPath,
            source: entry.path,
            nativeName,
            description,
            body: "",
            userInvocable: true,
            sourceMetadata: { registry: values },
            diagnostics: [
              {
                severity: "error",
                code: "missing_config_file",
                message: `Unable to read referenced Codex agent config: ${configFile}`,
              },
            ],
          })
        )
        continue
      }
    }
    agents.push(
      makeBaseDefinition({
        sourceKind: "codex",
        scope: entry.scope,
        agentPath: entry.path,
        source: entry.path,
        nativeName,
        description,
        body: "",
        userInvocable: true,
        sourceMetadata: { registry: values },
      })
    )
  }
  return agents
}

async function canonicalPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath)
  } catch {
    return path.resolve(filePath)
  }
}

// Load agents from sources in order. Source-qualified identity keeps same-name
// definitions distinct; legacy bare-name resolution is handled by loadAgent.
export async function loadAgents(
  sources: string[]
): Promise<AgentDefinition[]> {
  const entries = agentSourceEntries()
  const bySource = new Map(
    entries.map((entry) => [path.resolve(entry.path), entry])
  )
  const byRef = new Map<string, AgentDefinition>()
  const seenPaths = new Set<string>()
  for (const source of sources) {
    const entry = bySource.get(path.resolve(source)) ?? inferSourceEntry(source)
    for (const agent of await listSource(source, entry)) {
      const physicalPath = await canonicalPath(agent.path)
      if (seenPaths.has(physicalPath)) continue
      seenPaths.add(physicalPath)
      byRef.set(agent.refId, agent)
    }
  }
  return [...byRef.values()]
}

// Resolve a single agent by name for the given workspace, honoring the same
// source order (workspace overrides user). Returns null if not found.
export async function loadAgent(
  name: string,
  workspace?: string
): Promise<AgentDefinition | null> {
  const agents = await loadAgents(agentSources(workspace))
  if (name.startsWith("agentref:v1:")) {
    return agents.find((a) => a.refId === name) ?? null
  }
  return [...agents].reverse().find((a) => a.name === name) ?? null
}
