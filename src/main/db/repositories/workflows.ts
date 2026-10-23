import { randomUUID } from "node:crypto"
import { getDb } from "../connection"
import { REASONING_EFFORT_PATTERN } from "../../../shared/reasoning-effort"
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
  const allowed = new Set([
    "id",
    "name",
    "description",
    "defaultObjective",
    "viewInConversationSidebar",
    "steps",
  ])
  if (Object.keys(source).some((key) => !allowed.has(key)))
    throw new Error("Invalid workflow")
  if (!Array.isArray(source.steps)) throw new Error("Invalid workflow")
  source.steps.forEach((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step))
      throw new Error("Invalid workflow")
    const row = step as Record<string, unknown>
    const stepKeys = new Set([
      "id",
      "title",
      "instructions",
      "accountId",
      "modelId",
      "effort",
      "agentName",
      "skillName",
      "validateCompletion",
      "maxCorrectionLoops",
      "validatorAccountId",
      "validatorModelId",
      "validatorEffort",
      "validatorAgentName",
    ])
    if (Object.keys(row).some((key) => !stepKeys.has(key)))
      throw new Error("Invalid workflow")
  })
  validateWorkflow(source)
  const workflow: WorkflowDefinition = {
    ...source,
    id: randomUUID(),
    steps: source.steps.map((step) => ({ ...step, id: randomUUID() })),
  }
  const db = getDb()
  db.prepare(
    "INSERT INTO workflows (id, name, description, default_objective, view_in_conversation_sidebar, steps, position) SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(position), -1) + 1 FROM workflows"
  ).run(
    workflow.id,
    workflow.name,
    workflow.description,
    workflow.defaultObjective,
    workflow.viewInConversationSidebar ? 1 : 0,
    JSON.stringify(workflow.steps)
  )
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

function isEffort(value: unknown): boolean {
  return (
    value == null ||
    (typeof value === "string" && REASONING_EFFORT_PATTERN.test(value))
  )
}

export function validateWorkflow(
  input: unknown
): asserts input is WorkflowDefinition {
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
        !isEffort(step.effort) ||
        !isEffort(step.validatorEffort) ||
        (step.agentName != null && typeof step.agentName !== "string") ||
        (step.skillName != null &&
          (typeof step.skillName !== "string" ||
            !/^[a-z0-9-]+$/.test(step.skillName))) ||
        (step.validateCompletion !== undefined &&
          typeof step.validateCompletion !== "boolean") ||
        (step.maxCorrectionLoops !== undefined &&
          (!Number.isInteger(step.maxCorrectionLoops) ||
            step.maxCorrectionLoops < 0 ||
            step.maxCorrectionLoops > 10)) ||
        (step.validatorAccountId != null &&
          typeof step.validatorAccountId !== "string") ||
        (step.validatorModelId != null &&
          typeof step.validatorModelId !== "string") ||
        (step.validatorAgentName != null &&
          typeof step.validatorAgentName !== "string")
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
