import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"

// Board card runs in a folder of repos (plan 136.6): the card starts with an
// empty folder and the agent opens each repo when its work reaches it. The
// board does the work (ctx.kanbanOpenRepo); it is only offered on those runs.
export const kanbanOpenRepoTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "kanban_open_repo",
      description:
        "Bring one of the workspace's repos into this card's folder as a git worktree on the card's " +
        "branch, so you can change it. Call it when your work reaches that repo, not before; open " +
        "only repos you will change. Returns the repo's path in your working folder. Opening a repo " +
        "that is already open returns its path again.",
      parameters: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description:
              "The repo's path relative to the workspace, exactly as listed (e.g. backend or apps/web).",
          },
          base: {
            type: "string",
            description:
              "Branch to start from, e.g. develop. Omit to use the repo's default branch on origin.",
          },
        },
        required: ["repo"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.kanbanOpenRepo)
      return toolError(
        "unavailable",
        "Opening repos is only available while working a board card in a folder of repos."
      )
    const a = args as { repo?: unknown; base?: unknown }
    const repo = typeof a.repo === "string" ? a.repo.trim() : ""
    if (!repo) return toolError("bad_args", "`repo` is required.")
    const base =
      typeof a.base === "string" && a.base.trim() ? a.base.trim() : undefined
    try {
      const opened = await ctx.kanbanOpenRepo(repo, base)
      return JSON.stringify({
        path: opened.path,
        branch: opened.branch,
        base: opened.base,
        note: "Work and commit inside this path.",
        ...(opened.links?.length
          ? {
              linkDependencies: opened.links,
              linkNote:
                "Run these before building or testing here: they link the real checkout's installed dependencies, which a worktree lacks. Never install, update or remove packages through the links.",
            }
          : {}),
      })
    } catch (err) {
      return toolError("open_failed", (err as Error).message)
    }
  },
}
