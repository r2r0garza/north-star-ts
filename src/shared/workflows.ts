export interface WorkflowStep {
  id: string
  title: string
  instructions: string
  accountId?: string | null
  modelId?: string | null
  agentName?: string | null
  skillName?: string | null
  validateCompletion?: boolean
  maxCorrectionLoops?: number
  validatorAccountId?: string | null
  validatorModelId?: string | null
  validatorAgentName?: string | null
}

export interface WorkflowDefinition {
  id: string
  name: string
  description: string
  defaultObjective: string
  viewInConversationSidebar?: boolean
  steps: WorkflowStep[]
}
