import { useLayoutEffect, useRef, useState } from "react"
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockContent,
} from "@/components/ui/code-block"
import {
  commandPresentation,
  displayedCommandOutput,
  INITIAL_COMPLETION_LIMIT,
  snapshotLabel,
  snapshotOutcome,
  type CommandPresentation,
  type CommandSnapshot,
} from "@/lib/command-presentation"

function LiteralBlock({
  title,
  value,
  destructive = false,
  followOutput = false,
}: {
  title: string
  value: string
  destructive?: boolean
  followOutput?: boolean
}) {
  const contentRef = useRef<HTMLPreElement>(null)
  const followingRef = useRef(true)

  useLayoutEffect(() => {
    const content = contentRef.current
    if (followOutput && followingRef.current && content) {
      content.scrollTop = content.scrollHeight
    }
  }, [value, followOutput])

  return (
    <CodeBlock size="sm" variant={destructive ? "destructive" : "default"}>
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton
            aria-label={`Copy displayed ${title.toLowerCase()}`}
            value={value}
          />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent
        ref={contentRef}
        wrap
        className="max-h-64 [overflow-wrap:anywhere]"
        onScroll={(event) => {
          const content = event.currentTarget
          followingRef.current =
            content.scrollHeight - content.scrollTop - content.clientHeight <=
            24
        }}
      >
        {value}
      </CodeBlockContent>
    </CodeBlock>
  )
}

export function CommandOutput({
  name,
  args,
  rawArgs,
  result,
  presentation = commandPresentation(name, result),
  finalOutcome,
  live = false,
  pending = false,
}: {
  name: string
  args: Record<string, unknown> | null
  rawArgs: string
  result?: string
  presentation?: CommandPresentation | null
  finalOutcome?: CommandSnapshot
  live?: boolean
  pending?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  if (!presentation && !pending) return null
  const command = typeof args?.command === "string" ? args.command : undefined
  const cwd = typeof args?.cwd === "string" ? args.cwd : undefined
  const session =
    typeof args?.session_id === "string" ? args.session_id : undefined
  const snapshots = finalOutcome
    ? [finalOutcome]
    : (presentation?.snapshots ?? [])
  const visible = expanded
    ? snapshots
    : snapshots.slice(0, INITIAL_COMPLETION_LIMIT)
  return (
    <div className="min-w-0 space-y-2" data-slot="command-output">
      {command !== undefined && (
        <LiteralBlock title="Command" value={command} />
      )}
      {cwd !== undefined && (
        <p className="[overflow-wrap:anywhere] break-words text-muted-foreground">
          Working directory: {cwd}
        </p>
      )}
      {session && (
        <p className="break-words text-muted-foreground">Session: {session}</p>
      )}
      {visible.map((snapshot, index) =>
        snapshot ? (
          <div
            key={`${snapshot.eventId ?? snapshot.sessionId ?? "snapshot"}:${index}`}
            className="min-w-0 space-y-1"
          >
            {name === "wait_for_events" && snapshot.command !== undefined && (
              <LiteralBlock title="Command" value={snapshot.command} />
            )}
            <p className="[overflow-wrap:anywhere] break-words text-muted-foreground">
              {live && snapshot.status === "running"
                ? "Running"
                : snapshotLabel(snapshot)}
              {snapshot.sessionId && ` · Session: ${snapshot.sessionId}`}
              {snapshot.eventId && ` · Event: ${snapshot.eventId}`}
              {snapshot.exitCode !== null && ` · Exit: ${snapshot.exitCode}`}
              {snapshot.signal && ` · Signal: ${snapshot.signal}`}
              {snapshot.durationMs !== undefined &&
                ` · ${snapshot.durationMs} ms`}
            </p>
            {name === "wait_for_events" && snapshot.cwd !== undefined && (
              <p className="break-words text-muted-foreground">
                Working directory: {snapshot.cwd}
              </p>
            )}
            {snapshot.status === "running" && !live && (
              <p className="text-muted-foreground">
                Final outcome unavailable in this snapshot.
              </p>
            )}
            {snapshot.cleanupError && (
              <p className="[overflow-wrap:anywhere] break-words text-destructive">
                Cleanup failed: {snapshot.cleanupError.path}:{" "}
                {snapshot.cleanupError.error}
              </p>
            )}
            <LiteralBlock
              title="Output"
              followOutput
              value={displayedCommandOutput(snapshot.output)}
              destructive={snapshotOutcome(snapshot) === "failure"}
            />
            {snapshot.output === "" && (
              <p className="text-muted-foreground">
                {live && snapshot.status === "running"
                  ? "Waiting for output…"
                  : "No output in this snapshot."}
              </p>
            )}
            {(snapshot.truncated ||
              snapshot.modelTruncated ||
              !!snapshot.droppedBytes ||
              !!snapshot.omittedBytes) && (
              <p className="text-muted-foreground">
                Source output incomplete
                {snapshot.droppedBytes
                  ? ` · ${snapshot.droppedBytes} bytes dropped`
                  : ""}
                {snapshot.omittedBytes
                  ? ` · ${snapshot.omittedBytes} bytes omitted`
                  : ""}
                {snapshot.modelTruncated ? " · Model output truncated" : ""}.
              </p>
            )}
          </div>
        ) : (
          <p key={`unknown:${index}`} className="text-muted-foreground">
            Completion {index + 1}: unsupported or missing entry; see raw
            result.
          </p>
        )
      )}
      {pending && !presentation && (
        <p className="text-muted-foreground">Waiting for output…</p>
      )}
      {presentation?.snapshots.length === 0 && (
        <p className="text-muted-foreground">No completion events.</p>
      )}
      {!expanded &&
        presentation &&
        presentation.snapshots.length > INITIAL_COMPLETION_LIMIT && (
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => setExpanded(true)}
          >
            Show all {presentation.snapshots.length} available completion
            entries
          </button>
        )}
      <details className="min-w-0 text-muted-foreground">
        <summary className="cursor-pointer">
          Original arguments and raw result
        </summary>
        <pre className="max-h-64 overflow-auto [overflow-wrap:anywhere] whitespace-pre-wrap">
          {rawArgs}
        </pre>
        <pre className="max-h-64 overflow-auto [overflow-wrap:anywhere] whitespace-pre-wrap">
          {displayedCommandOutput(result ?? "")}
        </pre>
      </details>
    </div>
  )
}
