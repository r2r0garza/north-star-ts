import { useCallback, useEffect, useMemo, useState } from "react"
import { Check, GitFork, Pencil, Share2, Undo2, X } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { SeatMemory } from "@/types"
import {
  SeatTranscriptDialog,
  type TranscriptTarget,
} from "./seat-transcript-dialog"

// A seat's memory (plan 106.7): lessons earlier occupants of this seat learned,
// injected into every later session once active. New lessons wait here for
// review; the user shares a lesson with another seat (a copy that keeps its
// lineage) or retracts it, which retracts every copy and corrects every live
// session that was shown one. Nothing on this tab is written by an agent.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

const KIND_LABEL: Record<SeatMemory["kind"], string> = {
  lesson: "Lesson",
  convention: "Convention",
  pitfall: "Pitfall",
}

export function SeatMemoryTab({
  rigId,
  address,
  seatAddresses,
  onPendingChange,
}: {
  rigId: string
  address: string
  // Every seat in the rig, for Share.
  seatAddresses: string[]
  onPendingChange?: (pending: number) => void
}) {
  const [all, setAll] = useState<SeatMemory[] | null>(null)
  const [transcript, setTranscript] = useState<TranscriptTarget | null>(null)
  const reload = useCallback(async () => {
    const rows = await window.cowork.missionControl.seatMemory.list(rigId)
    setAll(rows)
  }, [rigId])
  useEffect(() => {
    void reload().catch(() => setAll([]))
  }, [reload])

  const mine = useMemo(
    () => (all ?? []).filter((memory) => memory.seatAddress === address),
    [all, address]
  )
  const byId = useMemo(
    () => new Map((all ?? []).map((memory) => [memory.id, memory])),
    [all]
  )
  const copiesOf = useCallback(
    (id: string) => (all ?? []).filter((memory) => memory.derivedFrom === id),
    [all]
  )
  const pending = mine.filter((m) => m.status === "pending_review")
  const active = mine.filter((m) => m.status === "active")
  const retracted = mine.filter((m) => m.status === "retracted")
  useEffect(() => {
    if (all) onPendingChange?.(pending.length)
  }, [all, pending.length, onPendingChange])

  if (!all)
    return <p className="text-sm text-muted-foreground">Loading lessons…</p>

  const card = (memory: SeatMemory) => (
    <MemoryCard
      key={memory.id}
      memory={memory}
      lineage={{
        parent: memory.derivedFrom
          ? (byId.get(memory.derivedFrom) ?? null)
          : null,
        copies: copiesOf(memory.id),
      }}
      shareTargets={seatAddresses.filter(
        (target) =>
          target !== address &&
          !copiesOf(memory.id).some(
            (copy) => copy.seatAddress === target && copy.status !== "retracted"
          )
      )}
      onOpenTranscript={() =>
        memory.originConversationId &&
        setTranscript({
          conversationId: memory.originConversationId,
          title: `Where ${address} learned this`,
          focusMessageId: memory.originMessageId,
        })
      }
      onChanged={reload}
    />
  )

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        Lessons this seat learned on this rig&apos;s work. Active lessons are
        shown to every later session in <code>{address}</code>, across features
        using this rig (at most 20, most used and most recent first).
      </p>
      <Section title="Pending review" count={pending.length}>
        {pending.length ? (
          pending.map(card)
        ) : (
          <Empty>
            New lessons wait here unless the feature auto-activates them.
          </Empty>
        )}
      </Section>
      <Section title="Active" count={active.length}>
        {active.length ? active.map(card) : <Empty>No active lessons.</Empty>}
      </Section>
      {retracted.length > 0 && (
        <Section title="Retracted" count={retracted.length}>
          {retracted.map(card)}
        </Section>
      )}
      <SeatTranscriptDialog
        target={transcript}
        onClose={() => setTranscript(null)}
      />
    </div>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-medium">{title}</h4>
        <Badge variant="secondary">{count}</Badge>
      </div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>
}

