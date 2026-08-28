import type { SkillMetadata } from "../skills/types"
import type { AgentCompatibilityDiagnostic, AgentDefinition } from "./types"
import { CATEGORY_TOOLS } from "./tool-categories"

export type AskUserQuestionPolicy = "allow" | "deny" | "suppress_when_headless"

export interface SkillPolicy {
  kind: "all" | "none" | "only"
  names?: Set<string>
}

export interface ChildAgentPolicy {
  kind: "all" | "none" | "only"
  names?: Set<string>
}

export interface McpPolicy {
  kind: "all" | "none" | "only"
  names?: Set<string>
  inlineRequiresSetup: string[]
}

export interface AgentCapabilityPolicy {
  builtins: "all" | Set<string>
  deniedBuiltins: Set<string>
  askUserQuestion: AskUserQuestionPolicy
  skills: SkillPolicy
  children: ChildAgentPolicy
  mcp: McpPolicy
  diagnostics: AgentCompatibilityDiagnostic[]
}

const NO_EXTERNAL_TOOLS = new Set<string>()

const UNSAFE_MUTATION_OR_EXECUTION = new Set([
  ...CATEGORY_TOOLS.edit,
  ...CATEGORY_TOOLS.execute,
])

const GITHUB_GROUPS: Record<string, string[]> = {
  agent: CATEGORY_TOOLS.agent,
  browser: CATEGORY_TOOLS.browser,
  edit: CATEGORY_TOOLS.edit,
  execute: CATEGORY_TOOLS.execute,
  read: CATEGORY_TOOLS.read,
  search: CATEGORY_TOOLS.search,
  todo: CATEGORY_TOOLS.todo,
  vscode: ["ask_user_question"],
  web: CATEGORY_TOOLS.web,
}

const GITHUB_TOOLS: Record<string, string[]> = {
  "read/readFile": ["read_file_tool"],
  "read/listFiles": ["list_files_tool"],
  "search/textSearch": ["search_tool"],
  "search/fileSearch": ["index_query_tool"],
  "web/fetch": ["web_fetch"],
  "web/search": ["web_search"],
  "vscode/askQuestions": ["ask_user_question"],
  "browser/navigate": ["browser_navigate"],
  "browser/snapshot": ["browser_snapshot"],
  "browser/screenshot": ["browser_screenshot"],
  "browser/click": ["browser_click"],
  "browser/type": ["browser_type"],
  "browser/back": ["browser_back"],
  "browser/close": ["browser_close"],
  "browser/handoff": ["browser_handoff"],
  "execute/runInTerminal": CATEGORY_TOOLS.execute,
  "edit/createFile": ["write_file_tool"],
  "edit/editFiles": ["edit_file_tool", "apply_patch_tool"],
}

const GITHUB_UNSUPPORTED = new Set([
  "vscode/extensions",
  "vscodeGeneral/rename",
  "vscodeGeneral/open",
  "vscodeGeneral/terminalSelection",
  "notebook/read",
  "notebook/edit",
  "notebook/run",
])

const CLAUDE_TOOLS: Record<string, string[]> = {
  Read: CATEGORY_TOOLS.read,
  Write: ["write_file_tool"],
  Edit: ["edit_file_tool", "apply_patch_tool"],
  Grep: ["search_tool"],
  Glob: ["search_tool", "index_query_tool"],
  Bash: CATEGORY_TOOLS.execute,
  PowerShell: CATEGORY_TOOLS.execute,
  WebFetch: ["web_fetch"],
  WebSearch: ["web_search"],
  TodoWrite: ["todo_write"],
  Task: ["run_todos_in_background"],
}

const CLAUDE_UNSUPPORTED = new Set([
  "LSP",
  "NotebookEdit",
  "NotebookRead",
  "Monitor",
  "Artifact",
  "Worktree",
])

function diag(
  code: string,
  message: string,
  severity: AgentCompatibilityDiagnostic["severity"] = "warning"
): AgentCompatibilityDiagnostic {
  return { severity, code, message }
}

function metadata(agent: AgentDefinition): Record<string, unknown> {
  return typeof agent.sourceMetadata === "object" &&
    agent.sourceMetadata !== null
    ? (agent.sourceMetadata as Record<string, unknown>)
    : {}
}

function listFromMetadata(
  agent: AgentDefinition,
  key: string
): string[] | undefined {
  const data = metadata(agent)
  if (!(key in data)) return undefined
  const raw = data[key]
  if (!Array.isArray(raw)) return []
  return raw.map((value) => String(value).trim()).filter(Boolean)
}

