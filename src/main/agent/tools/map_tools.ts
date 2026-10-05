import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { toolError } from "./output"
import { getMapTools, type MapResult } from "../../mission-control/map-tools"

// Mission Control map tools (plan 106.6). Offered only to pod-lead seat turns
// (never to an answer-only wake). The seat comes from ToolContext; decision
// rights, the active milestone, and budgets are enforced server-side in
// map-tools.ts, so arguments can name work but never grant authority. They
// write only Mission Control's own tables (and start playbooks the rights
// allow), so they need no approval, like Comms.

function service(ctx: ToolContext) {
  const tools = getMapTools()
  return tools && ctx.missionControlSeat
    ? { tools, turn: ctx.missionControlSeat }
    : null
}

function unavailable(): string {
  return toolError(
    "unavailable",
    "Map tools are only available to Mission Control lead seats."
  )
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function result(outcome: MapResult): string {
  if (!outcome.ok) return toolError(outcome.code, outcome.message)
  return outcome.data
    ? JSON.stringify({ ...outcome.data, message: outcome.message })
    : outcome.message
}

const USER_STORY_SCHEMA = {
  type: "object",
  properties: {
    key: {
      type: "string",
      description: "Short kebab-case key, e.g. invoice-api.",
    },
    title: { type: "string" },
    story: {
      type: "object",
      description:
        "Who benefits and why: As a <as_a>, I want <i_want>, so that <so_that>. " +
        "Omit it for purely technical work (a migration, a refactor).",
      properties: {
        as_a: {
          type: "string",
          description: "The user or role, e.g. billing admin.",
        },
        i_want: { type: "string", description: "What they want to do." },
        so_that: { type: "string", description: "The benefit to them." },
      },
    },
    goal: {
      type: "string",
      description:
        "What the user story achieves, as the engineering objective.",
    },
    acceptance: {
      type: "array",
      items: { type: "string" },
      description:
        "Checkable acceptance criteria; the proof verifies each one. Write behavior as " +
        "Given <context>, when <action>, then <outcome>; other checks (e.g. tests pass) plainly.",
    },
    out_of_scope: { type: "array", items: { type: "string" } },
    touch_hints: {
      type: "array",
      items: { type: "string" },
      description:
        "Paths or globs the user story will change; overlapping user stories don't run in parallel.",
    },
    notes: { type: "string" },
    pod: {
      type: "string",
      description: "Pod key to build it in (default: the feature's pod).",
    },
    depends_on: {
      type: "array",
      items: { type: "string" },
      description:
        "Keys of user stories in the same milestone that must merge first.",
    },
    blocks: {
      type: "array",
      items: { type: "string" },
      description:
        "When adding to an existing plan: keys of not-started user stories that must wait for this one. " +
        "Without it, stories already planned in later waves don't wait for a new story.",
    },
    runs_last: {
      type: "boolean",
      description:
        "Run after every other user story in the milestone, including ones added later: for an " +
        "integration or regression proof, or docs. Nothing may depend on it.",
    },
  },
  required: ["title", "acceptance"],
}

export const mapStatusTool: Tool = {
  effects: TOOL_EFFECTS.readOnlyParallel,
  definition: {
    type: "function",
    function: {
      name: "map_status",
      description:
        "Where the feature is on its map: the active milestone, its waves and critical path, " +
        "ready/running/merging/blocked user stories, free capacity, budgets, the next maneuver, and " +
        "the decisions waiting on you or the user.",
      parameters: { type: "object", properties: {} },
    },
  },
  execute: async (_args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    return result(await s.tools.status(s.turn))
  },
}

export const assignUserStoryTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "assign_user_story",
      description:
        "Start a ready user story in the active milestone (requires the assign_user_story right), optionally " +
        "choosing its pod first. For a user story that hasn't started, `pod` alone reassigns it.",
      parameters: {
        type: "object",
        properties: {
          user_story: { type: "string", description: "The user story key." },
          pod: { type: "string", description: "Pod key to run it in." },
        },
        required: ["user_story"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    const userStory = text(args.user_story)
    if (!userStory)
      return toolError("bad_args", "assign_user_story needs `user_story`.")
    return result(
      await s.tools.assignUserStory(s.turn, { userStory, pod: text(args.pod) })
    )
  },
}

export const retryUserStoryTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "retry_user_story",
      description:
        "Start a new attempt of a failed user story with a note for its workers on what to do " +
        "differently (requires assign_user_story; counts against the attempt budget).",
      parameters: {
        type: "object",
        properties: {
          user_story: { type: "string" },
          note: {
            type: "string",
            description: "What went wrong and what to do differently.",
          },
        },
        required: ["user_story", "note"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    const userStory = text(args.user_story)
    const note = text(args.note)
    if (!userStory || !note)
      return toolError(
        "bad_args",
        "retry_user_story needs `user_story` and `note`."
      )
    return result(await s.tools.retryUserStory(s.turn, { userStory, note }))
  },
}

export const cancelUserStoryTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "cancel_user_story",
      description:
        "Cancel a user story in the active milestone (requires revise_plan). A running attempt is " +
        "stopped; user stories that depend on it become blocked until you replan.",
      parameters: {
        type: "object",
        properties: {
          user_story: { type: "string" },
          reason: {
            type: "string",
            description: "Why; recorded in the revision log.",
          },
        },
        required: ["user_story", "reason"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    const userStory = text(args.user_story)
    const reason = text(args.reason)
    if (!userStory || !reason)
      return toolError(
        "bad_args",
        "cancel_user_story needs `user_story` and `reason`."
      )
    return result(s.tools.cancelUserStory(s.turn, { userStory, reason }))
  },
}

export const revisePlanTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "revise_plan",
      description:
        "Apply bounded structural edits to the ACTIVE milestone (requires revise_plan; counts " +
        "against the plan-revision budget). All changes apply together or not at all. Ops: " +
        "add_user_story {user_story}, split_user_story {user_story, into:[user_story,…]}, add_dependency {from, to}, " +
        "remove_dependency {from, to}, reorder {order:[keys]}, edit_user_story {user_story, patch} (not-" +
        "started user stories only). Anything else — editing the feature's intent or definition of " +
        "done, a milestone's outcome, other milestones, budgets, or the rig — and any change without " +
        "the right or budget becomes a proposal for the user instead.",
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                op: {
                  type: "string",
                  enum: [
                    "add_user_story",
                    "split_user_story",
                    "add_dependency",
                    "remove_dependency",
                    "reorder",
                    "edit_user_story",
                    "edit_milestone",
                    "edit_feature",
                    "add_milestone",
                  ],
                },
                user_story: {
                  description:
                    "A user story key (split/edit) or a new user story object (add_user_story).",
                },
                into: { type: "array", items: USER_STORY_SCHEMA },
                from: { type: "string" },
                to: { type: "string" },
                order: { type: "array", items: { type: "string" } },
                patch: { type: "object" },
                milestone: {
                  description:
                    "Milestone key (edit_milestone) or new milestone (add_milestone).",
                },
              },
              required: ["op"],
            },
          },
          reason: {
            type: "string",
            description: "Why; recorded with every change.",
          },
        },
        required: ["changes", "reason"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    return result(
      s.tools.revisePlan(s.turn, {
        changes: args.changes,
        reason: text(args.reason) ?? "",
      })
    )
  },
}