function MemoryCard({
  memory,
  lineage,
  shareTargets,
  onOpenTranscript,
  onChanged,
}: {
  memory: SeatMemory
  lineage: { parent: SeatMemory | null; copies: SeatMemory[] }
  shareTargets: string[]
  onOpenTranscript: () => void
  onChanged: () => Promise<void>
}) {
  const api = window.cowork.missionControl.seatMemory
  const [mode, setMode] = useState<"view" | "edit" | "share" | "retract">(
    "view"
  )
  const [content, setContent] = useState(memory.content)
  const [target, setTarget] = useState(shareTargets[0] ?? "")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  // `work` may return a more specific message than `done`.
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      const message = await work()
      toast.success(typeof message === "string" ? message : done)
      setMode("view")
      await onChanged()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  const retract = () =>
    run(async () => {
      const result = await api.retract(memory.id, reason)
      const copies = result.retracted.length - 1
      return (
        `Retracted${copies > 0 ? ` with ${copies} shared cop${copies === 1 ? "y" : "ies"}` : ""}. ` +
        (result.notified.length
          ? `Corrected ${result.notified.length} live session${result.notified.length === 1 ? "" : "s"}.`
          : result.exposedConversations
            ? "No live session had been shown it."
            : "No session had been shown it.")
      )
    }, "Lesson retracted")

  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{KIND_LABEL[memory.kind]}</Badge>
        {memory.originLabel && <span>{memory.originLabel}</span>}
        {memory.originConversationId && (
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={onOpenTranscript}
          >
            Open transcript turn
          </button>
        )}
        <span className="ml-auto">
          Shown to {memory.exposureCount ?? 0} session
          {memory.exposureCount === 1 ? "" : "s"}
        </span>
      </div>
      {mode === "edit" ? (
        <Textarea
          rows={3}
          value={content}
          maxLength={500}
          onChange={(e) => setContent(e.target.value)}
        />
      ) : (
        <p
          className={
            memory.status === "retracted" ? "line-through opacity-70" : ""
          }
        >
          {memory.content}
        </p>
      )}
      {memory.status === "retracted" && memory.retractReason && (
        <p className="text-xs text-muted-foreground">
          Retracted: {memory.retractReason}
        </p>
      )}
      {(lineage.parent || lineage.copies.length > 0) && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <GitFork className="size-3" />
          {lineage.parent && (
            <span>
              Copy of <code>{lineage.parent.seatAddress}</code>&apos;s lesson
              {lineage.parent.status === "retracted" ? " (retracted)" : ""}
            </span>
          )}
          {lineage.copies.length > 0 && (
            <span>
              {lineage.parent ? "· " : ""}Shared to{" "}
              {lineage.copies.map((copy, index) => (
                <span key={copy.id}>
                  {index ? ", " : ""}
                  <code>{copy.seatAddress}</code>
                  {copy.status === "retracted" ? " (retracted)" : ""}
                </span>
              ))}
            </span>
          )}
        </div>
      )}

      {memory.status === "pending_review" && (
        <div className="flex flex-wrap gap-2">
          {mode === "edit" ? (
            <>
              <Button
                size="sm"
                disabled={busy || !content.trim()}
                onClick={() =>
                  void run(
                    () => api.review(memory.id, "approve", content),
                    "Lesson approved"
                  )
                }
              >
                <Check className="size-4" /> Save and approve
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api.review(memory.id, "approve"),
                    "Lesson approved"
                  )
                }
              >
                <Check className="size-4" /> Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setMode("edit")}
              >
                <Pencil className="size-4" /> Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api.review(memory.id, "reject"),
                    "Lesson rejected"
                  )
                }
              >
                <X className="size-4" /> Reject
              </Button>
            </>
          )}
        </div>
      )}

      {memory.status === "active" && mode === "view" && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !shareTargets.length}
            title={shareTargets.length ? undefined : "Every other seat has it"}
            onClick={() => setMode("share")}
          >
            <Share2 className="size-4" /> Share…
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setMode("retract")}
          >
            <Undo2 className="size-4" /> Retract…
          </Button>
        </div>
      )}
      {mode === "share" && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger size="sm" className="h-8 w-56 text-xs">
              <SelectValue placeholder="Choose a seat" />
            </SelectTrigger>
            <SelectContent>
              {shareTargets.map((address) => (
                <SelectItem key={address} value={address}>
                  {address}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={busy || !target}
            onClick={() =>
              void run(
                () => api.share(memory.id, target),
                `Shared with ${target}`
              )
            }
          >
            Share
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
            Cancel
          </Button>
        </div>
      )}
      {mode === "retract" && (
        <div className="space-y-2">
          <Textarea
            rows={2}
            value={reason}
            placeholder="Why is it wrong? Sessions that were shown it read this."
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Retracts this lesson and every copy shared from it, and tells each
            session that was shown one not to apply it.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void retract()}
            >
              Retract
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode("view")}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
