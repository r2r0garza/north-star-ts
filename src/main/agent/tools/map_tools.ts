import { TOOL_EFFECTS, type Tool, type ToolContext } from "./types"
import { toolError } from "./output"
import { getMapTools, type MapResult } from "../../mission-control/map-tools"

// Mission Control map tools (plan 106.6). Offered only to pod-lead seat turns
// (never to an answer-only wake). The seat comes from ToolContext; decision
// rights, the active mission, and budgets are enforced server-side in
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
  return toolError("unavailable", "Map tools are only available to Mission Control lead seats.")
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

const SLICE_SCHEMA = {
  type: "object",
  properties: {
    key: { type: "string", description: "Short kebab-case key, e.g. invoice-api." },
    title: { type: "string" },
    goal: { type: "string", description: "What the slice achieves." },
    acceptance: {
      type: "array",
      items: { type: "string" },
      description: "Checkable acceptance criteria; the proof verifies each one.",
    },
    out_of_scope: { type: "array", items: { type: "string" } },
    touch_hints: {
      type: "array",
      items: { type: "string" },
      description: "Paths or globs the slice will change; overlapping slices don't run in parallel.",
    },
    notes: { type: "string" },
    pod: { type: "string", description: "Pod key to build it in (default: the initiative's pod)." },
    depends_on: {
      type: "array",
      items: { type: "string" },
      description: "Keys of slices in the same mission that must merge first.",
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
        "Where the initiative is on its map: the active mission, its waves and critical path, " +
        "ready/running/merging/blocked slices, free capacity, budgets, the next maneuver, and " +
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

export const assignSliceTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "assign_slice",
      description:
        "Start a ready slice in the active mission (requires the assign_slice right), optionally " +
        "choosing its pod first. For a slice that hasn't started, `pod` alone reassigns it.",
      parameters: {
        type: "object",
        properties: {
          slice: { type: "string", description: "The slice key." },
          pod: { type: "string", description: "Pod key to run it in." },
        },
        required: ["slice"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    const slice = text(args.slice)
    if (!slice) return toolError("bad_args", "assign_slice needs `slice`.")
    return result(await s.tools.assignSlice(s.turn, { slice, pod: text(args.pod) }))
  },
}

export const retrySliceTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "retry_slice",
      description:
        "Start a new attempt of a failed slice with a note for its workers on what to do " +
        "differently (requires assign_slice; counts against the attempt budget).",
      parameters: {
        type: "object",
        properties: {
          slice: { type: "string" },
          note: { type: "string", description: "What went wrong and what to do differently." },
        },
        required: ["slice", "note"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    const slice = text(args.slice)
    const note = text(args.note)
    if (!slice || !note) return toolError("bad_args", "retry_slice needs `slice` and `note`.")
    return result(await s.tools.retrySlice(s.turn, { slice, note }))
  },
}

export const cancelSliceTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "cancel_slice",
      description:
        "Cancel a slice in the active mission (requires revise_plan). A running attempt is " +
        "stopped; slices that depend on it become blocked until you replan.",
      parameters: {
        type: "object",
        properties: {
          slice: { type: "string" },
          reason: { type: "string", description: "Why; recorded in the revision log." },
        },
        required: ["slice", "reason"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    const slice = text(args.slice)
    const reason = text(args.reason)
    if (!slice || !reason) return toolError("bad_args", "cancel_slice needs `slice` and `reason`.")
    return result(s.tools.cancelSlice(s.turn, { slice, reason }))
  },
}

export const revisePlanTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "revise_plan",
      description:
        "Apply bounded structural edits to the ACTIVE mission (requires revise_plan; counts " +
        "against the plan-revision budget). All changes apply together or not at all. Ops: " +
        "add_slice {slice}, split_slice {slice, into:[slice,…]}, add_dependency {from, to}, " +
        "remove_dependency {from, to}, reorder {order:[keys]}, edit_slice {slice, patch} (not-" +
        "started slices only). Anything else — editing the initiative's intent or definition of " +
        "done, a mission's outcome, other missions, budgets, or the rig — and any change without " +
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
                    "add_slice",
                    "split_slice",
                    "add_dependency",
                    "remove_dependency",
                    "reorder",
                    "edit_slice",
                    "edit_mission",
                    "edit_initiative",
                    "add_mission",
                  ],
                },
                slice: {
                  description: "A slice key (split/edit) or a new slice object (add_slice).",
                },
                into: { type: "array", items: SLICE_SCHEMA },
                from: { type: "string" },
                to: { type: "string" },
                order: { type: "array", items: { type: "string" } },
                patch: { type: "object" },
                mission: { description: "Mission key (edit_mission) or new mission (add_mission)." },
              },
              required: ["op"],
            },
          },
          reason: { type: "string", description: "Why; recorded with every change." },
        },
        required: ["changes", "reason"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    return result(
      s.tools.revisePlan(s.turn, { changes: args.changes, reason: text(args.reason) ?? "" })
    )
  },
}

export const proposeSliceTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "propose_slice",
      description:
        "Propose a new slice for the user to review (no right needed). Use it for work you " +
        "can't add yourself, or that belongs to another mission.",
      parameters: {
        type: "object",
        properties: {
          mission: { type: "string", description: "Mission key (default: the active mission)." },
          slice: SLICE_SCHEMA,
          reason: { type: "string", description: "Why this slice is needed." },
        },
        required: ["slice", "reason"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    return result(
      s.tools.proposeSlice(s.turn, {
        mission: text(args.mission),
        slice: args.slice,
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
        "Submit the initiative's plan — its missions in order, each with slices — as ONE " +
        "proposal the user reviews and applies. Use during initiative planning.",
      parameters: {
        type: "object",
        properties: {
          missions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                name: { type: "string" },
                outcome: { type: "string" },
                definition_of_done: { type: "string" },
                slices: { type: "array", items: SLICE_SCHEMA },
              },
              required: ["name", "outcome", "slices"],
            },
          },
          reason: { type: "string", description: "A short summary of the plan's shape." },
        },
        required: ["missions"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    return result(
      s.tools.proposePlan(s.turn, { missions: args.missions, reason: text(args.reason) ?? undefined })
    )
  },
}

export const completeMissionTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "complete_mission",
      description:
        "Judge that the active mission meets its definition of done, once every slice has " +
        "merged (requires accept_proof). A mission with an integration branch then waits for " +
        "the user to land it; one without is completed.",
      parameters: {
        type: "object",
        properties: {
          mission: { type: "string", description: "The active mission's key." },
          summary: {
            type: "string",
            description: "How the merged slices meet the mission's definition of done.",
          },
        },
        required: ["mission", "summary"],
      },
    },
  },
  execute: async (args, ctx) => {
    const s = service(ctx)
    if (!s) return unavailable()
    const mission = text(args.mission)
    const summary = text(args.summary)
    if (!mission || !summary)
      return toolError("bad_args", "complete_mission needs `mission` and `summary`.")
    return result(await s.tools.completeMission(s.turn, { mission, summary }))
  },
}

export const mapTools: Tool[] = [
  mapStatusTool,
  assignSliceTool,
  retrySliceTool,
  cancelSliceTool,
  revisePlanTool,
  proposeSliceTool,
  proposePlanTool,
  completeMissionTool,
]
export const MAP_TOOL_NAMES = new Set(mapTools.map((tool) => tool.definition.function.name))
