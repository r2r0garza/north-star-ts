import type { Tool, ToolContext, ToolEffects } from "./types"
import { listFilesTool } from "./list_files_tool"
import { readFileTool } from "./read_file_tool"
import { searchTool } from "./search_tool"
import { editFileTool } from "./edit_file_tool"
import { writeFileTool } from "./write_file_tool"
import { applyPatchTool } from "./apply_patch_tool"
import { runShellTool } from "./run_shell_tool"
import {
  execCommandTool,
  pollCommandTool,
  terminateCommandTool,
  writeStdinTool,
} from "./command_session_tools"
import {
  getTestResultsTool,
  runTestsTool,
  workspaceDiagnosticsTool,
} from "./test_diagnostics_tools"
import {
  documentSymbolsTool,
  findReferencesTool,
  goToDefinitionTool,
  hoverTypeTool,
  workspaceSymbolsTool,
} from "./code_navigation_tools"
import {
  createDirectoryTool,
  deletePathTool,
  movePathTool,
  statPathTool,
} from "./filesystem_lifecycle_tools"
import {
  gitBranchesTool,
  gitDiffTool,
  gitLogTool,
  gitShowTool,
  gitStatusTool,
} from "./git_tools"
import { readDocumentTool } from "./document_extraction_tool"
import { todoWriteTool } from "./todo_tool"
import { askUserQuestionTool } from "./ask_user_question_tool"
import { runTodosInBackgroundTool } from "./run_todos_in_background"
import { indexQueryTool } from "./index_query_tool"
import { writePlanTool } from "./write_plan_tool"
import { readPlanTool } from "./read_plan_tool"
import { presentPlanTool } from "./present_plan_tool"
import { browserNavigateTool } from "./browser/navigate"
import { browserSnapshotTool } from "./browser/snapshot"
import { browserScreenshotTool } from "./browser/screenshot"
import { browserClickTool } from "./browser/click"
import { browserTypeTool } from "./browser/type"
import { browserBackTool } from "./browser/back"
import { browserCloseTool } from "./browser/close"
import { browserHandoffTool } from "./browser/handoff"
import { webSearchTool } from "./web/search"
import { webFetchTool } from "./web/fetch"
import { spawnSubagentTool } from "./spawn_subagent"
import { flagForReworkTool } from "./flag_for_rework"
import { dashboardWriteTool } from "./dashboard_write"

// Workspace-gated tools — offered only when the agent has a workspace (they
// touch the filesystem). Add a new filesystem tool by importing it and listing
// it below.
const workspaceTools: Tool[] = [
  listFilesTool,
  readFileTool,
  searchTool,
  editFileTool,
  writeFileTool,
  applyPatchTool,
  execCommandTool,
  writeStdinTool,
  pollCommandTool,
  terminateCommandTool,
  workspaceDiagnosticsTool,
  runTestsTool,
  getTestResultsTool,
  workspaceSymbolsTool,
  documentSymbolsTool,
  goToDefinitionTool,
  findReferencesTool,
  hoverTypeTool,
  statPathTool,
  createDirectoryTool,
  movePathTool,
  deletePathTool,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitShowTool,
  gitBranchesTool,
  readDocumentTool,
]

// Legacy compatibility tools remain executable by name for old/internal callers,
// but are not advertised in the model-facing toolDefinitions array. The public
// shell surface is exec_command + write_stdin/poll_command/terminate_command.
const legacyTools: Tool[] = [runShellTool]

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
  // Plan-mode tools: offered by runChat only while plan mode is active. Not in
  // toolDefinitions; dispatchable via runTool. read_plan is also offered after
  // approval so the implementing turn can re-read the approved plan.
  writePlanTool,
  readPlanTool,
  presentPlanTool,
  // spawn_subagent: offered by runChat only when the running custom agent is
  // permitted to spawn (agent tool category + children present). Not in
  // toolDefinitions; dispatchable via runTool.
  spawnSubagentTool,
  // flag_for_rework: offered by runChat only to a Process phase worker (plan
  // 031.2 — when opts.processRunId is set). Not in toolDefinitions.
  flagForReworkTool,
  // dashboard_write: offered by runChat in interactive modes (plan 033.2 —
  // gated on showTodos like todo_write). Writes only its own tables; not gated.
  dashboardWriteTool,
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

// Web tools — headless web access, offered in every mode independent of the
// workspace or the visible browser (a Chat session can search/fetch too).
// web_search is not gated; web_fetch routes through the approval gate (kind
// "web"). Dispatchable via runTool; runChat adds their definitions from
// `webToolDefinitions`.
const webTools: Tool[] = [webSearchTool, webFetchTool]
// Split so runChat can offer web_search in plan mode (read-only, like file
// reads) while withholding web_fetch (a gated network side effect).
export const webSearchDefinition = webSearchTool.definition
export const webFetchDefinition = webFetchTool.definition

// Schemas for the workspace-gated tools (the `tools` array when a workspace
// exists). Mode-gated tools are added by runChat from their exported definition.
export const toolDefinitions = workspaceTools.map((t) => t.definition)

// Lookup by name, used to execute any tool the model asked for.
const byName = new Map(
  [
    ...workspaceTools,
    ...legacyTools,
    ...otherTools,
    ...browserTools,
    ...webTools,
  ].map((t) => [t.definition.function.name, t])
)

export const builtInTools = [
  ...workspaceTools,
  ...legacyTools,
  ...otherTools,
  ...browserTools,
  ...webTools,
]

export function getToolEffects(name: string): ToolEffects | undefined {
  return byName.get(name)?.effects
}

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
export { writePlanTool } from "./write_plan_tool"
export { readPlanTool } from "./read_plan_tool"
export { presentPlanTool } from "./present_plan_tool"
export { flagForReworkTool } from "./flag_for_rework"
export { dashboardWriteTool } from "./dashboard_write"

export type { Tool, ToolContext } from "./types"
