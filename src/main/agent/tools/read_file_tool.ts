import { readFile, stat } from "fs/promises"
import { basename } from "path"
import type { Tool, ToolContext } from "./types"
import { resolveInWorkspaceReal } from "./workspace"
import { truncateForModel, toolError } from "./output"

// Largest file we'll read into context. Matches the attachment cap in
// agent/index.ts so the agent's two file-ingestion paths are bounded alike.
const MAX_READ_BYTES = 256 * 1024

// Resolve the model-supplied `path` to a safe absolute path. With a workspace,
// it must resolve inside it (symlinks included). Without one (Chat sessions),
// the only readable files are the user's attachments, so `path` must match one
// of them — by exact absolute path or by file name. Throws on any other path.
async function resolveReadable(ctx: ToolContext, path: string): Promise<string> {
  if (ctx.workspace) {
    return resolveInWorkspaceReal(ctx.workspace, path)
  }
  const attachments = ctx.attachments ?? []
  const match = attachments.find((a) => a === path || basename(a) === path)
  if (!match) {
    throw new Error(
      `"${path}" is not an attached file. Readable files: ${
        attachments.map((a) => basename(a)).join(", ") || "(none)"
      }.`
    )
  }
  return match
}

// Reads a UTF-8 text file inside the workspace, returning it with cat -n-style
// line numbers so the model (and edit_file) can reference exact lines. Supports
// offset/limit pagination for large files and refuses oversized/binary files.
export const readFileTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "read_file_tool",
      description:
        "Read a UTF-8 text file inside the workspace. Output is line-numbered. " +
        "Use offset/limit to page through large files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "The file to read. In a workspace, a path relative to the workspace " +
              "root. In a Chat session, the name (or path) of one of the attached files.",
          },
          offset: {
            type: "integer",
            description:
              "1-based line number to start reading from. Defaults to 1.",
          },
          limit: {
            type: "integer",
            description:
              "Maximum number of lines to return. Defaults to 2000.",
          },
        },
        required: ["path"],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    if (!path) return toolError("bad_args", "A `path` is required.")

    const target = await resolveReadable(ctx, path)

    let info
    try {
      info = await stat(target)
    } catch {
      return toolError("not_found", `No such file: ${path}`)
    }
    if (!info.isFile()) {
      return toolError("not_a_file", `Not a regular file: ${path}`)
    }
    if (info.size > MAX_READ_BYTES) {
      return toolError(
        "too_large",
        `File is ${info.size} bytes, over the ${MAX_READ_BYTES}-byte read limit.`,
        "read a smaller file, or use offset/limit to page through it"
      )
    }

    const buf = await readFile(target)
    // Binary detection: a NUL byte in the first chunk means this isn't text.
    if (buf.subarray(0, 8000).includes(0)) {
      return toolError(
        "binary",
        `File appears to be binary, not text: ${path}`
      )
    }

    const content = buf.toString("utf8")
    const allLines = content.split("\n")

    const offset =
      typeof args.offset === "number" && args.offset > 0
        ? Math.floor(args.offset)
        : 1
    const limit =
      typeof args.limit === "number" && args.limit > 0
        ? Math.floor(args.limit)
        : 2000

    const start = offset - 1
    const slice = allLines.slice(start, start + limit)
    if (slice.length === 0) {
      return toolError(
        "out_of_range",
        `offset ${offset} is past the end of the file (${allLines.length} lines).`
      )
    }

    // cat -n style: right-aligned line numbers + tab + content.
    const width = String(start + slice.length).length
    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(width)}\t${line}`)
      .join("\n")

    return truncateForModel(numbered).text
  },
}
