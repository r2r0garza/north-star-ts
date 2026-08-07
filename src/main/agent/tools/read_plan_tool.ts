import { readFile } from "fs/promises"
import type { Tool } from "./types"
import { toolError, truncateForModel } from "./output"
import { planFilePath } from "./plan-file"

// Read back the conversation's own plan document (~/.<name>/plans/<id>.md). The
// counterpart to write_plan: the plan file lives OUTSIDE the workspace on purpose
// (a fixed, server-computed path), so read_file_tool — which confines every read
// to the workspace — can't reach it and rejects the path as "outside the
// workspace". This tool is the sanctioned exception: like write_plan it takes no
// path (the path is derived from the conversation, so the model can only ever
// read its OWN plan), and it reads the same file present_plan shows the user.
//
// Offered both in plan mode (so the agent can re-read what it drafted) and after
// approval (so the implementing turn can consult the approved plan) — see runChat.
export const readPlanTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "read_plan",
      description:
        "Read back this conversation's saved plan document (the one written with " +
        "write_plan). Use this to review the current or approved plan — it lives " +
        "outside the workspace, so read_file_tool cannot open it. Takes no arguments.",
      parameters: { type: "object", properties: {} },
    },
  },
  execute: async (_args, ctx) => {
    if (!ctx.conversationId) {
      return toolError(
        "unavailable",
        "Reading a plan isn't available in this context."
      )
    }
    let plan: string
    try {
      plan = await readFile(planFilePath(ctx.conversationId), "utf-8")
    } catch {
      return toolError(
        "no_plan",
        "No plan file found for this conversation. Use write_plan to save one first."
      )
    }
    if (plan.trim() === "") {
      return toolError(
        "no_plan",
        "The plan file is empty. Save a plan with write_plan before reading it."
      )
    }
    return truncateForModel(plan).text
  },
}
