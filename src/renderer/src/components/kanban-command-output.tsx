import type { KanbanCardRun } from "../../../shared/kanban"
import { LiteralBlock } from "./command-output"

export function KanbanCommandOutput({ run }: { run: KanbanCardRun }) {
  const output = run.commandOutput
  if (!output)
    return (
      <p className="text-xs text-muted-foreground">
        Live output unavailable for this run. Existing results and errors are
        shown below.
      </p>
    )
  const active = ["queued", "starting", "running"].includes(output.status)
  const status = active && run.status !== "running" ? "stopped" : output.status
  const label = {
    queued: "Queued — waiting to start",
    starting: "Starting command…",
    running: "Running",
    exited: "Process exited",
    timed_out: "Timed out",
    stopped: "Stopped",
    failed: "Command failed to start or execute",
  }[status]
  return (
    <section className="min-w-0 space-y-2 text-xs" aria-label="Command output">
      <p className="break-all text-muted-foreground">Run: {output.runId}</p>
      <LiteralBlock title="Command" value={output.command} />
      {output.cwd && (
        <p className="break-all">Working directory: {output.cwd}</p>
      )}
      <p role="status">
        {label}
        {output.exitCode !== null && ` · Exit: ${output.exitCode}`}
        {output.signal && ` · Signal: ${output.signal}`}
      </p>
      <LiteralBlock
        title="Output"
        value={output.output}
        followOutput
        destructive={
          status === "failed" ||
          status === "timed_out" ||
          (output.exitCode !== null && output.exitCode !== 0)
        }
      />
      {!output.output && (
        <p className="text-muted-foreground">
          {status === "running"
            ? "Waiting for output…"
            : status === "queued" || status === "starting"
              ? "No output yet."
              : "No output retained."}
        </p>
      )}
      {output.omittedBytes > 0 && (
        <p className="text-muted-foreground">
          Older output omitted: {output.omittedBytes} bytes.
        </p>
      )}
      {output.error && (
        <p className="whitespace-pre-wrap text-destructive">{output.error}</p>
      )}
    </section>
  )
}
