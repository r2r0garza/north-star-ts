import { dirname, join } from "path"
import type { Tool } from "./types"
import type { ToolAction } from "../approval/types"
import { LocalEnvironment } from "../env/local"
import type { Environment } from "../env/types"
import { toolError } from "./output"

// Count non-overlapping occurrences of `needle` in `haystack`.
function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0
  let count = 0
  let idx = haystack.indexOf(needle)
  while (idx !== -1) {
    count++
    idx = haystack.indexOf(needle, idx + needle.length)
  }
  return count
}

// Write `content` to `target` atomically: write a sibling temp file, then rename
// over the target (rename is atomic within a filesystem). Avoids leaving a
// half-written file if the process dies mid-write. Routed through the env so it
// holds on host or in a container.
async function atomicWrite(
  env: Environment,
  target: string,
  content: string
): Promise<void> {
  const tmp = join(
    dirname(target),
    `.${Date.now()}-${process.pid}.tmp` // unique within the dir
  )
  await env.writeFile(tmp, content)
  await env.rename(tmp, target)
}

// Replaces an exact string in a workspace file. Requires `old_string` to occur
// exactly once (unless replace_all), returning an actionable error otherwise so
// the model can add surrounding context and retry. Writes atomically.
export const editFileTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "edit_file_tool",
      description:
        "Replace an exact string in a file inside the workspace. `old_string` " +
        "must match exactly once (include surrounding context to disambiguate), " +
        "unless replace_all is true. Use this to modify an existing file; use " +
        "write_file_tool to create new files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the workspace root.",
          },
          old_string: {
            type: "string",
            description: "The exact text to find and replace.",
          },
          new_string: {
            type: "string",
            description: "The text to replace it with.",
          },
          replace_all: {
            type: "boolean",
            description:
              "Replace every occurrence instead of requiring a unique match. Defaults to false.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    const oldString = typeof args.old_string === "string" ? args.old_string : ""
    const newString = typeof args.new_string === "string" ? args.new_string : ""
    const replaceAll = args.replace_all === true

    if (!path) return toolError("bad_args", "A `path` is required.")
    if (oldString === "") {
      return toolError("bad_args", "`old_string` must not be empty.")
    }
    if (oldString === newString) {
      return toolError(
        "no_op",
        "`old_string` and `new_string` are identical — nothing to change."
      )
    }

    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    const target = await env.resolve(path)

    let info
    try {
      info = await env.stat(target)
    } catch {
      return toolError("not_found", `No such file: ${path}`)
    }
    if (!info.isFile()) {
      return toolError("not_a_file", `Not a regular file: ${path}`)
    }

    const content = (await env.readFile(target)).toString("utf8")
    const occurrences = countOccurrences(content, oldString)

    if (occurrences === 0) {
      return toolError(
        "no_match",
        `\`old_string\` was not found in ${path}.`,
        "check whitespace and indentation, or add surrounding context"
      )
    }
    if (occurrences > 1 && !replaceAll) {
      return toolError(
        "ambiguous",
        `\`old_string\` matches ${occurrences} places in ${path}.`,
        "add more surrounding context to make it unique, or set replace_all: true"
      )
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString)

    // Route through the shared approval pipeline (see ../approval). The default
    // file policy auto-allows; this makes edit_file a first-class pipeline
    // participant so future gating needs no architectural change.
    if (ctx.gate) {
      const action: ToolAction = {
        tool: "edit_file_tool",
        kind: "file_edit",
        summary: `edit ${path}`,
        identity: `file_edit:${path}`,
        detail: { path },
      }
      const outcome = await ctx.gate(action)
      if (outcome === "blocked") {
        return toolError("blocked", `Editing ${path} is blocked by policy.`)
      }
      if (outcome === "denied") {
        return toolError("denied", `The user denied approval to edit ${path}.`)
      }
    }

    await atomicWrite(env, target, updated)

    const replaced = replaceAll ? occurrences : 1
    return `Replaced ${replaced} occurrence${replaced === 1 ? "" : "s"} in ${path}.`
  },
}
