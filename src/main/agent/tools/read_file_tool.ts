import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { LocalEnvironment } from "../env/local"
import { readHostTextLines } from "../env/read-text-lines"
import { supportedDocumentKind } from "./document_extraction_tool"
import { renderMetadata, toolError } from "./output"
import { HostFileError, openHostFile, resolveReadable } from "./host_files"
import { renderContextEnvelope } from "../context/provenance"

// Largest file we'll read into context. Matches the attachment cap in
// agent/index.ts so the agent's two file-ingestion paths are bounded alike.
const MAX_READ_BYTES = 256 * 1024
const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 2000

// Reads a UTF-8 text file inside the workspace, returning it with cat -n-style
// line numbers so the model (and edit_file) can reference exact lines. Supports
// real offset/limit pagination for large files and returns continuation metadata.
export const readFileTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  executionPolicy: { timeoutMs: 30000 },
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
              "root, or an activated skill resource URI like skill://name/path. " +
              "In a Chat session, the name (or path) of one of the attached files.",
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

    const offset =
      typeof args.offset === "number" && args.offset > 0
        ? Math.floor(args.offset)
        : 1
    const requestedLimit =
      typeof args.limit === "number" && args.limit > 0
        ? Math.floor(args.limit)
        : DEFAULT_LIMIT
    const limit = Math.min(requestedLimit, MAX_LIMIT)
    const readOpts = {
      offset,
      limit,
      maxBytes: MAX_READ_BYTES,
      signal: ctx.signal,
    }

    // Workspace reads go through the env (host or container). A host file (a Chat
    // attachment or skill resource) is opened once through the hardened opener and
    // validated on the handle itself, so there is no stat-then-open window.
    let window
    try {
      if (readable.source === "env") {
        let info
        try {
          info = await env.stat(readable.path)
        } catch {
          return toolError("not_found", `No such file: ${path}`)
        }
        if (!info.isFile()) {
          return toolError("not_a_file", `Not a regular file: ${path}`)
        }
        window = await env.readTextLines(readable.path, readOpts)
      } else {
        let opened
        try {
          opened = await openHostFile(readable.path, readable.origin)
        } catch (error) {
          if (error instanceof HostFileError && error.code === "not_found") {
            return toolError("not_found", `No such file: ${path}`)
          }
          if (error instanceof HostFileError && error.code === "not_a_file") {
            return toolError("not_a_file", `Not a regular file: ${path}`)
          }
          throw error
        }
        try {
          window = await readHostTextLines(opened.handle, opened.size, readOpts)
        } finally {
          await opened.handle.close()
        }
      }
    } catch (error) {
      if ((error as Error).message === "BINARY_FILE") {
        const kind = supportedDocumentKind(path)
        return toolError(
          "binary",
          `File appears to be binary, not text: ${path}`,
          kind
            ? "Use read_document for supported binary documents and image metadata."
            : undefined
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

    return renderContextEnvelope(
      {
        trust: "untrusted_data",
        channel: readable.source === "host" ? "user" : "file",
        source: path,
      },
      `${numbered}\n${renderMetadata({
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
    )
  },
}
