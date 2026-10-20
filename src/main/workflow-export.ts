import type { WorkflowDefinition } from "../shared/workflows"

export function serializeWorkflowExport(workflow: WorkflowDefinition): string {
  const { id, name, description, defaultObjective, viewInConversationSidebar } =
    workflow
  return JSON.stringify(
    {
      id,
      name,
      description,
      defaultObjective,
      viewInConversationSidebar,
      steps: workflow.steps.map(({ id, title, instructions, skillName }) => ({
        id,
        title,
        instructions,
        skillName,
      })),
    },
    null,
    2
  )
}
