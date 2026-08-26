import { dirname } from "path"
import { TOOL_EFFECTS, type Tool } from "./types"
import type { ToolAction } from "../approval/types"
import { LocalEnvironment } from "../env/local"
import { toolError } from "./output"
import {
  atomicWriteChecked,
  buildDiffPreview,
  fileRevision,
  isNotFoundError,
  revisionOfText,
  validRevision,
} from "./file/mutation"

// Creates, overwrites, or appends to a file inside the workspace, creating
// parent directories as needed. Writes atomically and returns a short
// confirmation rather than echoing the content back (which would bloat the
// context window). The `append` mode lets a large file be built across several
// calls so no single call carries the whole blob as one oversized JSON argument
// (which can be truncated at the model's output-token cap and fail to parse).
export const writeFileTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "write_file_tool",
      description:
        'Write a file inside the workspace. mode "create" (default) creates a new file and rejects existing paths. ' +
        'mode "overwrite" replaces an existing file. mode "append" adds `content` to the ' +
        "end of the file (creating it if absent). Parent directories are created " +
        "automatically. Prefer edit_file_tool to modify an existing file. Use " +
        "create for small new files; for a large generated file, write it in " +
        "chunks — one create call, then repeated append calls — which avoids " +
        "truncating a huge single argument.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the workspace root.",
          },
          content: {
            type: "string",
            description:
              "The file content to write (the full file for create, or the chunk for append).",
          },
          mode: {
            type: "string",
            enum: ["create", "overwrite", "append"],
            description:
              'How to write. "create" (default) creates a new file and refuses to overwrite. ' +
              '"overwrite" replaces an existing file. ' +
              '"append" reads the existing file and appends content to the end ' +
              "(creating it if missing). Use append to build a large file across " +
              "multiple calls — keep each call's content to a manageable chunk.",
          },
          expected_revision: {
            type: "string",
            description:
              "Optional SHA-256 revision from read_file_tool metadata. Required to protect a known prior read across overwrite/append calls.",
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
    const mode = args.mode === undefined ? "create" : args.mode
    if (mode !== "create" && mode !== "overwrite" && mode !== "append") {
      return toolError(
        "bad_args",
        '`mode` must be "create", "overwrite", or "append".'
      )
    }
    const expectedRevision = validRevision(args.expected_revision)
    if (args.expected_revision !== undefined && !expectedRevision) {
      return toolError(
        "bad_args",
        "`expected_revision` must be a 64-character SHA-256 hex digest."
      )
    }

    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    const target = await env.resolve(path)

    let existingBytes: Buffer | undefined
    try {
      existingBytes = await env.readFile(target)
    } catch (error) {
      if (!isNotFoundError(error)) {
        return toolError(
          "read_failed",
          `Could not read ${path}: ${(error as Error).message}`
        )
      }
    }
    const initialRevision = existingBytes
      ? fileRevision(existingBytes)
      : undefined

    if (mode === "create" && existingBytes) {
      return toolError(
        "already_exists",
        `${path} already exists.`,
        'use mode "overwrite" with the current revision if replacement is intended'
      )
    }
    if (expectedRevision && expectedRevision !== initialRevision) {
      return toolError(
        "stale_file",
        `${path} changed since revision ${expectedRevision}. Current revision: ${initialRevision ?? "missing"}.`,
        "re-read the file and rebase the write"
      )
    }
    if (mode === "overwrite" && !existingBytes) {
      return toolError("not_found", `No such file to overwrite: ${path}`)
    }

    let finalContent = content
    if (mode === "append") {
      const existing = existingBytes?.toString("utf8") ?? ""
      finalContent = existing + content
    }
    const diff = buildDiffPreview({
      path,
      before: existingBytes?.toString("utf8") ?? "",
      after: finalContent,
      beforeRevision: initialRevision,
    })

    // Route through the shared approval pipeline (see ../approval). The default
    // file policy auto-allows, so behavior is unchanged today — but this makes
    // write_file a first-class pipeline participant, so gating file writes later
    // is a one-line classifier change, not an architectural one. The identity is
    // the target path alone (not mode/chunk) on purpose: a multi-chunk append
    // write reuses one identity, so a single allowlist approval covers it all
    // rather than re-prompting for every chunk.
    if (ctx.gate) {
      const action: ToolAction = {
        tool: "write_file_tool",
        kind: "file_write",
        summary: `${mode} ${path}`,
        identity: `file_write:${path}`,
        detail: { path, mode, expectedRevision: initialRevision, diff },
      }
      const outcome = await ctx.gate(action)
      if (outcome === "blocked") {
        return toolError("blocked", `Writing ${path} is blocked by policy.`)
      }
      if (outcome === "denied") {
        return toolError("denied", `The user denied approval to write ${path}.`)
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
    await env.mkdirp(dirname(target))
    const write = await atomicWriteChecked({
      env,
      target,
      content: finalContent,
      expectedRevision: initialRevision,
    })
    if (write !== "ok") {
      return toolError(
        "stale_file",
        `${path} changed before the write could be saved. Current revision: ${write.staleRevision ?? "missing"}.`,
        "re-read the file and rebase the write"
      )
    }

    const bytes = Buffer.byteLength(content, "utf8")
    return mode === "append"
      ? `Appended ${bytes} bytes to ${path}. Revision: ${revisionOfText(finalContent)}.`
      : `Wrote ${bytes} bytes to ${path}. Revision: ${revisionOfText(finalContent)}.`
  },
}
