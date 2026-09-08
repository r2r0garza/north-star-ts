import { dirname } from "path"
import { TOOL_EFFECTS, type Tool } from "./types"
import type { ToolAction } from "../approval/types"
import { LocalEnvironment } from "../env/local"
import { toolError } from "./output"
import {
  atomicWriteChecked,
  buildDiffPreview,
  cleanupMessage,
  fileTooLargeMessage,
  fileRevision,
  isManagedMemoryPath,
  isNotFoundError,
  MANAGED_MEMORY_WRITE_ERROR,
  MUTATION_SOURCE_LIMITS,
  revisionOfText,
  validRevision,
} from "./file/mutation"
import { isSkillResourceUri } from "./skill_resources"

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
        "truncating a huge single argument. Omit `expected_revision` for create; " +
        "never send empty, zero-filled, or invented revision placeholders.",
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
              "Optional SHA-256 revision from read_file_tool metadata. Omit for create. For overwrite/append, include only a real revision returned by read_file_tool or a prior successful write_file_tool call; never use empty, zero-filled, or invented placeholders.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    if (!path) return toolError("bad_args", "A `path` is required.")
    if (isSkillResourceUri(path)) {
      return toolError(
        "not_allowed",
        "Skill resources are read-only and cannot be written."
      )
    }
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
    const rawExpectedRevision =
      mode === "create" && args.expected_revision === ""
        ? undefined
        : args.expected_revision
    const expectedRevision = validRevision(rawExpectedRevision)
    if (rawExpectedRevision !== undefined && !expectedRevision) {
      const hint =
        mode === "create"
          ? "omit `expected_revision` for create calls"
          : "use the real revision returned by read_file_tool or a prior successful write_file_tool call"
      return toolError(
        "bad_args",
        "`expected_revision` must be a 64-character SHA-256 hex digest.",
        hint
      )
    }

    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    const target = await env.resolve(path)
    if (isManagedMemoryPath(target)) {
      return toolError("not_allowed", MANAGED_MEMORY_WRITE_ERROR)
    }

    let existingInfo
    try {
      existingInfo = await env.stat(target)
    } catch (error) {
      if (!isNotFoundError(error)) {
        return toolError(
          "read_failed",
          `Could not inspect ${path}: ${(error as Error).message}`
        )
      }
    }
    if (existingInfo && !existingInfo.isFile()) {
      return toolError("not_a_file", `Not a regular file: ${path}`)
    }
    if (mode === "create" && existingInfo) {
      return toolError(
        "already_exists",
        `${path} already exists.`,
        'use mode "overwrite" with the current revision if replacement is intended'
      )
    }
    if (mode === "overwrite" && !existingInfo) {
      return toolError("not_found", `No such file to overwrite: ${path}`)
    }
    if (
      existingInfo &&
      existingInfo.size > MUTATION_SOURCE_LIMITS.maxFileBytes
    ) {
      return toolError(
        "file_too_large",
        fileTooLargeMessage({
          code: "file_too_large",
          path,
          size: existingInfo.size,
          limit: MUTATION_SOURCE_LIMITS.maxFileBytes,
          scope: "file",
        })
      )
    }

    let existingBytes: Buffer | undefined
    if (existingInfo) {
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
    }
    const initialRevision = existingBytes
      ? fileRevision(existingBytes)
      : undefined

    if (expectedRevision && expectedRevision !== initialRevision) {
      return toolError(
        "stale_file",
        `${path} changed since revision ${expectedRevision}. Current revision: ${initialRevision ?? "missing"}.`,
        "re-read the file and rebase the write"
      )
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
      path,
      content: finalContent,
      expectedRevision: initialRevision,
    })
    if (write !== "ok") {
      if ("code" in write && write.code === "file_too_large") {
        return toolError(
          "file_too_large",
          `${fileTooLargeMessage(write)}${cleanupMessage(write.cleanupErrors)}`
        )
      }
      if ("code" in write && write.code === "cleanup_failed") {
        return toolError(
          "cleanup_failed",
          `File content was written to ${path}, but cleanup failed.${cleanupMessage(write.cleanupErrors)} Manual cleanup is required for the retained paths.`
        )
      }
      if ("code" in write && write.code === "commit_failed") {
        return toolError(
          "commit_failed",
          `Write failed before ${path} was committed: ${write.error}${cleanupMessage(write.cleanupErrors)}`
        )
      }
      const staleRevision =
        "staleRevision" in write ? write.staleRevision : null
      return toolError(
        "stale_file",
        `${path} changed before the write could be saved. Current revision: ${staleRevision ?? "missing"}.${cleanupMessage("cleanupErrors" in write ? write.cleanupErrors : undefined)}`,
        "re-read the file and rebase the write"
      )
    }

    const bytes = Buffer.byteLength(content, "utf8")
    return mode === "append"
      ? `Appended ${bytes} bytes to ${path}. Revision: ${revisionOfText(finalContent)}.`
      : `Wrote ${bytes} bytes to ${path}. Revision: ${revisionOfText(finalContent)}.`
  },
}
