import { invalid, object, onlyKeys } from "./errors"
import { nativeToolName, translateHistory } from "./history"

export interface InventoryTool {
  name: string
  description: string
  inputSchema: { type: "object"; [key: string]: any }
}

function schema(
  value: unknown,
  depth = 0
): asserts value is Record<string, any> {
  if (!object(value) || depth > 32)
    invalid("Malformed or excessively nested JSON schema.")
  if (
    value.type !== undefined &&
    ![
      "object",
      "array",
      "string",
      "number",
      "integer",
      "boolean",
      "null",
    ].includes(value.type)
  )
    invalid("Unsupported schema type.")
  onlyKeys(value, [
    "type",
    "title",
    "description",
    "properties",
    "required",
    "items",
    "additionalProperties",
    "anyOf",
    "oneOf",
    "allOf",
    "enum",
    "const",
    "default",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minItems",
    "maxItems",
    "uniqueItems",
    "minProperties",
    "maxProperties",
  ])
  for (const key of ["title", "description", "pattern", "format"]) {
    if (value[key] !== undefined && typeof value[key] !== "string")
      invalid("Malformed schema string constraint.")
  }
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    )
      invalid("Malformed schema numeric constraint.")
  }
  for (const key of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ]) {
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || value[key] < 0)
    )
      invalid("Malformed schema size constraint.")
  }
  for (const [min, max] of [
    ["minimum", "maximum"],
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
    ["minProperties", "maxProperties"],
  ]) {
    if (
      value[min] !== undefined &&
      value[max] !== undefined &&
      value[min] > value[max]
    )
      invalid("Contradictory schema constraints.")
  }
  if (value.multipleOf !== undefined && value.multipleOf <= 0)
    invalid("Malformed schema multipleOf.")
  if (value.uniqueItems !== undefined && typeof value.uniqueItems !== "boolean")
    invalid("Malformed schema uniqueItems.")
  if (
    value.additionalProperties !== undefined &&
    typeof value.additionalProperties !== "boolean" &&
    !object(value.additionalProperties)
  )
    invalid("Malformed schema additionalProperties.")
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) || !value.enum.length)
  )
    invalid("Malformed schema enum.")
  if (
    value.required !== undefined &&
    Array.isArray(value.required) &&
    new Set(value.required).size !== value.required.length
  )
    invalid("Duplicate schema required fields.")
  if (value.properties !== undefined) {
    if (!object(value.properties)) invalid("Malformed schema properties.")
    for (const child of Object.values(value.properties))
      schema(child, depth + 1)
  }
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) ||
      value.required.some(
        (key: unknown) =>
          typeof key !== "string" || !Object.hasOwn(value.properties ?? {}, key)
      ))
  )
    invalid("Malformed schema required fields.")
  if (value.items !== undefined) schema(value.items, depth + 1)
  if (object(value.additionalProperties))
    schema(value.additionalProperties, depth + 1)
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (value[key] !== undefined) {
      if (!Array.isArray(value[key]) || !value[key].length)
        invalid("Malformed schema union.")
      for (const child of value[key]) schema(child, depth + 1)
    }
  }
  // References require a resolver; reject rather than advertising a different schema.
  if (
    value.$ref !== undefined ||
    value.$defs !== undefined ||
    value.definitions !== undefined
  )
    invalid("Referenced tool schemas are not supported.")
}

export function validateRequest(body: Record<string, unknown>) {
  onlyKeys(body, [
    "model",
    "messages",
    "tools",
    "stream",
    "stream_options",
    "max_tokens",
    "max_completion_tokens",
    "reasoning_effort",
    "tool_choice",
    "response_format",
  ])
  if (
    typeof body.model !== "string" ||
    !/^(?:claude-[a-z0-9.-]+|sonnet|opus|haiku)$/.test(body.model)
  )
    invalid("An explicit Claude model is required.")
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    invalid("Invalid stream option.")
  if (body.stream_options !== undefined) {
    if (!object(body.stream_options)) invalid("Invalid stream usage options.")
    onlyKeys(body.stream_options, ["include_usage"])
    if (typeof body.stream_options.include_usage !== "boolean" || !body.stream)
      invalid("Unsupported stream usage options.")
  }
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined)
    invalid("Specify one output cap spelling.")
  const maxTokens = body.max_tokens ?? body.max_completion_tokens
  if (
    typeof maxTokens !== "number" ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > 128000
  )
    invalid("A bounded positive output cap is required.")
  const effort = body.reasoning_effort
  if (
    effort !== undefined &&
    (!["low", "medium", "high"].includes(String(effort)) ||
      !/^claude-(?:sonnet-4-6|opus-4-[56])(?:-|$)/.test(body.model))
  )
    invalid("Reasoning effort requires an explicitly supported Claude model.")
  const tools: InventoryTool[] = []
  const names = new Map<string, string>()
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) invalid("Invalid tool inventory.")
    for (const tool of body.tools) {
      if (!object(tool) || tool.type !== "function" || !object(tool.function))
        invalid("Only function tools are supported.")
      onlyKeys(tool, ["type", "function"])
      onlyKeys(tool.function, ["name", "description", "parameters", "strict"])
      const fn = tool.function
      const native = nativeToolName(fn.name)
      if (
        names.has(native) ||
        (fn.description !== undefined && typeof fn.description !== "string") ||
        (fn.strict !== undefined && fn.strict !== false)
      )
        invalid("Duplicate, malformed or strict tool definition.")
      schema(fn.parameters)
      if (fn.parameters.type !== "object")
        invalid("Tool schemas must be objects.")
      names.set(native, fn.name)
      tools.push({
        name: fn.name,
        description: fn.description ?? "",
        inputSchema: JSON.parse(JSON.stringify(fn.parameters)),
      })
    }
  }
  if (
    body.tool_choice !== undefined &&
    body.tool_choice !== "auto" &&
    body.tool_choice !== "none"
  )
    invalid("Unsupported tool choice.")
  const extraBody: Record<string, unknown> = {
    tools: tools.map((tool) => ({
      name: nativeToolName(tool.name),
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
    max_tokens: maxTokens,
    ...(body.tool_choice === "none" ? { tool_choice: { type: "none" } } : {}),
    ...(effort === undefined ? {} : { output_config: { effort } }),
  }
  if (body.response_format !== undefined) {
    if (!object(body.response_format)) invalid("Unsupported structured output.")
    onlyKeys(body.response_format, ["type", "json_schema"])
    if (body.response_format.type === "text") {
      if (body.response_format.json_schema !== undefined)
        invalid("Invalid text output format.")
    } else {
      const format = body.response_format.json_schema
      if (body.response_format.type !== "json_schema" || !object(format))
        invalid("Required structured output must use a JSON schema.")
      onlyKeys(format, ["name", "description", "strict", "schema"])
      if (
        typeof format.name !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(format.name) ||
        (format.description !== undefined &&
          typeof format.description !== "string") ||
        (format.strict !== undefined && typeof format.strict !== "boolean")
      )
        invalid("Malformed structured output definition.")
      schema(format.schema)
      extraBody.output_config = {
        ...(extraBody.output_config as object),
        format: { type: "json_schema", schema: format.schema },
      }
    }
  }
  const history = translateHistory(body.messages)
  return {
    ...history,
    model: body.model,
    maxTokens,
    effort,
    tools,
    names,
    extraBody,
    stream: body.stream === true,
  }
}
export type ValidatedRequest = ReturnType<typeof validateRequest>
