export interface WorkflowStep {
  id: string
  title: string
  instructions: string
  accountId?: string | null
  modelId?: string | null
}

export interface WorkflowDefinition {
  id: string
  name: string
  description: string
  defaultObjective: string
  steps: WorkflowStep[]
}
