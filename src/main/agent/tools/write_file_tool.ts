import { dirname, join } from "path"
import type { Tool } from "./types"
import type { ToolAction } from "../approval/types"
import { LocalEnvironment } from "../env/local"
import type { Environment } from "../env/types"
import { toolError } from "./output"

// Atomic write: temp file in the same directory, then rename over the target.
// Both steps go through the env so the atomicity holds on host or in a container.
async function atomicWrite(
  env: Environment,
  target: string,
  content: string
): Promise<void> {
  const tmp = join(dirname(target), `.${Date.now()}-${process.pid}.tmp`)
  await env.writeFile(tmp, content)
  await env.rename(tmp, target)
}

// Creates or overwrites a file inside the workspace, creating parent
// directories as needed. Writes atomically and returns a short confirmation
// rather than echoing the content back (which would bloat the context window).
export const writeFileTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "write_file_tool",
      description:
        "Create or overwrite a file inside the workspace with the given content. " +
        "Parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the workspace root.",
          },
          content: {
            type: "string",
            description: "The full file content to write.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    if (!path) return toolError("bad_args", "A `path` is required.")
    if (typeof args.content !== "string") {
      return toolError("bad_args", "`content` must be a string.")
    }
    const content = args.content

    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    const target = await env.resolve(path)

    // Route through the shared approval pipeline (see ../approval). The default
    // file policy auto-allows, so behavior is unchanged today — but this makes
    // write_file a first-class pipeline participant, so gating file writes later
    // is a one-line classifier change, not an architectural one.
    if (ctx.gate) {
      const action: ToolAction = {
        tool: "write_file_tool",
        kind: "file_write",
        summary: `write ${path}`,
        identity: `file_write:${path}`,
        detail: { path },
      }
      const outcome = await ctx.gate(action)
      if (outcome === "blocked") {
        return toolError("blocked", `Writing ${path} is blocked by policy.`)
      }
      if (outcome === "denied") {
        return toolError("denied", `The user denied approval to write ${path}.`)
      }
    }

    await env.mkdirp(dirname(target))
    await atomicWrite(env, target, content)

    const bytes = Buffer.byteLength(content, "utf8")
    return `Wrote ${bytes} bytes to ${path}.`
  },
}
