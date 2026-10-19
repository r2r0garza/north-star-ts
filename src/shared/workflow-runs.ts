import type { WorkflowDefinition, WorkflowStep } from "./workflows"

export type WorkflowRunStatus =
  | "Active"
  | "Completed"
  | "Paused"
  | "Cancelled"
  | "Failed"
  | "Interrupted"
export interface WorkflowStepRun extends WorkflowStep {
  status:
    | "waiting"
    | "active"
    | "completed"
    | "paused"
    | "cancelled"
    | "failed"
    | "interrupted"
  conversationId: string | null
  result: string | null
  error: string | null
  startedAt: number | null
  finishedAt: number | null
}
export interface WorkflowRun {
  id: string
  taskId: string | null
  workflowId: string
  workflow: WorkflowDefinition
  title: string
  objective: string
  workspaceId: string
  workspacePath: string
  projectId: string | null
  projectName: string | null
  accountId: string
  modelId: string
  status: WorkflowRunStatus
  // Workspace indexing before the first step; absent when none was needed.
  indexing?: "running" | "ready" | "timed_out" | "failed"
  steps: WorkflowStepRun[]
  error: string | null
  createdAt: number
  updatedAt: number
}
export interface StartWorkflowRun {
  workspaceId: string
  projectId?: string | null
  workflowId: string
  objective: string
}
