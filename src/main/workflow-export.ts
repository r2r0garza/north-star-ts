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
      // Effort levels are portable names; providers reconcile them against whatever model resolves.
      // Browser/Electron capabilities (plan 130) are portable and safety-relevant.
      steps: workflow.steps.map(
        ({
          id,
          title,
          instructions,
          skillName,
          effort,
          validatorEffort,
          browser,
          allowedOrigins,
          browserEvaluate,
          electron,
          allowConsequential,
        }) => ({
          id,
          title,
          instructions,
          skillName,
          effort,
          validatorEffort,
          browser,
          allowedOrigins,
          browserEvaluate,
          electron,
          allowConsequential,
        })
      ),
    },
    null,
    2
  )
}
