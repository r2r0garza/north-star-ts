const AGENT_REF_PREFIX = "agentref:v1:"

interface AgentDisplayMetadata {
  nativeName?: string
  sourceKind?: string
  scope?: string
}

export interface AgentDisplay {
  name: string
  source: string | null
  scope: string | null
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function parseAgentRef(value: string): AgentDisplayMetadata | null {
  if (!value.startsWith(AGENT_REF_PREFIX)) return null

  try {
    const parsed = JSON.parse(value.slice(AGENT_REF_PREFIX.length)) as unknown
    if (!parsed || typeof parsed !== "object") return null

    const candidate = parsed as Record<string, unknown>
    return {
      nativeName:
        typeof candidate.nativeName === "string"
          ? candidate.nativeName
          : undefined,
      sourceKind:
        typeof candidate.sourceKind === "string"
          ? candidate.sourceKind
          : undefined,
      scope: typeof candidate.scope === "string" ? candidate.scope : undefined,
    }
  } catch {
    return null
  }
}

// Process definitions persist the full durable agent reference in `agentName`.
// Turn it back into presentation metadata without changing the saved value. The
// catalog is preferred, while parsing keeps old definitions readable if their
// source is temporarily unavailable.
export function agentDisplay(
  value: string,
  metadata?: AgentDisplayMetadata
): AgentDisplay {
  const ref = parseAgentRef(value)
  const name = metadata?.nativeName || ref?.nativeName || value
  const sourceKind = metadata?.sourceKind || ref?.sourceKind
  const scope = metadata?.scope || ref?.scope

  return {
    name,
    source: sourceKind ? titleCase(sourceKind) : null,
    scope: scope ? titleCase(scope) : null,
  }
}
