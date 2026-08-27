import { open as hostOpen, stat as hostStat } from "fs/promises"
import { basename } from "path"
import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { LocalEnvironment } from "../env/local"
import type { Environment, StatInfo } from "../env/types"
import { readHostTextLines } from "../env/read-text-lines"
import { renderMetadata, toolError } from "./output"

// Largest file we'll read into context. Matches the attachment cap in
// agent/index.ts so the agent's two file-ingestion paths are bounded alike.
const MAX_READ_BYTES = 256 * 1024
const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 2000

// Where a readable file lives: inside the env (workspace) or on the host (a Chat
// attachment, which is an arbitrary absolute host path the env doesn't apply to).
type Readable =
  | { source: "env"; path: string }
  | { source: "host"; path: string }

// Resolve the model-supplied `path` to a safe location. With a workspace it must
// resolve inside it (symlinks included), via the env. Without one (Chat sessions),
// the only readable files are the user's attachments, so `path` must match one of
// them — by exact absolute path or by file name — and is read from the host (the
// env is irrelevant: a container is only ever used when a workspace exists).
async function resolveReadable(
  ctx: ToolContext,
  env: Environment,
  path: string
): Promise<Readable> {
  if (ctx.workspace) {
    return { source: "env", path: await env.resolve(path) }
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
  return { source: "host", path: match }
}

// Reads a UTF-8 text file inside the workspace, returning it with cat -n-style
// line numbers so the model (and edit_file) can reference exact lines. Supports
// real offset/limit pagination for large files and returns continuation metadata.
export const readFileTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
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
            description: "Maximum number of lines to return. Defaults to 2000.",
          },
        },
        required: ["path"],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    if (!path) return toolError("bad_args", "A `path` is required.")

    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    let readable
    try {
      readable = await resolveReadable(ctx, env, path)
    } catch (error) {
      return toolError("not_allowed", (error as Error).message)
    }

    // Workspace reads go through the env (host or container); a Chat attachment is
    // an arbitrary host path, so it's read directly from the host fs.
    const statAt = (p: string): Promise<StatInfo> =>
      readable.source === "env" ? env.stat(p) : hostStat(p)
    const target = readable.path
    const offset =
      typeof args.offset === "number" && args.offset > 0
        ? Math.floor(args.offset)
        : 1
    const requestedLimit =
      typeof args.limit === "number" && args.limit > 0
        ? Math.floor(args.limit)
        : DEFAULT_LIMIT
    const limit = Math.min(requestedLimit, MAX_LIMIT)
    const readOpts = { offset, limit, maxBytes: MAX_READ_BYTES }
    const readTextAt = async (p: string, fileBytes: number) => {
      if (readable.source === "env") return env.readTextLines(p, readOpts)
      const handle = await hostOpen(p, "r")
      try {
        return await readHostTextLines(handle, fileBytes, readOpts)
      } finally {
        await handle.close()
      }
    }

    let info
    try {
      info = await statAt(target)
    } catch {
      return toolError("not_found", `No such file: ${path}`)
    }
    if (!info.isFile()) {
      return toolError("not_a_file", `Not a regular file: ${path}`)
    }

    let window
    try {
      window = await readTextAt(target, info.size)
    } catch (error) {
      if ((error as Error).message === "BINARY_FILE") {
        return toolError(
          "binary",
          `File appears to be binary, not text: ${path}`
        )
      }
      return toolError(
        "read_failed",
        `Could not read ${path}: ${(error as Error).message}`
      )
    }

    if (!window.text && window.endLine < window.startLine) {
      return toolError(
        "out_of_range",
        `offset ${offset} is past the end of the file.`
      )
    }

    // cat -n style: right-aligned line numbers + tab + content.
    const lines = window.text.split("\n")
    const width = String(window.endLine).length
    const numbered = lines
      .map(
        (line, i) => `${String(window.startLine + i).padStart(width)}\t${line}`
      )
      .join("\n")

    return `${numbered}\n${renderMetadata({
      startLine: window.startLine,
      endLine: window.endLine,
      hasMore: window.hasMore,
      nextOffset: window.nextOffset,
      fileBytes: window.fileBytes,
      truncated: window.truncated,
      revision: window.revision,
      lineTooLong: window.lineTooLong,
      skippedLineRemainder: window.skippedLineRemainder,
      limitCapped: requestedLimit !== limit || undefined,
    })}`
  },
}
