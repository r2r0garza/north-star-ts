import { TOOL_EFFECTS, type Tool, type ToolContext } from "../types"
import type { ToolAction } from "../../approval/types"
import { toolError } from "../output"
import { launchIdentity, type LaunchDescriptor } from "../../../electron-apps/launch"
import { NO_ELECTRON, electronError, renderSessions } from "./shared"

const ISOLATION_TEXT: Record<LaunchDescriptor["isolation"], string> = {
  "north-star-test-profile":
    "disposable test profile (--test-profile: app data and home redirected)",
  "electron-user-data-dir":
    "disposable Electron userData (--user-data-dir); the app can still write to your real home directory",
}

function approvalSummary(d: LaunchDescriptor): string {
  return [
    `Launch Electron app ${d.entry}`,
    `Runtime: ${d.executable}`,
    `Args: ${d.args.length ? JSON.stringify(d.args) : "(none)"}`,
    `Working directory: ${d.cwd}`,
    `Profile: ${ISOLATION_TEXT[d.isolation]}`,
    "Environment: minimal (PATH, locale, temp, display); provider keys are not passed",
    "The app runs with your user privileges and network access. It can still read its own .env files and OS credentials.",
  ].join("\n")
}

export const electronLaunchTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  executionPolicy: { timeoutMs: 150_000 },
  definition: {
    type: "function",
    function: {
      name: "electron_launch",
      description:
        "Launch a workspace Electron app under development as a separate test " +
        "instance, using the workspace's own node_modules/electron and a " +
        "disposable profile. Requires the user's explicit approval. Returns a " +
        "sessionId and the app's windows once one is controllable. The app " +
        "keeps running across turns until electron_close (or the user stops " +
        "it). It does not build or install anything: if the build or Electron " +
        "is missing, run that separately first. Bundled/packaged apps are not " +
        "supported. Prefer this over writing Electron or Playwright launch scripts.",
      parameters: {
        type: "object",
        properties: {
          entry: {
            type: "string",
            description:
              "Workspace-relative app directory (with package.json whose `main` is built) or main script (.js/.cjs/.mjs).",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description:
              "Extra app arguments (max 32). Debugging, profile and sandbox-weakening flags are rejected.",
          },
          cwd: {
            type: "string",
            description: "Workspace-relative working directory. Default: the workspace root.",
          },
          startup_timeout_ms: {
            type: "number",
            description: "How long to wait for the first window (1000–120000, default 30000).",
          },
        },
        required: ["entry"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.electron) return NO_ELECTRON
    // A retried invocation reports its first outcome instead of a second app.
    const previous = ctx.electron.previous(ctx.invocationId)
    if (previous) return renderSessions([previous])

    let descriptor: LaunchDescriptor
    try {
      descriptor = await ctx.electron.prepare(args)
    } catch (error) {
      return electronError(error)
    }
    const action: ToolAction = {
      tool: "electron_launch",
      kind: "electron",
      summary: approvalSummary(descriptor),
      identity: launchIdentity(descriptor),
      detail: { ...descriptor },
    }
    const outcome = ctx.gate ? await ctx.gate(action) : ("denied" as const)
    if (outcome === "blocked")
      return toolError("blocked", "Launching this app was blocked.")
    if (outcome === "denied")
      return toolError("denied", "The user denied approval to launch this app.")

    try {
      return renderSessions([
        await ctx.electron.launch(args, descriptor, ctx.invocationId),
      ])
    } catch (error) {
      return electronError(error)
    }
  },
}
