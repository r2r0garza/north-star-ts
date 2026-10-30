import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import { toolError } from "../output"
import { NO_ELECTRON, electronError, renderSessions } from "./shared"

// Not gated: it only stops an app session this conversation launched and owns.
export const electronCloseTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  executionPolicy: { timeoutMs: 30_000 },
  definition: {
    type: "function",
    function: {
      name: "electron_close",
      description:
        "Close an Electron app session this conversation launched: graceful " +
        "quit, then force-stop of only its own processes, then removal of its " +
        "disposable profile. Reports the cleanup outcome. Safe to repeat.",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Session id to close." },
        },
        required: ["sessionId"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.electron) return NO_ELECTRON
    if (typeof args.sessionId !== "string" || !args.sessionId)
      return toolError("bad_args", "A `sessionId` is required.")
    try {
      return renderSessions([await ctx.electron.close(args.sessionId)])
    } catch (error) {
      return electronError(error)
    }
  },
}
