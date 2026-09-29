import { TOOL_EFFECTS, type Tool } from "./types"
import { toolError } from "./output"
import { proposeFollowup } from "../../mission-control/followups"

// propose_followup (plan 106.7): any Mission Control seat records an idea that
// is outside its current work instead of building it. The anchor (the user
// story or milestone being worked on) and the proposer come from the seat
// turn, never from the model. It only writes the app's proposal table, so it
// is auto-allowed, and it never changes the plan: the user applies it later,
// into a later milestone by default.
export const proposeFollowupTool: Tool = {
  effects: TOOL_EFFECTS.mutation,
  definition: {
    type: "function",
    function: {
      name: "propose_followup",
      description:
        "Record a good idea that is NOT needed for your current acceptance criteria, instead of " +
        "building it. It goes to the user and your lead as a follow-up for later work; your " +
        "current scope is unchanged. After calling it, continue the current work.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              'A short name for the idea, e.g. "Add a light to the doghouse".',
          },
          rationale: {
            type: "string",
            description:
              "Why it's worth doing later, and what you noticed that suggests it.",
          },
          suggested_altitude: {
            type: "string",
            enum: ["user_story", "milestone", "feature"],
            description:
              "How big it is: a single user story, a milestone's worth of work, or a change to the feature itself.",
          },
        },
        required: ["title", "rationale"],
      },
    },
  },
  execute: async (args, ctx) => {
    if (!ctx.missionControlSeat)
      return toolError(
        "unavailable",
        "propose_followup is only available to Mission Control seats."
      )
    const result = proposeFollowup(ctx.missionControlSeat, args)
    if (!result.ok) return toolError(result.code, result.message)
    return JSON.stringify({
      status: "recorded",
      followup_id: result.proposal.id,
      message: result.message,
    })
  },
}
