import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { toolError } from "./output"
import { runShellCompatibility } from "./command_session_tools"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000

// Runs a shell command in the workspace. Gated through the shared approval
// pipeline (ctx.gate): catastrophic commands are hard-blocked and never spawn,
// risky commands prompt the human, benign commands run immediately.
export const runShellTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "run_shell_tool",
      description:
        "Run a shell command in the workspace directory and return its combined " +
        "stdout and stderr plus the exit code. Use for builds, tests, git, file " +
        "management, and other command-line tasks. A human-approval gate handles " +
        "safety: safe commands run immediately, risky ones (e.g. rm -rf, git reset " +
        "--hard) pause for the user to approve or deny, and only a few catastrophic " +
        "commands are blocked. Do NOT refuse risky-but-reasonable commands on your " +
        "own — issue them and let the user decide via the approval prompt.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The shell command to run (executed via the system shell).",
          },
          timeout_ms: {
            type: "integer",
            description:
              "Optional timeout in milliseconds. Defaults to 30000; capped at 600000.",
          },
        },
        required: ["command"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    const command = typeof args.command === "string" ? args.command.trim() : ""
    if (!command) return toolError("bad_args", "A `command` is required.")

    // This tool is workspace-only — it must never run with an unconfined cwd.
    // In a Chat session ctx.workspace is "", which child_process would treat as
    // "no cwd" and silently fall back to the app's process directory; bail out
    // so the tool fails closed exactly like the file tools do.
    if (!ctx.workspace) {
      return toolError("no_workspace", "Shell commands require a workspace.")
    }

    return runShellCompatibility(
      {
        ...args,
        timeout_ms:
          typeof args.timeout_ms === "number" && args.timeout_ms > 0
            ? Math.min(args.timeout_ms, MAX_TIMEOUT_MS)
            : DEFAULT_TIMEOUT_MS,
      },
      ctx
    )
  },
}
