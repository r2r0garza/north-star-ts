export interface WorkflowStep {
  id: string
  title: string
  instructions: string
}

export interface WorkflowDefinition {
  id: string
  name: string
  description: string
  defaultObjective: string
  steps: WorkflowStep[]
}
