import type { Tool, ToolContext } from "./types"
import type { ToolAction } from "../approval/types"
import { normalizeCommand } from "../approval/normalize"
import { stripAnsi } from "../approval/ansi"
import { truncateForModel, toolError } from "./output"
import { LocalEnvironment } from "../env/local"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 1024 * 1024 // 1 MB hard cap on captured output

// Runs a shell command in the workspace. Gated through the shared approval
// pipeline (ctx.gate): catastrophic commands are hard-blocked and never spawn,
// risky commands prompt the human, benign commands run immediately.
export const runShellTool: Tool = {
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

    // A non-positive or non-finite timeout falls back to the default rather than
    // collapsing to an instant kill (Math.max(1, 0) would SIGKILL after 1ms).
    const requested =
      typeof args.timeout_ms === "number" && args.timeout_ms > 0
        ? args.timeout_ms
        : DEFAULT_TIMEOUT_MS
    const timeoutMs = Math.min(requested, MAX_TIMEOUT_MS)

    const action: ToolAction = {
      tool: "run_shell_tool",
      kind: "shell",
      summary: `$ ${command}`,
      identity: normalizeCommand(command),
      detail: { command },
    }

    // Route through the shared approval pipeline. Fail-closed: if no gate is
    // wired, never run a command that would otherwise need approval — but a
    // gate is always present in the real agent loop.
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)

    if (outcome === "blocked") {
      return toolError(
        "blocked",
        "This command is on the unconditional blocklist and was not run.",
        "run it yourself in a terminal outside the agent if you truly need it"
      )
    }
    if (outcome === "denied") {
      return toolError(
        "denied",
        "The user denied approval to run this command."
      )
    }

    // Run through the turn's execution backend (host or container). The byte cap
    // and multibyte-once decode live in the env; decode the returned Buffer once.
    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    const result = await env.exec(command, {
      cwd: ctx.workspace,
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      signal: ctx.signal,
    })
    const cleaned = stripAnsi(result.stdout.toString("utf8"))
    const body = truncateForModel(cleaned).text

    const status = result.timedOut
      ? `timed out after ${timeoutMs}ms (killed)`
      : result.signal
        ? `terminated by signal ${result.signal}`
        : `exit code ${result.exitCode ?? "unknown"}`

    return `[${status}]\n${body}`.trimEnd()
  },
}
