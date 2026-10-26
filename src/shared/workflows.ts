import type { ReasoningEffort } from "./reasoning-effort"

export interface WorkflowStep {
  id: string
  title: string
  instructions: string
  accountId?: string | null
  modelId?: string | null
  // Null/absent: the provider's default level for the resolved model.
  effort?: ReasoningEffort | null
  agentName?: string | null
  skillName?: string | null
  validateCompletion?: boolean
  maxCorrectionLoops?: number
  validatorAccountId?: string | null
  validatorModelId?: string | null
  validatorEffort?: ReasoningEffort | null
  validatorAgentName?: string | null
  // Plan 130: per-step opt-in to the agent browser and Electron app control.
  // Absent = off, so older definitions load unchanged.
  browser?: boolean
  // Exact origins (e.g. "http://localhost:5173") the step's browser may open.
  allowedOrigins?: string[]
  // browser_evaluate (the browser_advanced category).
  browserEvaluate?: boolean
  electron?: boolean
  // Let delete/submit/send-style actions run on allowed origins unattended.
  allowConsequential?: boolean
}

// Origins must be stored normalized so the runtime check is exact equality.
export function isWorkflowOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const origin = new URL(value).origin
    return origin !== "null" && origin === value
  } catch {
    return false
  }
}

export interface WorkflowDefinition {
  id: string
  name: string
  description: string
  defaultObjective: string
  viewInConversationSidebar?: boolean
  steps: WorkflowStep[]
}
