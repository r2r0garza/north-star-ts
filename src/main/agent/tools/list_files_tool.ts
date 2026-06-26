import { readdir } from "fs/promises"
import type { Tool } from "./types"
import { resolveInWorkspace } from "./workspace"

// Lists files at a path within the workspace. Uses fs.readdir (no shell) and
// confines all access to the workspace root to avoid escape/injection.
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
    const target = resolveInWorkspace(ctx.workspace, path)
    const entries = await readdir(target, { withFileTypes: true })
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join("\n")
  },
}
