import { readFile } from "fs/promises"
import type { Tool, Question } from "./types"
import { toolError } from "./output"
import { planFilePath } from "./plan-file"

const APPROVE_LABEL = "Yes, approved"
const REFINE_LABEL = "Keep refining"

// Plan-mode's handoff: present the finished plan to the user for approval. Reads
// back the saved plan file and asks a single question via ctx.ask —
// "Yes, approved" / "Keep refining", plus the UI's automatic free-form "Other"
// field for change requests. On approval it flips plan mode OFF for the current
// turn (via ctx.setPlanMode), so the same turn can proceed to implement with the
// full filesystem toolset restored. Otherwise it returns the user's feedback so
// the model keeps refining the plan (plan mode stays on). Offered only in plan mode.
export const presentPlanTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "present_plan",
      description:
        "Present your completed plan to the user for approval. Call this only after " +
        "write_plan, once the plan is ready. The user can approve it or ask for changes. " +
        "If they approve, plan mode ends and you should implement the plan right away. " +
        "If they request changes, revise the plan (write_plan) and present it again.",
      parameters: { type: "object", properties: {} },
    },
  },
  execute: async (_args, ctx) => {
    if (!ctx.ask || !ctx.conversationId) {
      return toolError(
        "unavailable",
        "Presenting a plan isn't available in this context."
      )
    }

    // Read the saved plan so we can confirm one exists before prompting. The user
    // reviews the plan in the transcript; the question itself is the approval gate.
    let plan: string
    try {
      plan = await readFile(planFilePath(ctx.conversationId), "utf-8")
    } catch {
      return toolError(
        "no_plan",
        "No plan file found. Call write_plan to save the plan before presenting it."
      )
    }
    if (plan.trim() === "") {
      return toolError(
        "no_plan",
        "The plan file is empty. Save a plan with write_plan before presenting it."
      )
    }

    const question: Question = {
      question: "Is this plan approved?",
      header: "Plan",
      options: [
        { label: APPROVE_LABEL, description: "Exit plan mode and implement it." },
        {
          label: REFINE_LABEL,
          description: "Keep working on the plan before implementing.",
        },
      ],
    }

    const result = await ctx.ask([question])
    if (result.status === "cancelled") {
      return toolError(
        "cancelled",
        "The user dismissed the approval without deciding."
      )
    }

    const answer = result.answers[0]
    const approved = answer?.selected.includes(APPROVE_LABEL) === true
    const feedback = answer?.other?.trim()

    // Free-form feedback always means "keep refining", even if a button was also
    // selected — the user took the trouble to type changes.
    if (approved && !feedback) {
      ctx.setPlanMode?.(false)
      return JSON.stringify({
        approved: true,
        message:
          "Plan approved — plan mode is off. Implement the approved plan now.",
      })
    }

    return JSON.stringify({
      approved: false,
      message:
        "The user has not approved the plan yet. Revise it based on their feedback, " +
        "then call present_plan again.",
      feedback: feedback || "(no specific feedback — ask what they'd like changed)",
    })
  },
}
