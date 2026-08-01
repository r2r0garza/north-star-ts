import type { Tool, ToolContext } from "./types"
import { listFilesTool } from "./list_files_tool"
import { readFileTool } from "./read_file_tool"
import { searchTool } from "./search_tool"
import { editFileTool } from "./edit_file_tool"
import { writeFileTool } from "./write_file_tool"
import { runShellTool } from "./run_shell_tool"
import { todoWriteTool } from "./todo_tool"
import { askUserQuestionTool } from "./ask_user_question_tool"
import { runTodosInBackgroundTool } from "./run_todos_in_background"
import { indexQueryTool } from "./index_query_tool"
import { browserNavigateTool } from "./browser/navigate"
import { browserSnapshotTool } from "./browser/snapshot"
import { browserScreenshotTool } from "./browser/screenshot"
import { browserClickTool } from "./browser/click"
import { browserTypeTool } from "./browser/type"
import { browserBackTool } from "./browser/back"
import { browserCloseTool } from "./browser/close"
import { browserHandoffTool } from "./browser/handoff"

// Workspace-gated tools — offered only when the agent has a workspace (they
// touch the filesystem). Add a new filesystem tool by importing it and listing
// it below.
const workspaceTools: Tool[] = [
  listFilesTool,
  readFileTool,
  searchTool,
  editFileTool,
  writeFileTool,
  runShellTool,
]

// Tools gated by something other than the workspace (e.g. conversation mode).
// They're dispatchable via runTool but are NOT in `toolDefinitions`; runChat
// decides when to offer each one. todo_write is conversation-scoped (offered by
// mode); ask_user_question is offered in every mode (clarification is universal).
// run_todos_in_background is mode-scoped like todo_write (its handoff partner).
const otherTools: Tool[] = [
  todoWriteTool,
  askUserQuestionTool,
  runTodosInBackgroundTool,
  indexQueryTool,
]

// Browser tools — offered when the conversation has an agent browser available,
// independent of the workspace (a Chat session can open a URL too). Dispatchable
// via runTool; runChat adds their definitions from `browserToolDefinitions`.
const browserTools: Tool[] = [
  browserNavigateTool,
  browserSnapshotTool,
  browserScreenshotTool,
  browserClickTool,
  browserTypeTool,
  browserBackTool,
  browserCloseTool,
  browserHandoffTool,
]
export const browserToolDefinitions = browserTools.map((t) => t.definition)

// Schemas for the workspace-gated tools (the `tools` array when a workspace
// exists). Mode-gated tools are added by runChat from their exported definition.
export const toolDefinitions = workspaceTools.map((t) => t.definition)

// Lookup by name, used to execute any tool the model asked for.
const byName = new Map(
  [...workspaceTools, ...otherTools, ...browserTools].map((t) => [
    t.definition.function.name,
    t,
  ])
)

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

// Re-exported so runChat can offer them directly (they're not in toolDefinitions).
export { todoWriteTool } from "./todo_tool"
export { askUserQuestionTool } from "./ask_user_question_tool"
export { runTodosInBackgroundTool } from "./run_todos_in_background"
export { indexQueryTool } from "./index_query_tool"

export type { Tool, ToolContext } from "./types"
