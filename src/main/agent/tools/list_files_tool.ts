import type { Tool } from "./types"
import { LocalEnvironment } from "../env/local"

// Lists files at a path within the workspace. Routes through the env's readdir
// and confines all access to the workspace root to avoid escape/injection.
export const listFilesTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "list_files_tool",
      description:
        "List the files and directories at a given path inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to the workspace root. Defaults to the workspace root.",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    const target = env.resolveLexical(path)
    const entries = await env.readdir(target)
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join("\n")
  },
}
