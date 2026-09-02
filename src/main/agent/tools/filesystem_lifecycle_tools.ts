import { LocalEnvironment } from "../env/local"
import type { Environment, StatInfo } from "../env/types"
import type { Tool, ToolContext } from "./types"
import { TOOL_EFFECTS } from "./types"
import type { ToolAction } from "../approval/types"
import { fileRevision, isNotFoundError } from "./file/mutation"
import { renderMetadata, toolError } from "./output"
import { isSkillResourceUri, resolveSkillResourcePath } from "./skill_resources"

type PathKind = "file" | "directory" | "other"

function envFor(ctx: ToolContext): Environment {
  return ctx.env ?? new LocalEnvironment(ctx.workspace)
}

function kindOf(info: StatInfo): PathKind {
  if (info.isFile()) return "file"
  if (info.isDirectory()) return "directory"
  return "other"
}

async function revisionFor(
  env: Environment,
  target: string,
  info: StatInfo
): Promise<string | undefined> {
  if (!info.isFile()) return undefined
  try {
    return fileRevision(await env.readFile(target))
  } catch {
    return undefined
  }
}

async function safeStat(
  env: Environment,
  target: string
): Promise<StatInfo | null> {
  try {
    return await env.stat(target)
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}

async function gateMutation(
  ctx: ToolContext,
  action: ToolAction
): Promise<"approved" | string> {
  if (!ctx.gate) return "approved"
  const outcome = await ctx.gate(action)
  if (outcome === "blocked") {
    return toolError("blocked", `${action.summary} is blocked by policy.`)
  }
  if (outcome === "denied") {
    return toolError("denied", `The user denied approval to ${action.summary}.`)
  }
  return "approved"
}

async function rootGuard(
  env: Environment,
  target: string,
  verb: string
): Promise<string | null> {
  if (target !== env.resolveLexical("") && target !== (await env.resolve(""))) {
    return null
  }
  return toolError("protected_path", `Refusing to ${verb} the workspace root.`)
}

function metadataFor(
  info: StatInfo,
  kind: PathKind,
  revision?: string
): Record<string, unknown> {
  return {
    kind,
    size: info.size,
    mode: info.mode,
    mtimeMs: info.mtimeMs,
    revision,
  }
}

export const statPathTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  executionPolicy: { timeoutMs: 30000 },
  definition: {
    type: "function",
    function: {
      name: "stat_path",
      description:
        "Inspect workspace-confined path metadata without following a final symlink.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to inspect, relative to the workspace root.",
          },
        },
        required: ["path"],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    if (!path) return toolError("bad_args", "A `path` is required.")
    const env = envFor(ctx)
    let target
    try {
      target = isSkillResourceUri(path)
        ? await resolveSkillResourcePath(ctx, path)
        : env.resolveLexical(path)
      const statEnv = isSkillResourceUri(path)
        ? new LocalEnvironment(target)
        : env
      const info = await statEnv.stat(target)
      const kind = kindOf(info)
      const revision = await revisionFor(statEnv, target, info)
      return `Path ${path} is a ${kind}.${renderMetadata(
        metadataFor(info, kind, revision)
      )}`
    } catch (error) {
      if (isNotFoundError(error))
        return toolError("not_found", `No such path: ${path}`)
      return toolError("not_allowed", (error as Error).message)
    }
  },
}

export const createDirectoryTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "create_directory",
      description:
        "Create a workspace directory. Set parents=true to create missing parents.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path relative to the workspace root.",
          },
          parents: {
            type: "boolean",
            description:
              "Create missing parent directories. Defaults to false.",
          },
        },
        required: ["path"],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    if (!path) return toolError("bad_args", "A `path` is required.")
    if (isSkillResourceUri(path)) {
      return toolError(
        "not_allowed",
        "Skill resources are read-only and cannot be created."
      )
    }
    const parents = args.parents === true
    const env = envFor(ctx)
    let target
    try {
      target = parents ? env.resolveLexical(path) : await env.resolve(path)
    } catch (error) {
      return toolError("not_allowed", (error as Error).message)
    }
    const protectedRoot = await rootGuard(env, target, "create")
    if (protectedRoot) return protectedRoot
    const gate = await gateMutation(ctx, {
      tool: "create_directory",
      kind: "file_mkdir",
      summary: `create directory ${path}`,
      identity: `file_mkdir:${path}:${parents ? "parents" : "single"}`,
      detail: { path, parents },
    })
    if (gate !== "approved") return gate

    try {
      const before = await safeStat(env, target)
      if (before) {
        return before.isDirectory()
          ? `Directory already exists: ${path}.${renderMetadata({
              status: "already_exists",
              path,
              kind: "directory",
            })}`
          : toolError(
              "already_exists",
              `${path} already exists and is not a directory.`
            )
      }
      if (parents) await env.mkdirp(target)
      else if (env.mkdir) await env.mkdir(target)
      else await env.mkdirp(target)
      const after = await env.stat(target)
      return `Created directory ${path}.${renderMetadata({
        status: "created",
        path,
        after: metadataFor(after, kindOf(after)),
      })}`
    } catch (error) {
      if (isNotFoundError(error))
        return toolError("not_found", `Missing parent for ${path}.`)
      return toolError("mkdir_failed", (error as Error).message)
    }
  },
}

