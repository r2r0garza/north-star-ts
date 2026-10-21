export const ACTIVITY_FIELD = "_activity"
const MAX_ACTIVITY_LENGTH = 120
const DESCRIPTION =
  "Optional display-only activity title: briefly describe what you are doing and its subject in conversational language (e.g. Inspecting acceptance prompts and prompt construction). Use a single line, at most 120 characters. Do not include raw queries, shell syntax, secrets, reasoning, or claims of success."

export function activityLabel(
  args: Record<string, unknown> | null
): string | undefined {
  const value = args?.[ACTIVITY_FIELD]
  if (typeof value !== "string") return undefined
  const label = value.replace(/\s+/g, " ").trim()
  if (!label || label.length > MAX_ACTIVITY_LENGTH) return undefined
  return label
}

export function executionArguments(
  args: Record<string, unknown>
): Record<string, unknown> {
  const { [ACTIVITY_FIELD]: _activity, ...rest } = args
  return rest
}

interface Definition {
  function: { parameters: Record<string, unknown> }
}

export function withToolActivity<T extends Definition>(definition: T): T {
  const schema = definition.function.parameters
  if (
    schema.type !== "object" ||
    schema.oneOf ||
    schema.anyOf ||
    schema.allOf ||
    schema.$ref
  )
    return definition
  const properties = schema.properties
  if (
    properties !== undefined &&
    (!properties || typeof properties !== "object" || Array.isArray(properties))
  )
    return definition
  if (properties && Object.hasOwn(properties, ACTIVITY_FIELD)) return definition
  return {
    ...definition,
    function: {
      ...definition.function,
      parameters: {
        ...schema,
        properties: {
          ...properties,
          [ACTIVITY_FIELD]: { type: "string", description: DESCRIPTION },
        },
      },
    },
  }
}

export function acceptsToolActivity(definition: Definition): boolean {
  const properties = definition.function.parameters.properties as
    | Record<string, unknown>
    | undefined
  const field = properties?.[ACTIVITY_FIELD] as
    | Record<string, unknown>
    | undefined
  return field?.description === DESCRIPTION
}
