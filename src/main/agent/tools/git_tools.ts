import { GitService } from "../../git/service"
import { LocalEnvironment } from "../env/local"
import type { Environment } from "../env/types"
import { toolError } from "./output"
import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"

function envFor(ctx: ToolContext): Environment {
  return ctx.env ?? new LocalEnvironment(ctx.workspace)
}

function service(ctx: ToolContext): GitService {
  return new GitService(ctx.workspace, envFor(ctx))
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function render(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function gitTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  execute: Tool["execute"]
): Tool {
  return {
    effects: TOOL_EFFECTS.readOnlyParallel,
    executionPolicy: { timeoutMs: 35000 },
    definition: {
      type: "function",
      function: {
        name,
        description,
        parameters: { type: "object", properties },
      },
    },
    execute,
  }
}

export const gitStatusTool = gitTool(
  "git_status",
  "Return structured read-only Git working tree status for the current workspace.",
  {},
  async (_args, ctx) => {
    try {
      return render(await service(ctx).status())
    } catch (error) {
      return toolError("git_failed", (error as Error).message)
    }
  }
)

export const gitDiffTool = gitTool(
  "git_diff",
  "Return a bounded unified Git diff. Optional path is workspace-relative; staged reads the index; base compares against a validated revision.",
  {
    path: { type: "string" },
    staged: { type: "boolean" },
    base: { type: "string" },
  },
  async (args, ctx) => {
    try {
      return render(
        await service(ctx).diff({
          path: optionalString(args.path),
          staged: args.staged === true,
          base: optionalString(args.base),
        })
      )
    } catch (error) {
      return toolError("git_failed", (error as Error).message)
    }
  }
)

export const gitLogTool = gitTool(
  "git_log",
  "Return structured recent Git commits, optionally scoped to a workspace-relative path.",
  {
    limit: { type: "integer" },
    path: { type: "string" },
  },
  async (args, ctx) => {
    try {
      return render(
        await service(ctx).log({
          limit: optionalNumber(args.limit),
          path: optionalString(args.path),
        })
      )
    } catch (error) {
      return toolError("git_failed", (error as Error).message)
    }
  }
)

export const gitShowTool = gitTool(
  "git_show",
  "Return bounded read-only Git show output for a validated revision, optionally scoped to a workspace-relative path.",
  {
    revision: { type: "string" },
    path: { type: "string" },
  },
  async (args, ctx) => {
    const revision = optionalString(args.revision)
    if (!revision) return toolError("bad_args", "A `revision` is required.")
    try {
      return render(
        await service(ctx).show(revision, optionalString(args.path))
      )
    } catch (error) {
      return toolError("git_failed", (error as Error).message)
    }
  }
)

export const gitBranchesTool = gitTool(
  "git_branches",
  "Return structured local Git branch information for the current workspace.",
  {},
  async (_args, ctx) => {
    try {
      return render(await service(ctx).branches())
    } catch (error) {
      return toolError("git_failed", (error as Error).message)
    }
  }
)
