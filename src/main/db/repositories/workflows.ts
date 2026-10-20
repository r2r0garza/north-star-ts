import { randomUUID } from "node:crypto"
import { getDb } from "../connection"
import type { WorkflowDefinition } from "../../../shared/workflows"

export function createWorkflow(): WorkflowDefinition {
  const workflow: WorkflowDefinition = {
    id: randomUUID(),
    name: "New workflow",
    description: "",
    defaultObjective: "",
    viewInConversationSidebar: false,
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

export function importWorkflow(input: unknown): WorkflowDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid workflow")
  const source = input as Record<string, unknown>
  const allowed = new Set(["id", "name", "description", "defaultObjective", "viewInConversationSidebar", "steps"])
  if (Object.keys(source).some((key) => !allowed.has(key)))
    throw new Error("Invalid workflow")
  if (!Array.isArray(source.steps)) throw new Error("Invalid workflow")
  source.steps.forEach((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step))
      throw new Error("Invalid workflow")
    const row = step as Record<string, unknown>
    const stepKeys = new Set(["id", "title", "instructions", "accountId", "modelId", "agentName"])
    if (Object.keys(row).some((key) => !stepKeys.has(key))) throw new Error("Invalid workflow")
  })
  validateWorkflow(source)
  const workflow: WorkflowDefinition = {
    ...source,
    id: randomUUID(),
    steps: source.steps.map((step) => ({ ...step, id: randomUUID() })),
  }
  const db = getDb()
  db.prepare("INSERT INTO workflows (id, name, description, default_objective, view_in_conversation_sidebar, steps, position) SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(position), -1) + 1 FROM workflows")
    .run(workflow.id, workflow.name, workflow.description, workflow.defaultObjective, workflow.viewInConversationSidebar ? 1 : 0, JSON.stringify(workflow.steps))
  return workflow
}

export function listWorkflows(): WorkflowDefinition[] {
  const rows = getDb()
    .prepare(
      "SELECT id, name, description, default_objective AS defaultObjective, COALESCE(view_in_conversation_sidebar, 0) AS viewInConversationSidebar, steps FROM workflows ORDER BY position"
    )
    .all() as Array<Omit<WorkflowDefinition, "steps"> & { steps: string }>
  return rows.map((row) => ({
    ...row,
    viewInConversationSidebar: Boolean(row.viewInConversationSidebar),
    steps: JSON.parse(row.steps),
  }))
}

export function validateWorkflow(input: unknown): asserts input is WorkflowDefinition {
  const workflow = input as WorkflowDefinition
  if (
    !workflow ||
    typeof workflow.id !== "string" ||
    typeof workflow.name !== "string" ||
    typeof workflow.description !== "string" ||
    typeof workflow.defaultObjective !== "string" ||
    (workflow.viewInConversationSidebar !== undefined &&
      typeof workflow.viewInConversationSidebar !== "boolean") ||
    !Array.isArray(workflow.steps) ||
    workflow.steps.some(
      (step) =>
        !step ||
        typeof step.id !== "string" ||
        !step.id ||
        typeof step.title !== "string" ||
        typeof step.instructions !== "string" ||
        (step.accountId != null && typeof step.accountId !== "string") ||
        (step.modelId != null && typeof step.modelId !== "string") ||
        (step.agentName != null && typeof step.agentName !== "string")
    ) ||
    new Set(workflow.steps.map((step) => step.id)).size !==
      workflow.steps.length
  )
    throw new Error("Invalid workflow")
}

export function updateWorkflow(workflow: WorkflowDefinition): void {
  validateWorkflow(workflow)
  const result = getDb()
    .prepare(
      "UPDATE workflows SET name = ?, description = ?, default_objective = ?, view_in_conversation_sidebar = ?, steps = ? WHERE id = ?"
    )
    .run(
      workflow.name,
      workflow.description,
      workflow.defaultObjective,
      workflow.viewInConversationSidebar ? 1 : 0,
      JSON.stringify(workflow.steps),
      workflow.id
    )
  if (!result.changes) throw new Error("Workflow not found")
}

export function deleteWorkflow(id: string): void {
  if (typeof id !== "string" || !id) throw new Error("Invalid workflow id")
  getDb().prepare("DELETE FROM workflows WHERE id = ?").run(id)
}
