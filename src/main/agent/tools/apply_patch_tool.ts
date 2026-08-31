import { LocalEnvironment } from "../env/local"
import type { ToolAction } from "../approval/types"
import { toolError } from "./output"
import { TOOL_EFFECTS, type Tool } from "./types"
import {
  commitPatch,
  parsePatchOperations,
  planPatch,
  type PlannedPatch,
} from "./file/patch"
import {
  cleanupMessage,
  FileTooLargeError,
  fileTooLargeMessage,
} from "./file/mutation"
import { isSkillResourceUri } from "./skill_resources"

function errorFromMessage(message: string): string {
  const [code, ...rest] = message.split(":")
  if (
    code === "no_match" ||
    code === "ambiguous" ||
    code === "not_found" ||
    code === "not_a_file" ||
    code === "binary_file" ||
    code === "stale_file" ||
    code === "already_exists" ||
    code === "conflict" ||
    code === "case_collision" ||
    code === "too_many_files" ||
    code === "file_too_large" ||
    code === "result_too_large" ||
    code === "no_op"
  ) {
    return toolError(code, rest.join(":").trim() || message)
  }
  return toolError("invalid_patch", message)
}

function summarizePatch(planned: PlannedPatch): string {
  const counts = new Map<string, number>()
  for (const file of planned.files) {
    counts.set(file.status, (counts.get(file.status) ?? 0) + 1)
  }
  return ["added", "updated", "moved", "deleted"]
    .map((status) => {
      const count = counts.get(status)
      return count ? `${count} ${status}` : ""
    })
    .filter(Boolean)
    .join(", ")
}

function combinedDiff(planned: PlannedPatch): string {
  return planned.diffs.map((diff) => diff.diff).join("\n")
}

export const applyPatchTool: Tool = {
  effects: TOOL_EFFECTS.destructiveMutation,
  definition: {
    type: "function",
    function: {
      name: "apply_patch_tool",
      description:
        "Apply a bounded structured multi-file patch inside the workspace. " +
        "The patch is fully validated before any file is changed, then committed " +
        "with staged temp files and rollback on failure. Use this for coordinated " +
        "adds, exact-context updates, moves, and deletes.",
      parameters: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            description:
              "Ordered patch operations. Each path is workspace-relative.",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["add", "update", "move", "delete"],
                },
                path: { type: "string" },
                new_path: {
                  type: "string",
                  description: "Destination path for move operations.",
                },
                content: {
                  type: "string",
                  description: "Complete new file content for add operations.",
                },
                hunks: {
                  type: "array",
                  description:
                    "Exact-context hunks for update and move operations.",
                  items: {
                    type: "object",
                    properties: {
                      old_string: { type: "string" },
                      new_string: { type: "string" },
                    },
                    required: ["old_string", "new_string"],
                  },
                },
                expected_revision: {
                  type: "string",
                  description:
                    "Optional SHA-256 revision from read_file_tool metadata.",
                },
              },
              required: ["type", "path"],
            },
          },
        },
        required: ["operations"],
      },
    },
  },
  execute: async (args, ctx) => {
    const operations = parsePatchOperations(args.operations)
    if (typeof operations === "string") {
      return toolError("bad_args", operations)
    }
    if (
      operations.some(
        (op) =>
          isSkillResourceUri(op.path) ||
          ("new_path" in op && isSkillResourceUri(op.new_path))
      )
    ) {
      return toolError(
        "not_allowed",
        "Skill resources are read-only and cannot be patched."
      )
    }

    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    let planned: PlannedPatch
    try {
      planned = await planPatch(env, operations)
    } catch (err) {
      if (err instanceof FileTooLargeError) {
        return toolError("file_too_large", fileTooLargeMessage(err))
      }
      return errorFromMessage(err instanceof Error ? err.message : String(err))
    }

    if (ctx.gate) {
      const paths = planned.files.map((file) => file.path)
      const action: ToolAction = {
        tool: "apply_patch_tool",
        kind: planned.destructive ? "file_write" : "file_edit",
        summary: `apply patch: ${summarizePatch(planned)}`,
        identity: `apply_patch:${paths.join(",")}`,
        detail: {
          paths,
          diff: {
            files: planned.diffs,
            combined: combinedDiff(planned),
          },
        },
      }
      const outcome = await ctx.gate(action)
      if (outcome === "blocked") {
        return toolError("blocked", "Applying this patch is blocked by policy.")
      }
      if (outcome === "denied") {
        return toolError(
          "denied",
          "The user denied approval to apply this patch."
        )
      }
    }

    const committed = await commitPatch(env, planned)
    if (committed !== "ok") {
      if (committed.code === "file_too_large") {
        return toolError(
          "file_too_large",
          `${fileTooLargeMessage(committed)}${cleanupMessage(committed.cleanupErrors)}`
        )
      }
      if (committed.code === "stale_file") {
        const mode =
          committed.currentMode === undefined
            ? ""
            : ` Current mode: ${committed.currentMode.toString(8)}; expected mode: ${committed.expectedMode?.toString(8) ?? "unknown"}.`
        return toolError(
          "stale_file",
          `${committed.path} changed before the patch could be saved. Current revision: ${committed.current ?? "missing"}.${mode}${cleanupMessage(committed.cleanupErrors)}`,
          "re-read the affected files and rebase the patch"
        )
      }
      if (committed.code === "commit_failed") {
        return toolError(
          "commit_failed",
          `Patch commit failed and all staged content changes were rolled back: ${committed.error}${cleanupMessage(committed.cleanupErrors)}`
        )
      }
      if (committed.code === "cleanup_failed") {
        return toolError(
          "cleanup_failed",
          `Patch content was applied, but cleanup failed.${cleanupMessage(committed.cleanupErrors)} Manual cleanup is required for the retained paths.`
        )
      }
      return toolError(
        "rollback_failed",
        `Patch commit failed and rollback did not fully recover: ${committed.error}${cleanupMessage(committed.cleanupErrors)}`
      )
    }

    const lines = planned.files.map((file) => {
      const revision = file.afterRevision
        ? ` Revision: ${file.afterRevision}.`
        : ""
      return `- ${file.status} ${file.path}.${revision}`
    })
    return [`Applied patch: ${summarizePatch(planned)}.`, ...lines].join("\n")
  },
}