export const proposeUserStoryTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "propose_user_story",
      description:
        "Propose a new user story for the user to review (no right needed). Use it for work you " +
        "can't add yourself, or that belongs to another milestone.",
      parameters: {
        type: "object",
        properties: {
          milestone: {
            type: "string",
            description: "Milestone key (default: the active milestone).",
          },
          user_story: USER_STORY_SCHEMA,
          reason: {
            type: "string",
            description: "Why this user story is needed.",
          },
        },
        required: ["user_story", "reason"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    return result(
      s.tools.proposeUserStory(s.turn, {
        milestone: text(args.milestone),
        userStory: args.user_story,
        reason: text(args.reason) ?? "",
      })
    )
  },
}

export const proposePlanTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "propose_plan",
      description:
        "Submit the feature's plan — its milestones in order, each with user stories — as ONE " +
        "proposal the user reviews and applies. Use during feature planning.",
      parameters: {
        type: "object",
        properties: {
          milestones: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                name: { type: "string" },
                outcome: { type: "string" },
                definition_of_done: { type: "string" },
                user_stories: { type: "array", items: USER_STORY_SCHEMA },
              },
              required: ["name", "outcome", "user_stories"],
            },
          },
          reason: {
            type: "string",
            description: "A short summary of the plan's shape.",
          },
        },
        required: ["milestones"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    return result(
      s.tools.proposePlan(s.turn, {
        milestones: args.milestones,
        reason: text(args.reason) ?? undefined,
      })
    )
  },
}

export const completeMilestoneTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "complete_milestone",
      description:
        "Judge that the active milestone meets its definition of done, once every user story has " +
        "merged (requires accept_proof). A milestone with an integration branch then waits for " +
        "the user to land it; one without is completed.",
      parameters: {
        type: "object",
        properties: {
          milestone: {
            type: "string",
            description: "The active milestone's key.",
          },
          summary: {
            type: "string",
            description:
              "How the merged user stories meet the milestone's definition of done.",
          },
        },
        required: ["milestone", "summary"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    const milestone = text(args.milestone)
    const summary = text(args.summary)
    if (!milestone || !summary)
      return toolError(
        "bad_args",
        "complete_milestone needs `milestone` and `summary`."
      )
    return result(
      await s.tools.completeMilestone(s.turn, { milestone, summary })
    )
  },
}

export const mapTools: Tool[] = [
  mapStatusTool,
  assignUserStoryTool,
  retryUserStoryTool,
  cancelUserStoryTool,
  revisePlanTool,
  proposeUserStoryTool,
  proposePlanTool,
  completeMilestoneTool,
]
export const MAP_TOOL_NAMES = new Set(
  mapTools.map((tool) => tool.definition.function.name)
)
