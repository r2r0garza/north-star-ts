export const SUBAGENT_LIMITS = {
  maxAssignments: 4,
  maxAssignmentIdBytes: 64,
  maxPromptBytes: 16 * 1024,
  maxInstructionBytes: 64 * 1024,
  maxAnswerBytes: 8 * 1024,
  maxTouchedFiles: 50,
  maxResultBytes: 48 * 1024,
} as const

export type EphemeralSubagentProfile =
  | "clone"
  | "general"
  | "planner"
  | "explore"
export type SubagentAccess = "read" | "write"

export type SubagentSelector =
  | { type: "ephemeral"; profile: EphemeralSubagentProfile }
  | { type: "named"; name: string }

export interface SubagentAssignment {
  id: string
  agent: SubagentSelector
  prompt: string
  access: SubagentAccess
  instructionUri?: string
}

export interface SpawnSubagentsInput {
  assignments: SubagentAssignment[]
  prepareIntegration?: boolean
}

export interface SubagentResult {
  id: string
  status: "completed" | "failed" | "stopped"
  identity: string
  access: SubagentAccess
  content?: string
  error?: string
  taskId?: string
  conversationId?: string
  durationMs?: number
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  branch?: string
  commits?: string[]
  touchedFiles?: string[]
  touchedFileCount?: number
  touchedFilesTruncated?: boolean
  mergeability?: "clean" | "conflicted" | "unverified" | "stale"
  conflictingPaths?: string[]
  integrationBranch?: string
  integrationStatus?: "prepared" | "conflicted" | "stale" | "failed"
  integrationError?: string
  truncated?: boolean
}

const bytes = (value: string) => Buffer.byteLength(value, "utf8")
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
const NAME = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$|^[a-z0-9]$/

export function validateSpawnSubagentsInput(
  value: unknown,
  opts: { planMode: boolean; writeEnabled: boolean }
): { ok: true; value: SpawnSubagentsInput } | { ok: false; error: string } {
  if (!value || typeof value !== "object")
    return { ok: false, error: "assignments are required" }
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.assignments))
    return { ok: false, error: "assignments must be an array" }
  if (
    raw.assignments.length < 1 ||
    raw.assignments.length > SUBAGENT_LIMITS.maxAssignments
  ) {
    return {
      ok: false,
      error: `assignments must contain 1-${SUBAGENT_LIMITS.maxAssignments} items`,
    }
  }
  const ids = new Set<string>()
  const assignments: SubagentAssignment[] = []
  for (const [index, item] of raw.assignments.entries()) {
    if (!item || typeof item !== "object")
      return { ok: false, error: `assignment ${index + 1} must be an object` }
    const a = item as Record<string, unknown>
    const id = typeof a.id === "string" ? a.id.trim() : ""
    if (!ID.test(id) || bytes(id) > SUBAGENT_LIMITS.maxAssignmentIdBytes)
      return { ok: false, error: `assignment ${index + 1} has an invalid id` }
    if (ids.has(id)) return { ok: false, error: `duplicate assignment id '${id}'` }
    ids.add(id)
    const prompt = typeof a.prompt === "string" ? a.prompt.trim() : ""
    if (!prompt || bytes(prompt) > SUBAGENT_LIMITS.maxPromptBytes)
      return { ok: false, error: `assignment '${id}' has an invalid prompt` }
    const access = a.access
    if (access !== "read" && access !== "write")
      return { ok: false, error: `assignment '${id}' has invalid access` }
    if (access === "write" && opts.planMode)
      return { ok: false, error: "write subagents are unavailable in plan mode" }
    if (access === "write" && !opts.writeEnabled)
      return { ok: false, error: "write_subagents_unavailable" }
    const agent = a.agent
    if (!agent || typeof agent !== "object")
      return { ok: false, error: `assignment '${id}' has invalid agent` }
    const selector = agent as Record<string, unknown>
    let parsedAgent: SubagentSelector
    if (selector.type === "ephemeral") {
      if (
        selector.profile !== "clone" &&
        selector.profile !== "general" &&
        selector.profile !== "planner" &&
        selector.profile !== "explore"
      )
        return { ok: false, error: `assignment '${id}' has invalid profile` }
      if (
        access === "write" &&
        (selector.profile === "planner" || selector.profile === "explore")
      )
        return {
          ok: false,
          error: `${selector.profile} subagents only support read access`,
        }
      parsedAgent = { type: "ephemeral", profile: selector.profile }
    } else if (selector.type === "named") {
      const name = typeof selector.name === "string" ? selector.name.trim() : ""
      if (!NAME.test(name) || name.length > 64)
        return { ok: false, error: `assignment '${id}' has invalid agent name` }
      parsedAgent = { type: "named", name }
    } else {
      return { ok: false, error: `assignment '${id}' has invalid agent type` }
    }
    const instructionUri =
      typeof a.instruction_uri === "string" ? a.instruction_uri.trim() : undefined
    if (instructionUri && !/^skill:\/\/[a-z0-9-]+\/.+/.test(instructionUri))
      return { ok: false, error: `assignment '${id}' has invalid instruction_uri` }
    assignments.push({
      id,
      agent: parsedAgent,
      prompt,
      access,
      instructionUri,
    })
  }
  return {
    ok: true,
    value: {
      assignments,
      prepareIntegration: raw.prepare_integration === true,
    },
  }
}

function clipUtf8(value: string, max: number): { value: string; truncated: boolean } {
  if (bytes(value) <= max) return { value, truncated: false }
  let end = Math.min(value.length, max)
  while (end > 0 && bytes(value.slice(0, end)) > max) end -= 1
  return { value: value.slice(0, end), truncated: true }
}

export function serializeSubagentResults(results: SubagentResult[]): string {
  const bounded = results.map((result) => {
    const clipped = result.content
      ? clipUtf8(result.content, SUBAGENT_LIMITS.maxAnswerBytes)
      : undefined
    return {
      ...result,
      content: clipped?.value,
      truncated: result.truncated || clipped?.truncated || undefined,
    }
  })
  let json = JSON.stringify({ results: bounded })
  if (bytes(json) <= SUBAGENT_LIMITS.maxResultBytes) return json
  for (const result of bounded) {
    if (result.content) {
      result.content = clipUtf8(result.content, 1024).value
      result.truncated = true
    }
  }
  json = JSON.stringify({ results: bounded, aggregateTruncated: true })
  return clipUtf8(json, SUBAGENT_LIMITS.maxResultBytes).value
}
