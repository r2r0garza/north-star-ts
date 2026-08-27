import { toolError } from "./tools/output"

export interface OfferedToolDefinition {
  function: {
    name: string
  }
}

export function offeredToolNames(
  definitions: OfferedToolDefinition[]
): Set<string> {
  return new Set(definitions.map((definition) => definition.function.name))
}

export function unavailableToolResult(
  name: string,
  offered: Set<string>
): string | null {
  if (offered.has(name)) return null
  return toolError(
    "tool_unavailable",
    `Tool ${JSON.stringify(name)} was not offered in this model round.`,
    "Use only the tools available in the current tool list."
  )
}
