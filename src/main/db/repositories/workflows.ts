import { randomUUID } from "node:crypto"
import { getDb } from "../connection"
import type { WorkflowDefinition } from "../../../shared/workflows"

export function createWorkflow(): WorkflowDefinition {
  const workflow: WorkflowDefinition = {
    id: randomUUID(),
    name: "New workflow",
    description: "",
    defaultObjective: "",
    steps: [],
  }
  getDb()
    .prepare(
      "INSERT INTO workflows (id, name, description, steps, position) SELECT ?, ?, ?, ?, COALESCE(MAX(position), -1) + 1 FROM workflows"
    )
    .run(
      workflow.id,
      workflow.name,
      workflow.description,
      JSON.stringify(workflow.steps)
    )
  return workflow
}

export function listWorkflows(): WorkflowDefinition[] {
  const rows = getDb()
    .prepare(
      "SELECT id, name, description, default_objective AS defaultObjective, steps FROM workflows ORDER BY position"
    )
    .all() as Array<Omit<WorkflowDefinition, "steps"> & { steps: string }>
  return rows.map((row) => ({ ...row, steps: JSON.parse(row.steps) }))
}

export function updateWorkflow(workflow: WorkflowDefinition): void {
  if (
    !workflow ||
    typeof workflow.id !== "string" ||
    typeof workflow.name !== "string" ||
    typeof workflow.description !== "string" ||
    typeof workflow.defaultObjective !== "string" ||
    !Array.isArray(workflow.steps) ||
    workflow.steps.some(
      (step) =>
        !step ||
        typeof step.id !== "string" ||
        !step.id ||
        typeof step.title !== "string" ||
        typeof step.instructions !== "string"
    ) ||
    new Set(workflow.steps.map((step) => step.id)).size !==
      workflow.steps.length
  )
    throw new Error("Invalid workflow")
  const result = getDb()
    .prepare(
      "UPDATE workflows SET name = ?, description = ?, default_objective = ?, steps = ? WHERE id = ?"
    )
    .run(
      workflow.name,
      workflow.description,
      workflow.defaultObjective,
      JSON.stringify(workflow.steps),
      workflow.id
    )
  if (!result.changes) throw new Error("Workflow not found")
}

export function deleteWorkflow(id: string): void {
  if (typeof id !== "string" || !id) throw new Error("Invalid workflow id")
  getDb().prepare("DELETE FROM workflows WHERE id = ?").run(id)
}
