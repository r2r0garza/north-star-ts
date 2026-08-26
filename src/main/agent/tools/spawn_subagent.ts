import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { toolError } from "./output"
import { MAX_AGENT_DEPTH } from "../agents/types"

// Delegate a self-contained task to a permitted child agent and return the
// child's final answer. Unlike run_todos_in_background (which hands work to the
// durable runner and requires human approval), spawning is SYNCHRONOUS and
// AUTO-ALLOWED: the running agent's author already whitelisted the child in its
// `children` frontmatter, so there's no per-run decision to gate — the whitelist
// IS the policy. The tool never calls ctx.gate. Any side-effecting tools the
// child itself runs still hit the child loop's own approval gate normally.
export const spawnSubagentTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
  definition: {
    type: "function",
    function: {
      name: "spawn_subagent",
      description:
        "Delegate a self-contained task to a specialized child agent and get its " +
        "final answer back. The child runs with its own system prompt, tools, and " +
        "skills, and CANNOT see this conversation — so give it a complete, " +
        "self-contained prompt with all the context it needs. Use this when a task " +
        "matches one of the child agents listed in your Subagents section. Blocks " +
        "until the child finishes, then returns its answer as the tool result.",
      parameters: {
        type: "object",
        properties: {
          agent_name: {
            type: "string",
            description:
              "The child agent to spawn. Must be one of the agents listed in your " +
              "Subagents section.",
          },
          prompt: {
            type: "string",
            description:
              "The complete, self-contained task for the child, including all " +
              "context it needs (it cannot see this conversation).",
          },
        },
        required: ["agent_name", "prompt"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
    if (!ctx.spawnSubagent) {
      return toolError(
        "unavailable",
        "Spawning subagents isn't available in this context."
      )
    }
    const name = String(args.agent_name ?? "").trim()
    const prompt = String(args.prompt ?? "").trim()
    if (!name) return toolError("bad_args", "agent_name is required.")
    if (!prompt) return toolError("bad_args", "prompt is required.")

    // Depth guard: bound the subagent tree regardless of the children graph.
    if ((ctx.agentDepth ?? 0) >= MAX_AGENT_DEPTH) {
      return toolError(
        "depth_exceeded",
        `Maximum subagent depth (${MAX_AGENT_DEPTH}) reached; cannot spawn deeper. Do this work yourself.`
      )
    }

    // Cycle guard: refuse to re-enter an agent already in this run's ancestor
    // chain (catches A→B→A precisely; a sibling reusing the same agent is fine).
    if (ctx.agentAncestors?.includes(name)) {
      return toolError(
        "cycle_detected",
        `Agent '${name}' is already an ancestor of this one; refusing to spawn it to avoid a loop.`
      )
    }

    // Authorization: the running agent's `children` tri-state. This is the whole
    // gate — no approval prompt. `undefined` means the tool shouldn't have been
    // offered at all (fail closed); [] means any loadable agent; a list means the
    // name must be in it.
    const allowed = ctx.agentChildren
    if (allowed === undefined) {
      return toolError(
        "no_children",
        "This agent is not permitted to spawn subagents."
      )
    }
    if (allowed.length > 0 && !allowed.includes(name)) {
      return toolError(
        "not_allowed",
        `Agent '${name}' is not in this agent's allowed children. Allowed: ${allowed.join(", ")}.`
      )
    }

    // Blocking spawn. The helper resolves the child definition, forks a worker
    // conversation stamped with the child agent, runs a nested loop to completion,
    // and returns its final text.
    const r = await ctx.spawnSubagent({ agentName: name, prompt })
    if (r.error) return toolError("child_failed", r.error)
    if (r.stopped)
      return toolError("child_stopped", "The subagent run was stopped.")
    return r.content && r.content.trim().length > 0
      ? r.content
      : "(the subagent produced no output)"
  },
}
