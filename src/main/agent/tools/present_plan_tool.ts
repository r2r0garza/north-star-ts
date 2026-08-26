import { readFile } from "fs/promises"
import { TOOL_EFFECTS, type Tool, type Question } from "./types"
import { toolError } from "./output"
import { planFilePath } from "./plan-file"

const APPROVE_LABEL = "Yes, approve"
const APPROVE_AUTO_LABEL = "Yes, approve and work in Auto mode"

// Plan-mode's handoff: present the finished plan to the user for approval. Reads
// back the saved plan file and asks a single question via ctx.ask —
// "Yes, approve" / "Yes, approve and work in Auto mode", plus a "Refine Plan…"
// free-form field for change requests. On approval it flips plan mode OFF for
// the current turn (via ctx.setPlanMode), so the same turn can proceed to
// implement with the full filesystem toolset restored. "Approve and Auto" also
// activates auto mode (via ctx.setAutoMode) so all subsequent gate decisions are
// automatically approved. Free-form feedback keeps plan mode on and returns the
// user's notes so the model keeps refining. Offered only in plan mode.
export const presentPlanTool: Tool = {
  effects: TOOL_EFFECTS.openWorldMutation,
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

    // Read the saved plan so we can confirm one exists and show it to the user.
    // The plan Markdown rides along on the question's `body` (rendered in a
    // scrollable box above the approve/refine options) — the same panel is both
    // the plan and the approval gate.
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
      // The question text is intentionally empty — the plan body and the
      // panel title ("Approve or keep working on the plan") provide full
      // context. An empty string avoids rendering a redundant heading.
      question: "",
      header: "Plan",
      body: plan,
      otherLabel: "Refine Plan…",
      options: [
        {
          label: APPROVE_LABEL,
          description: "Exit plan mode and implement it.",
        },
        {
          label: APPROVE_AUTO_LABEL,
          description:
            "Exit plan mode and implement without asking for confirmations.",
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
    const approveAuto = answer?.selected.includes(APPROVE_AUTO_LABEL) === true
    const approveNormal = answer?.selected.includes(APPROVE_LABEL) === true
    const approved = approveAuto || approveNormal
    const feedback = answer?.other?.trim()

    // Free-form feedback always means "keep refining", even if a button was also
    // selected — the user took the trouble to type changes.
    if (approved && !feedback) {
      ctx.setPlanMode?.(false)
      if (approveAuto) {
        ctx.setAutoMode?.(true)
        return JSON.stringify({
          approved: true,
          autoMode: true,
          message:
            "Plan approved with Auto mode — plan mode is off and all subsequent " +
            "actions are automatically approved. Implement the approved plan now.",
        })
      }
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
      feedback:
        feedback || "(no specific feedback — ask what they'd like changed)",
    })
  },
}
