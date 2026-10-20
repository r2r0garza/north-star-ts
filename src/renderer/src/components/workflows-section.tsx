import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  workflowUnavailableReason,
  type ConversationWorkflows,
} from "@/hooks/use-conversation-workflows"
import { workflowFinalOutput } from "../../../shared/workflow-result"

export function WorkflowsSection({
  controller,
  onViewResults,
}: {
  controller: ConversationWorkflows
  onViewResults: (id: string) => void
}) {
  return (
    <div className="space-y-2 px-2 text-xs">
      <Button
        size="sm"
        variant="ghost"
        disabled={controller.loading}
        onClick={() => void controller.refresh()}
      >
        Refresh workflows
      </Button>
      {controller.loading && <p role="status">Loading workflows…</p>}
      {controller.error && (
        <p role="alert" className="text-destructive">
          {controller.error}
        </p>
      )}
      {!controller.loading &&
        !controller.error &&
        controller.definitions.length === 0 && (
          <p className="text-muted-foreground">
            No workflows enabled. Enable “View in Conversation Sidebar” in a
            saved workflow.
          </p>
        )}
      {!controller.workspaceReady && (
        <p className="text-muted-foreground">
          A valid conversation workspace is required to run workflows.
        </p>
      )}
      {controller.definitions.map((workflow) => {
        const reason = workflowUnavailableReason(workflow)
        return (
          <div key={workflow.id} className="space-y-1 rounded-md border p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{workflow.name}</span>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !!reason ||
                  !controller.workspaceReady ||
                  controller.pending(workflow.id)
                }
                onClick={() => void controller.start(workflow.id)}
              >
                {controller.pending(workflow.id) ? "Starting…" : "Run"}
              </Button>
            </div>
            {reason && <p className="text-muted-foreground">{reason}</p>}
          </div>
        )
      })}
      {controller.runs.map(({ run, stale, missing }) => (
        <div key={run.id} className="space-y-2 rounded-md border p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{run.workflow.name}</span>
            <Badge variant="secondary">
              {missing ? "Unavailable" : run.status}
            </Badge>
          </div>
          {stale && (
            <p role="status">
              {missing
                ? "Run is no longer available."
                : "Status could not be refreshed; showing last known status."}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onViewResults(run.id)}
            >
              View Results
            </Button>
            {run.status === "Completed" && (
              <Button
                size="sm"
                variant="outline"
                disabled={stale || !workflowFinalOutput(run)}
                onClick={() => void controller.addToChat(run.id)}
              >
                Add to Chat
              </Button>
            )}
          </div>
          {run.status === "Completed" && !workflowFinalOutput(run) && (
            <p className="text-muted-foreground">
              No final output is available.
            </p>
          )}
        </div>
      ))}
    </div>
  )
}
