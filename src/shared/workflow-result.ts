import { renderContextEnvelope } from "./context-provenance"
import type { WorkflowRun } from "./workflow-runs"

export function workflowFinalOutput(run: WorkflowRun): string | null {
  const output = run.steps.at(-1)?.result
  return run.status === "Completed" && output?.trim() ? output : null
}

export function formatWorkflowResult(run: WorkflowRun): string {
  const output = workflowFinalOutput(run)
  if (!output) throw new Error("This run has no completed final output")
  const envelope = renderContextEnvelope(
    {
      trust: "untrusted_data",
      channel: "agent",
      source: `workflow-run:${run.id}`,
    },
    output.replace(/\r\n|\r/g, "\n")
  )
  return `Workflow result ${JSON.stringify({ workflow: run.workflow.name, runId: run.id })}\n${envelope}\n[End workflow result]\n\nAdditional user instructions:\n`
}

// Re-apply line boundaries after textarea edits, without changing surrounding instructions.
export function normalizeWorkflowResults(text: string): string {
  return text.replace(
    /(^Workflow result [^\n]+\n)(\[context provenance: trust=untrusted_data channel=agent source="workflow-run:[^\n]+\n)(\[context boundary:[^\n]+\n)([\s\S]*?)(^\[End workflow result\]$)/gm,
    (
      _block,
      attribution: string,
      header: string,
      boundary: string,
      body: string,
      end: string
    ) => {
      const lines = body
        .replace(/\n$/, "")
        .split("\n")
        .map((line) => (line.startsWith("DATA: ") ? line : `DATA: ${line}`))
      return `${attribution}${header}${boundary}${lines.join("\n")}\n${end}`
    }
  )
}
