export interface WorkflowStep {
  id: string
  title: string
  instructions: string
  accountId?: string | null
  modelId?: string | null
  agentName?: string | null
}

export interface WorkflowDefinition {
  id: string
  name: string
  description: string
  defaultObjective: string
  viewInConversationSidebar?: boolean
  steps: WorkflowStep[]
}
