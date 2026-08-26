import { TOOL_EFFECTS, type Tool } from "./types"
import type { ToolAction } from "../approval/types"
import { LocalEnvironment } from "../env/local"
import { toolError } from "./output"
import {
  atomicWriteChecked,
  buildDiffPreview,
  fileTooLargeMessage,
  fileRevision,
  MUTATION_SOURCE_LIMITS,
  validRevision,
} from "./file/mutation"

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

// Replaces an exact string in a workspace file. Requires `old_string` to occur
// exactly once (unless replace_all), returning an actionable error otherwise so
// the model can add surrounding context and retry. Writes atomically.
export const editFileTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
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
          expected_revision: {
            type: "string",
            description:
              "Optional SHA-256 revision from read_file_tool metadata. When provided, the edit is rejected if the file changed since that read.",
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
    const expectedRevision = validRevision(args.expected_revision)

    if (!path) return toolError("bad_args", "A `path` is required.")
    if (args.expected_revision !== undefined && !expectedRevision) {
      return toolError(
        "bad_args",
        "`expected_revision` must be a 64-character SHA-256 hex digest."
      )
    }
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
    if (info.size > MUTATION_SOURCE_LIMITS.maxFileBytes) {
      return toolError(
        "file_too_large",
        fileTooLargeMessage({
          code: "file_too_large",
          path,
          size: info.size,
          limit: MUTATION_SOURCE_LIMITS.maxFileBytes,
          scope: "file",
        })
      )
    }

    const initialBytes = await env.readFile(target)
    const initialRevision = fileRevision(initialBytes)
    if (expectedRevision && expectedRevision !== initialRevision) {
      return toolError(
        "stale_file",
        `${path} changed since revision ${expectedRevision}. Current revision: ${initialRevision}.`,
        "re-read the file and rebase the edit"
      )
    }
    const content = initialBytes.toString("utf8")
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
    const diff = buildDiffPreview({
      path,
      before: content,
      after: updated,
      beforeRevision: initialRevision,
    })

    // Route through the shared approval pipeline (see ../approval). The default
    // file policy auto-allows; this makes edit_file a first-class pipeline
    // participant so future gating needs no architectural change.
    if (ctx.gate) {
      const action: ToolAction = {
        tool: "edit_file_tool",
        kind: "file_edit",
        summary: `edit ${path}`,
        identity: `file_edit:${path}`,
        detail: { path, expectedRevision: initialRevision, diff },
      }
      const outcome = await ctx.gate(action)
      if (outcome === "blocked") {
        return toolError("blocked", `Editing ${path} is blocked by policy.`)
      }
      if (outcome === "denied") {
        return toolError("denied", `The user denied approval to edit ${path}.`)
      }
    }

    const checkedTarget = await env.resolve(path)
    if (checkedTarget !== target) {
      return toolError(
        "stale_file",
        `${path} resolved to a different target before writing.`,
        "re-read the file and retry"
      )
    }
    const write = await atomicWriteChecked({
      env,
      target,
      content: updated,
      expectedRevision: initialRevision,
    })
    if (write !== "ok") {
      if ("code" in write && write.code === "file_too_large") {
        return toolError("file_too_large", fileTooLargeMessage(write))
      }
      const staleRevision =
        "staleRevision" in write ? write.staleRevision : null
      return toolError(
        "stale_file",
        `${path} changed before the edit could be written. Current revision: ${staleRevision ?? "missing"}.`,
        "re-read the file and rebase the edit"
      )
    }

    const replaced = replaceAll ? occurrences : 1
    return `Replaced ${replaced} occurrence${replaced === 1 ? "" : "s"} in ${path}. Revision: ${diff.newRevision}.`
  },
}