function boolFromMetadata(agent: AgentDefinition, key: string): boolean {
  return metadata(agent)[key] === true
}

function stringFromMetadata(
  agent: AgentDefinition,
  key: string
): string | undefined {
  const raw = metadata(agent)[key]
  return typeof raw === "string" ? raw : undefined
}

function grantAllGroups(): Set<string> {
  const allowed = new Set<string>()
  for (const tools of Object.values(GITHUB_GROUPS)) {
    for (const tool of tools) allowed.add(tool)
  }
  return allowed
}

function addTools(
  allowed: Set<string>,
  tools: string[],
  diagnostics: AgentCompatibilityDiagnostic[],
  provenance: string
) {
  if (tools.length === 0) {
    diagnostics.push(
      diag(
        "unsupported_tool",
        `${provenance} has no safe North Star equivalent`
      )
    )
    return
  }
  for (const tool of tools) allowed.add(tool)
}

function githubPolicy(agent: AgentDefinition): AgentCapabilityPolicy {
  const diagnostics = [...agent.diagnostics]
  const allowed = new Set<string>()
  const rawTools = agent.tools

  if (rawTools === undefined) {
    for (const tool of grantAllGroups()) allowed.add(tool)
  } else {
    for (const sourceTool of rawTools) {
      if (sourceTool in GITHUB_GROUPS) {
        addTools(allowed, GITHUB_GROUPS[sourceTool], diagnostics, sourceTool)
      } else if (sourceTool in GITHUB_TOOLS) {
        addTools(allowed, GITHUB_TOOLS[sourceTool], diagnostics, sourceTool)
      } else {
        diagnostics.push(
          diag(
            GITHUB_UNSUPPORTED.has(sourceTool)
              ? "unsupported_tool_group_member"
              : "unsupported_tool",
            `${sourceTool} has no safe North Star equivalent`
          )
        )
      }
    }
  }

  return {
    builtins: allowed,
    deniedBuiltins: new Set(),
    askUserQuestion: allowed.has("ask_user_question") ? "allow" : "deny",
    skills: { kind: "none" },
    children: allowed.has("spawn_subagent")
      ? { kind: "all" }
      : { kind: "none" },
    mcp: mcpPolicyFromAgent(agent, diagnostics),
    diagnostics,
  }
}