export const movePathTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "move_path",
      description:
        "Move or rename a workspace path. Does not replace destinations unless overwrite=true.",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Source path relative to the workspace root.",
          },
          to: {
            type: "string",
            description: "Destination path relative to the workspace root.",
          },
          overwrite: {
            type: "boolean",
            description: "Replace an existing destination. Defaults to false.",
          },
        },
        required: ["from", "to"],
      },
    },
  },
  execute: async (args, ctx) => {
    const from = typeof args.from === "string" ? args.from : ""
    const to = typeof args.to === "string" ? args.to : ""
    if (!from || !to)
      return toolError("bad_args", "`from` and `to` are required.")
    if (isSkillResourceUri(from) || isSkillResourceUri(to)) {
      return toolError(
        "not_allowed",
        "Skill resources are read-only and cannot be moved or renamed."
      )
    }
    const overwrite = args.overwrite === true
    const env = envFor(ctx)
    let source
    let target
    try {
      source = env.resolveLexical(from)
      target = env.resolveLexical(to)
    } catch (error) {
      return toolError("not_allowed", (error as Error).message)
    }
    const protectedRoot = await rootGuard(env, source, "move")
    if (protectedRoot) return protectedRoot

    let before
    let existingTarget
    try {
      before = await safeStat(env, source)
      existingTarget = await safeStat(env, target)
    } catch (error) {
      return toolError("not_allowed", (error as Error).message)
    }
    if (!before) return toolError("not_found", `No such source path: ${from}`)
    if (existingTarget && !overwrite) {
      return toolError(
        "already_exists",
        `${to} already exists.`,
        "set overwrite=true only if replacing it is intended"
      )
    }
    const gate = await gateMutation(ctx, {
      tool: "move_path",
      kind: "file_move",
      summary: `${overwrite ? "overwrite-move" : "move"} ${from} to ${to}`,
      identity: `file_move:${from}->${to}:${overwrite ? "overwrite" : "no-replace"}`,
      detail: {
        from,
        to,
        overwrite,
        before: metadataFor(
          before,
          kindOf(before),
          await revisionFor(env, source, before)
        ),
        replacing: existingTarget
          ? metadataFor(existingTarget, kindOf(existingTarget))
          : undefined,
      },
    })
    if (gate !== "approved") return gate
    try {
      if (overwrite) await env.rename(source, target)
      else if (env.renameNoReplace) await env.renameNoReplace(source, target)
      else await env.rename(source, target)
      const after = await env.stat(target)
      return `Moved ${from} to ${to}.${renderMetadata({
        status: "moved",
        from,
        to,
        overwrite,
        before: metadataFor(before, kindOf(before)),
        after: metadataFor(
          after,
          kindOf(after),
          await revisionFor(env, target, after)
        ),
      })}`
    } catch (error) {
      return toolError("move_failed", (error as Error).message)
    }
  },
}

export const deletePathTool: Tool = {
  effects: TOOL_EFFECTS.destructiveMutation,
  definition: {
    type: "function",
    function: {
      name: "delete_path",
      description:
        "Delete one workspace file or directory. Directories are non-recursive unless recursive=true.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to delete, relative to the workspace root.",
          },
          recursive: {
            type: "boolean",
            description:
              "Delete a directory tree recursively. Defaults to false and requires approval when true.",
          },
        },
        required: ["path"],
      },
    },
  },
  execute: async (args, ctx) => {
    const path = typeof args.path === "string" ? args.path : ""
    if (!path) return toolError("bad_args", "A `path` is required.")
    if (isSkillResourceUri(path)) {
      return toolError(
        "not_allowed",
        "Skill resources are read-only and cannot be deleted."
      )
    }
    const recursive = args.recursive === true
    const env = envFor(ctx)
    let target
    try {
      target = env.resolveLexical(path)
    } catch (error) {
      if (isNotFoundError(error))
        return toolError("not_found", `No such path: ${path}`)
      return toolError("not_allowed", (error as Error).message)
    }
    const protectedRoot = await rootGuard(env, target, "delete")
    if (protectedRoot) return protectedRoot
    let before
    try {
      before = await safeStat(env, target)
    } catch (error) {
      return toolError("not_allowed", (error as Error).message)
    }
    if (!before) return toolError("not_found", `No such path: ${path}`)
    const beforeKind = kindOf(before)
    const gate = await gateMutation(ctx, {
      tool: "delete_path",
      kind: "file_delete",
      summary: `${recursive ? "recursively delete" : "delete"} ${path}`,
      identity: `file_delete:${path}:${recursive ? "recursive" : "single"}`,
      detail: {
        path,
        recursive,
        before: metadataFor(
          before,
          beforeKind,
          await revisionFor(env, target, before)
        ),
      },
    })
    if (gate !== "approved") return gate

    try {
      if (before.isDirectory()) {
        if (!env.removeDirectory) {
          return toolError(
            "unsupported",
            "The current environment cannot delete directories."
          )
        }
        await env.removeDirectory(target, { recursive })
      } else if (before.isFile()) {
        if (recursive)
          return toolError(
            "bad_args",
            "`recursive` is only valid for directories."
          )
        await env.removeFile(target)
      } else {
        return toolError(
          "unsupported_type",
          `Refusing to delete non-file/non-directory path: ${path}`
        )
      }
      return `Deleted ${path}.${renderMetadata({
        status: "deleted",
        path,
        recursive,
        before: metadataFor(before, beforeKind),
      })}`
    } catch (error) {
      return toolError("delete_failed", (error as Error).message)
    }
  },
}
