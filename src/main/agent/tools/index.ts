import type { Tool, ToolContext } from "./types"
import { listFilesTool } from "./list_files_tool"

// Register tools here — add a new tool by importing it and listing it below.
const registry: Tool[] = [listFilesTool]

// Schemas sent to the model (the `tools` array in the chat request).
export const toolDefinitions = registry.map((t) => t.definition)

// Lookup by name, used to execute a tool the model asked for.
const byName = new Map(registry.map((t) => [t.definition.function.name, t]))

// Run a tool call by name. Returns a string result (or an error message).
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const tool = byName.get(name)
  if (!tool) return `Unknown tool: ${name}`
  try {
    return await tool.execute(args, ctx)
  } catch (err) {
    return `Error running ${name}: ${
      err instanceof Error ? err.message : String(err)
    }`
  }
}

export type { Tool, ToolContext } from "./types"