function parseParameterizedRule(rule: string): {
  base: string
  args: string[]
  hasWildcard: boolean
} {
  const match = /^([A-Za-z]+)(?:\((.*)\))?$/.exec(rule.trim())
  if (!match) return { base: rule.trim(), args: [], hasWildcard: false }
  const args = (match[2] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
  const hasWildcard =
    args.includes("*") || args.some((arg) => arg.endsWith(" *"))
  return {
    base: match[1],
    args: args.filter((arg) => arg !== "*" && !arg.endsWith(" *")),
    hasWildcard,
  }
}

function applyClaudeRule(
  rule: string,
  allowed: Set<string>,
  denied: Set<string>,
  diagnostics: AgentCompatibilityDiagnostic[],
  mode: "allow" | "deny"
) {
  const parsed = parseParameterizedRule(rule)
  if (parsed.base === "Agent" || parsed.base === "Skill") return
  const mapped = CLAUDE_TOOLS[parsed.base]
  if (mapped) {
    for (const tool of mapped) (mode === "allow" ? allowed : denied).add(tool)
    return
  }
  diagnostics.push(
    diag(
      CLAUDE_UNSUPPORTED.has(parsed.base)
        ? "unsupported_tool_group_member"
        : "unsupported_tool",
      `${rule} has no safe North Star equivalent`
    )
  )
}

function claudeSkillPolicy(agent: AgentDefinition): SkillPolicy {
  const rules = agent.tools
  if (rules === undefined) return { kind: "all" }
  const skillRules = rules
    .map(parseParameterizedRule)
    .filter((r) => r.base === "Skill")
  if (skillRules.length === 0) return { kind: "none" }
  if (skillRules.some((rule) => rule.args.length === 0 || rule.hasWildcard)) {
    return { kind: "all" }
  }
  return {
    kind: "only",
    names: new Set(skillRules.flatMap((rule) => rule.args)),
  }
}

function claudeChildPolicy(agent: AgentDefinition): ChildAgentPolicy {
  const rules = agent.tools
  if (rules === undefined) return { kind: "all" }
  const agentRules = rules
    .map(parseParameterizedRule)
    .filter((r) => r.base === "Agent")
  if (agentRules.length === 0) return { kind: "none" }
  if (agentRules.some((rule) => rule.args.length === 0)) return { kind: "all" }
  return {
    kind: "only",
    names: new Set(agentRules.flatMap((rule) => rule.args)),
  }
}

function claudePolicy(agent: AgentDefinition): AgentCapabilityPolicy {
  const diagnostics = [...agent.diagnostics]
  const allowed = new Set<string>()
  const denied = new Set<string>()
  if (agent.tools === undefined) {
    for (const tools of Object.values(CLAUDE_TOOLS)) {
      for (const tool of tools) allowed.add(tool)
    }
    allowed.add("read_skill")
    allowed.add("spawn_subagent")
  } else {
    for (const rule of agent.tools) {
      applyClaudeRule(rule, allowed, denied, diagnostics, "allow")
    }
    if (
      agent.tools.some((rule) => parseParameterizedRule(rule).base === "Skill")
    ) {
      allowed.add("read_skill")
    }
    if (
      agent.tools.some((rule) => parseParameterizedRule(rule).base === "Agent")
    ) {
      allowed.add("spawn_subagent")
    }
  }
  for (const rule of listFromMetadata(agent, "disallowedTools") ?? []) {
    applyClaudeRule(rule, allowed, denied, diagnostics, "deny")
  }
  return {
    builtins: allowed,
    deniedBuiltins: denied,
    askUserQuestion: "suppress_when_headless",
    skills: claudeSkillPolicy(agent),
    children: claudeChildPolicy(agent),
    mcp: mcpPolicyFromAgent(agent, diagnostics),
    diagnostics,
  }
}

function cursorPolicy(agent: AgentDefinition): AgentCapabilityPolicy {
  const denied = boolFromMetadata(agent, "readonly")
    ? new Set([...UNSAFE_MUTATION_OR_EXECUTION, "spawn_subagent"])
    : new Set(["spawn_subagent"])
  return {
    builtins: "all",
    deniedBuiltins: denied,
    askUserQuestion: "suppress_when_headless",
    skills: { kind: "all" },
    children: { kind: "none" },
    mcp: { kind: "all", inlineRequiresSetup: [] },
    diagnostics: [
      ...agent.diagnostics,
      ...(boolFromMetadata(agent, "readonly")
        ? [
            diag(
              "source_restriction_narrowed",
              "Cursor readonly removed mutation and execution tools"
            ),
          ]
        : []),
    ],
  }
}

function codexPolicy(agent: AgentDefinition): AgentCapabilityPolicy {
  const sandbox = codexSandboxMode(agent)
  const readonly = sandbox === "read-only"
  return {
    builtins: "all",
    deniedBuiltins: readonly
      ? new Set([...UNSAFE_MUTATION_OR_EXECUTION, "spawn_subagent"])
      : new Set(["spawn_subagent"]),
    askUserQuestion: "suppress_when_headless",
    skills: { kind: "all" },
    children: { kind: "none" },
    mcp: { kind: "all", inlineRequiresSetup: [] },
    diagnostics: [
      ...agent.diagnostics,
      ...(readonly
        ? [
            diag(
              "source_restriction_narrowed",
              "Codex read-only sandbox removed mutation and execution tools"
            ),
          ]
        : []),
      ...(sandbox === "danger-full-access"
        ? [
            diag(
              "source_restriction_narrowed",
              "Codex danger-full-access does not widen North Star safety boundaries"
            ),
          ]
        : []),
    ],
  }
}

function codexSandboxMode(agent: AgentDefinition): string | undefined {
  const data = metadata(agent)
  const direct = stringFromMetadata(agent, "sandbox_mode")
  if (direct) return direct
  const sections = data.sections
  if (typeof sections !== "object" || sections === null) return undefined
  const agentSection = (sections as Record<string, unknown>).agent
  if (typeof agentSection !== "object" || agentSection === null) {
    return undefined
  }
  const raw = (agentSection as Record<string, unknown>).sandbox_mode
  return typeof raw === "string" ? raw.replace(/^["']|["']$/g, "") : undefined
}

function mcpPolicyFromAgent(
  agent: AgentDefinition,
  diagnostics: AgentCompatibilityDiagnostic[]
): McpPolicy {
  const inline = metadata(agent).mcpServers
  const inlineNames =
    typeof inline === "object" && inline !== null && !Array.isArray(inline)
      ? Object.keys(inline)
      : []
  for (const name of inlineNames) {
    diagnostics.push(
      diag(
        "inline_mcp_requires_setup",
        `${name} requires review in North Star MCP settings before use`
      )
    )
  }
  if (agent.mcpServers === undefined) {
    return { kind: "all", inlineRequiresSetup: inlineNames }
  }
  if (agent.mcpServers.length === 0) {
    return { kind: "none", inlineRequiresSetup: inlineNames }
  }
  return {
    kind: "only",
    names: new Set(agent.mcpServers),
    inlineRequiresSetup: inlineNames,
  }
}

export function agentCapabilityPolicy(
  agent: AgentDefinition | null
): AgentCapabilityPolicy | null {
  if (!agent || agent.sourceKind === "north_star") return null
  switch (agent.sourceKind) {
    case "github":
      return githubPolicy(agent)
    case "claude":
      return claudePolicy(agent)
    case "cursor":
      return cursorPolicy(agent)
    case "codex":
      return codexPolicy(agent)
  }
}

export function resolvePolicySkills(
  agent: AgentDefinition | null,
  allSkills: SkillMetadata[],
  policy: AgentCapabilityPolicy | null
): SkillMetadata[] {
  if (!policy) {
    return agent?.skills === undefined
      ? allSkills
      : allSkills.filter((s) => agent.skills!.includes(s.name))
  }
  if (policy.skills.kind === "none") return []
  const preload = agent?.sourceKind === "claude" ? agent.skills : undefined
  const base =
    preload === undefined
      ? allSkills
      : allSkills.filter((skill) => preload.includes(skill.name))
  if (policy.skills.kind === "all") return base
  return base.filter((skill) => policy.skills.names?.has(skill.name))
}

export function resolvePolicyChildren(
  parent: AgentDefinition,
  loadable: AgentDefinition[],
  policy: AgentCapabilityPolicy | null
): AgentDefinition[] {
  if (!policy) {
    const allow = parent.children!
    return loadable.filter(
      (agent) =>
        agent.name !== parent.name &&
        (allow.length === 0 || allow.includes(agent.name))
    )
  }
  if (policy.children.kind === "none") return []
  return loadable.filter((agent) => {
    if (agent.refId === parent.refId) return false
    if (policy.children.kind === "all") return true
    return (
      policy.children.names?.has(agent.name) &&
      agent.sourceKind === parent.sourceKind
    )
  })
}

export function resolvePolicyMcpServers(
  agent: AgentDefinition | null,
  enabledNames: string[],
  policy: AgentCapabilityPolicy | null
): string[] {
  if (!policy) {
    if (!agent || agent.mcpServers === undefined) return [...enabledNames]
    if (agent.mcpServers.length === 0) return []
    const allow = new Set(agent.mcpServers)
    return enabledNames.filter((name) => allow.has(name))
  }
  if (policy.mcp.kind === "none") return []
  if (policy.mcp.kind === "all") return [...enabledNames]
  return enabledNames.filter((name) => policy.mcp.names?.has(name))
}

export function externalAgentToolFilter(
  policy: AgentCapabilityPolicy | null,
  suppressUserQuestions: boolean
): ((name: string) => boolean) | null {
  if (!policy) return null
  return (name: string) => {
    if (name === "ask_user_question") {
      if (suppressUserQuestions) return false
      return (
        policy.askUserQuestion === "allow" ||
        policy.askUserQuestion === "suppress_when_headless"
      )
    }
    if (policy.deniedBuiltins.has(name)) return false
    if (policy.builtins === "all") return true
    return policy.builtins.has(name)
  }
}

export function agentCapabilitySummary(
  agent: AgentDefinition,
  policy: AgentCapabilityPolicy | null,
  offeredNames: string[]
): string | null {
  if (!policy) return null
  const diagnostics = policy.diagnostics
    .slice(0, 8)
    .map((d) => `- ${d.code}: ${d.message}`)
  const content = [
    "## External agent capability policy",
    `Source: ${agent.label}`,
    `Offered built-in tools: ${offeredNames.length ? offeredNames.sort().join(", ") : "none"}`,
    diagnostics.length
      ? ["Compatibility diagnostics:", ...diagnostics].join("\n")
      : "Compatibility diagnostics: none",
  ].join("\n")
  return content
}
