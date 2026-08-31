import { TOOL_EFFECTS, type Tool } from "./types"
import { LocalEnvironment } from "../env/local"
import type { DirEntry, ListDirResult } from "../env/types"
import { renderMetadata, toolError } from "./output"
import { isSkillResourceUri, resolveSkillResourcePath } from "./skill_resources"

const MAX_LIST_ENTRIES = 2000
const MAX_LIST_BYTES = 128 * 1024

// Lists files at a path within the workspace. Routes through the env's readdir
// and confines all access to the workspace root to avoid escape/injection.
export const listFilesTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  definition: {
    type: "function",
    function: {
      name: "list_files_tool",
      description:
        "List the files and directories at a given path inside the workspace " +
        "or an activated read-only skill resource root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path relative to the workspace root, or an activated skill " +
              "resource URI like skill://name/path. Defaults to the workspace root.",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    const isSkillPath = isSkillResourceUri(path)
    if (!ctx.workspace && !isSkillPath) {
      return toolError("no_workspace", "Listing files requires a workspace.")
    }
    const env = ctx.env ?? new LocalEnvironment(ctx.workspace)
    let target
    try {
      target = isSkillPath
        ? await resolveSkillResourcePath(ctx, path)
        : await env.resolve(path)
    } catch (error) {
      return toolError("not_allowed", (error as Error).message)
    }

    let result: ListDirResult
    try {
      result = isSkillPath
        ? {
            entries: await new LocalEnvironment(target).readdir(target),
            truncated: false,
          }
        : env.listDir
          ? await env.listDir(target, {
              maxEntries: MAX_LIST_ENTRIES + 1,
              maxBytes: MAX_LIST_BYTES + 1,
            })
          : { entries: await env.readdir(target), truncated: false }
    } catch (error) {
      return toolError(
        "list_failed",
        `Could not list ${path || "."}: ${(error as Error).message}`
      )
    }

    const rendered = renderEntries(result.entries)
    const listing = rendered.lines.join("\n")
    const truncated =
      result.truncated ||
      rendered.truncated ||
      result.entries.length > rendered.lines.length
    if (!truncated) return listing

    return `${listing}${listing ? "\n" : ""}${renderMetadata({
      truncated: true,
      capReason: rendered.capReason ?? result.capReason ?? "entryCount",
      entriesShown: rendered.lines.length,
      maxEntries: MAX_LIST_ENTRIES,
      maxBytes: MAX_LIST_BYTES,
      hint: "Narrow the path or use search/read_file_tool for specific files; this is not a complete directory listing.",
    })}`
  },
}

function renderEntries(entries: DirEntry[]): {
  lines: string[]
  truncated: boolean
  capReason?: "entryCount" | "nameBytes"
} {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
  const lines: string[] = []
  let bytes = 0
  for (const entry of sorted) {
    if (lines.length >= MAX_LIST_ENTRIES) {
      return { lines, truncated: true, capReason: "entryCount" }
    }
    const escapedName = JSON.stringify(entry.name)
    const line = entry.isDirectory() ? `${escapedName}/` : escapedName
    const lineBytes = Buffer.byteLength(line, "utf8")
    const separatorBytes = lines.length > 0 ? 1 : 0
    if (
      lines.length > 0 &&
      bytes + separatorBytes + lineBytes > MAX_LIST_BYTES
    ) {
      return { lines, truncated: true, capReason: "nameBytes" }
    }
    if (lines.length === 0 && lineBytes > MAX_LIST_BYTES) {
      return { lines, truncated: true, capReason: "nameBytes" }
    }
    lines.push(line)
    bytes += separatorBytes + lineBytes
  }
  return { lines, truncated: false }
}
