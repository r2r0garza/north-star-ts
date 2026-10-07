import * as React from "react"
import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import type { AccountWithModels, Task } from "@/types"

// Task kinds that are an LLM turn in a worker conversation, and so can be
// retried (optionally on another model). Deterministic kinds — process runs,
// indexing — have their own retry paths; the main process refuses them too.
const RETRYABLE_KINDS = new Set(["agent_chat", "todo_run"])

export function isRetryableTask(task: Task): boolean {
  const kind = (task.input as { kind?: string } | null)?.kind ?? "agent_chat"
  return task.status === "failed" && RETRYABLE_KINDS.has(kind)
}

const key = (accountId: string | null, modelId: string | null) =>
  accountId && modelId ? `${accountId}::${modelId}` : ""

// "Retry" for a failed agent task: re-runs it in place (keeping its transcript)
// on a model the user picks. The picker defaults to the SOURCE conversation's
// current model, so "switch the chat's model, then Retry" does what it says;
// failing that, the model the task last ran on.
export function TaskRetryPopover({
  task,
  onRetried,
}: {
  task: Task
  onRetried?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [accounts, setAccounts] = React.useState<AccountWithModels[]>([])
  const [selected, setSelected] = React.useState("")
  const [taskModel, setTaskModel] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setError(null)
    void (async () => {
      const [list, source, worker] = await Promise.all([
        window.cowork.providers.listWithModels(),
        task.sourceConversationId
          ? window.cowork.db.conversations.get(task.sourceConversationId)
          : Promise.resolve(null),
        window.cowork.db.conversations.get(task.conversationId),
      ])
      if (cancelled) return
      const available = new Set(
        list.flatMap((a) => a.models.map((m) => key(a.account.id, m.modelId)))
      )
      const current = key(worker?.accountId ?? null, worker?.modelId ?? null)
      const preferred = [
        key(source?.accountId ?? null, source?.modelId ?? null),
        current,
      ].find((k) => k && available.has(k))
      setAccounts(list)
      setTaskModel(current)
      setSelected(preferred ?? "")
    })()
    return () => {
      cancelled = true
    }
  }, [open, task.conversationId, task.sourceConversationId])

  async function retry() {
    setBusy(true)
    setError(null)
    try {
      const [accountId, modelId] = selected.split("::")
      await window.cowork.tasks.retry(
        task.id,
        selected && selected !== taskModel
          ? { model: { accountId, modelId } }
          : undefined
      )
      setOpen(false)
      onRetried?.()
    } catch (err) {
      // ipcRenderer.invoke wraps the main-process error; keep its message only.
      const message = err instanceof Error ? err.message : String(err)
      setError(message.replace(/^Error invoking remote method '[^']+': /, ""))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="outline"
          title="Retry this task"
          onClick={(e) => e.stopPropagation()}
        >
          <RotateCcw className="size-3" />
          Retry
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col gap-2 p-3">
        <p className="text-xs font-medium">Retry on model</p>
        {task.error && (
          <p className="line-clamp-3 text-xs break-words text-muted-foreground">
            Failed: {task.error}
          </p>
        )}
        <NativeSelect
          size="sm"
          className="w-full"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {selected === "" && (
            <NativeSelectOption value="">
              Same model as before
            </NativeSelectOption>
          )}
          {accounts
            .filter((a) => a.models.length > 0)
            .map((a) => (
              <NativeSelectOptGroup
                key={a.account.id}
                label={a.account.displayName}
              >
                {a.models.map((m) => (
                  <NativeSelectOption
                    key={m.modelId}
                    value={key(a.account.id, m.modelId)}
                  >
                    {m.modelName?.trim() ? m.modelName : m.modelId}
                  </NativeSelectOption>
                ))}
              </NativeSelectOptGroup>
            ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground">
          Continues from where the task stopped; the transcript is kept.
        </p>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button size="sm" disabled={busy} onClick={() => void retry()}>
          {busy ? "Retrying…" : "Retry"}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
