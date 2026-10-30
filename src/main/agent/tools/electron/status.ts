import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import { NO_ELECTRON, renderSessions } from "./shared"
import { toolError } from "../output"

export const electronStatusTool: Tool = {
  effects: TOOL_EFFECTS.readOnlySequential,
  definition: {
    type: "function",
    function: {
      name: "electron_status",
      description:
        "List this conversation's Electron app sessions, or one session by id: " +
        "state (launching/ready/closing/exited/crashed/failed), windows, exit " +
        "information, cleanup outcome and recent stdout/stderr. Never launches " +
        "or attaches to anything.",
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description: "Optional session id from electron_launch.",
          },
        },
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.electron) return NO_ELECTRON
    const sessionId =
      typeof args.sessionId === "string" ? args.sessionId : undefined
    const sessions = await ctx.electron.status(sessionId)
    if (sessionId && sessions.length === 0)
      return toolError(
        "unknown_session",
        "No app session with that id belongs to this conversation."
      )
    return renderSessions(sessions)
  },
}
