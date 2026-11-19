import { useEffect, useRef, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  Copy,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { AgentSummary } from "../../../preload/index"
import {
  asDependencyLinks,
  DEFAULT_MAX_RETURNS,
  type KanbanBoardGraph,
  type KanbanColumnInput,
  MAX_PARALLEL_COMMANDS,
  MAX_WIP_LIMIT,
  COMMAND_PLACEHOLDERS,
  INSTRUCTION_PLACEHOLDERS,
  type KanbanFieldRule,
  type KanbanIntakeFilter,
  type KanbanOutcome,
  type KanbanOutcomeNext,
  type KanbanWriteApproval,
} from "../../../shared/kanban"

const APPROVAL_LABEL: Record<KanbanWriteApproval, string> = {
  always: "Ask before every write",
  once_per_action: "Ask once per action, then run it automatically",
  once_per_board: "Ask once for the whole board",
  auto: "Never ask",
}

const NEXT_LABEL: Record<KanbanOutcomeNext, string> = {
  advance: "Move to the next column",
  wait: "Wait for me",
  end: "Finish the card here",
  goto: "Send to…",
}

// Custom field rules ⇄ one comma-separated input per field.
const ruleText = (rules?: KanbanFieldRule[]) =>
  Object.fromEntries((rules ?? []).map((r) => [r.field, r.values.join(", ")]))
const toRules = (text: Record<string, string>) =>
  Object.entries(text)
    .map(([field, v]) => ({ field, values: splitTags(v) }))
    .filter((r) => r.values.length)

function FieldRuleInputs({
  idPrefix,
  fields,
  mapped,
  text,
  onChange,
}: {
  idPrefix: string
  fields: string[]
  mapped: Set<string>
  text: Record<string, string>
  onChange: (next: Record<string, string>) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {fields.map((field, i) => (
        <div key={field} className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-${i}`}>{field} (comma-separated)</Label>
          <Input
            id={`${idPrefix}-${i}`}
            placeholder="Any"
            value={text[field] ?? ""}
            onChange={(e) => onChange({ ...text, [field]: e.target.value })}
          />
          {!mapped.has(field) && text[field]?.trim() ? (
            <p className="text-xs text-destructive">
              The intake recipe no longer maps this field, so no item would
              match. Clear it or ask the agent to map it.
            </p>
          ) : null}
        </div>
      ))}
    </div>
  )
}

const splitTags = (text: string) =>
  text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)

const placeholderList = (names: readonly string[]) =>
  names.map((n) => `{{${n}}}`).join(", ")

// Time-limit choices for a user column's command (5–90 minutes, or off).
const COMMAND_TIMEOUT_MINUTES = [5, 10, 15, 20, 30, 45, 60, 75, 90]

function SortableColumn({
  id,
  name,
  selected,
  onSelect,
}: {
  id: string
  name: string
  selected: boolean
  onSelect: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "relative flex items-center rounded-md",
        selected && "bg-secondary",
        isDragging && "z-10 bg-background shadow-md"
      )}
    >
      <Button
        ref={setActivatorNodeRef}
        variant="ghost"
        size="icon-sm"
        className="shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${name || "untitled column"}`}
      >
        <GripVertical className="size-4" />
      </Button>
      <Button
        variant="ghost"
        className="h-auto min-w-0 flex-1 justify-start text-left break-words whitespace-normal"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
      >
        {name || "Untitled column"}
      </Button>
    </div>
  )
}

// A column's outcomes (plan 136.3): what each verdict the agent reports does.
// goto targets hold the target column's sortId while editing.
function OutcomesEditor({
  outcomes,
  columns,
  self,
  onChange,
}: {
  outcomes: KanbanOutcome[]
  columns: Array<{ sortId: string; name: string }>
  self: string
  onChange: (outcomes: KanbanOutcome[]) => void
}) {
  const set = (i: number, patch: Partial<KanbanOutcome>) =>
    onChange(outcomes.map((o, j) => (j === i ? { ...o, ...patch } : o)))
  const others = columns.filter((c) => c.sortId !== self)
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">Outcomes</legend>
      <p className="text-xs text-muted-foreground">
        Optional. The agent reports one of these when it finishes (for example
        passed or failed). Leave empty to just move on.
      </p>
      {outcomes.map((o, i) => (
        <div
          key={i}
          className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[8rem_1fr_auto]"
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`kb-outcome-${i}`}>Outcome</Label>
            <Input
              id={`kb-outcome-${i}`}
              value={o.name}
              onChange={(e) => set(i, { name: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-40 flex-1 flex-col gap-1">
              <Label htmlFor={`kb-outcome-next-${i}`}>Then</Label>
              <NativeSelect
                id={`kb-outcome-next-${i}`}
                className="w-full"
                value={o.next}
                onChange={(e) => {
                  const next = e.target.value as KanbanOutcomeNext
                  set(
                    i,
                    next === "goto"
                      ? {
                          next,
                          target: o.target ?? others[0]?.sortId ?? "",
                          maxReturns: o.maxReturns ?? DEFAULT_MAX_RETURNS,
                        }
                      : { next, target: undefined, maxReturns: undefined }
                  )
                }}
              >
                {(Object.keys(NEXT_LABEL) as KanbanOutcomeNext[]).map((n) => (
                  <NativeSelectOption key={n} value={n}>
                    {NEXT_LABEL[n]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            {o.next === "goto" ? (
              <>
                <div className="flex min-w-32 flex-1 flex-col gap-1">
                  <Label htmlFor={`kb-outcome-target-${i}`}>Column</Label>
                  <NativeSelect
                    id={`kb-outcome-target-${i}`}
                    className="w-full"
                    value={o.target ?? ""}
                    onChange={(e) => set(i, { target: e.target.value })}
                  >
                    {others.map((c) => (
                      <NativeSelectOption key={c.sortId} value={c.sortId}>
                        {c.name || "Untitled column"}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="flex w-24 flex-col gap-1">
                  <Label htmlFor={`kb-outcome-max-${i}`}>Max returns</Label>
                  <Input
                    id={`kb-outcome-max-${i}`}
                    type="number"
                    min={0}
                    value={o.maxReturns ?? DEFAULT_MAX_RETURNS}
                    onChange={(e) =>
                      set(i, {
                        maxReturns: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                  />
                </div>
              </>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove outcome ${o.name || i + 1}`}
            onClick={() => onChange(outcomes.filter((_, j) => j !== i))}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...outcomes, { name: "", next: "advance" }])}
      >
        <Plus className="size-4" />
        Add outcome
      </Button>
    </fieldset>
  )
}

// Board settings (plan 136.2): name, sync interval, intake filter, and the
// ordered columns with their agent, instructions, and gate. Columns keep their
// id across edits, so their cards and run history stay put.
export function KanbanSettingsSheet({
  graph,
  onClose,
  onSaved,
}: {
  graph: KanbanBoardGraph
  onClose: () => void
  onSaved: () => void
}) {
  const { board } = graph
  const [name, setName] = useState(board.name)
  const [minutes, setMinutes] = useState(String(board.syncIntervalMs / 60_000))
  const [tags, setTags] = useState(board.filter.tags.join(", "))
  const [match, setMatch] = useState(board.filter.match)
  const [exclude, setExclude] = useState(board.filter.excludeTags.join(", "))
  const [assignee, setAssignee] = useState(board.filter.assignee.mode)
  const [user, setUser] = useState(
    board.filter.assignee.mode === "user" ? board.filter.assignee.user : ""
  )
  const [query, setQuery] = useState(board.filter.query ?? "")
  const [types, setTypes] = useState(board.filter.types.join(", "))
  const [states, setStates] = useState(board.filter.states.join(", "))
  const mappedFields = new Set(Object.keys(board.source?.fields.custom ?? {}))
  // Mapped fields plus any a rule still names, so a stale rule can be cleared.
  const customFields = [
    ...new Set([
      ...mappedFields,
      ...(board.filter.fields ?? []).map((r) => r.field),
      ...(board.autoPromote.fields ?? []).map((r) => r.field),
    ]),
  ]
  const [fieldText, setFieldText] = useState(() =>
    ruleText(board.filter.fields)
  )
  const [promoteFieldText, setPromoteFieldText] = useState(() =>
    ruleText(board.autoPromote.fields)
  )
  const [promoteStates, setPromoteStates] = useState(
    board.autoPromote.states.join(", ")
  )
  const [promoteTags, setPromoteTags] = useState(
    board.autoPromote.tags.join(", ")
  )
  // The entry gate is edited as comma-separated text, parsed on save.
  const [columns, setColumns] = useState<
    (KanbanColumnInput & {
      sortId: string
      gateStates?: string
      gateTags?: string
    })[]
  >(
    graph.columns.map(
      ({
        id,
        name,
        agentName,
        instructions,
        gate,
        owner,
        outcomes,
        actions,
        command,
        commandTimeoutMs,
        notify,
        wipLimit,
        entryGate,
      }) => ({
        sortId: id,
        id,
        name,
        agentName,
        instructions,
        gate,
        owner,
        outcomes,
        actions,
        command,
        commandTimeoutMs,
        notify,
        wipLimit,
        entryGate,
        gateStates: entryGate.states.join(", "),
        gateTags: entryGate.tags.join(", "),
      })
    )
  )
  const [writeApproval, setWriteApproval] = useState(board.writeApproval)
  const [paused, setPaused] = useState(board.actionsPaused)
  const [worktrees, setWorktrees] = useState(board.worktrees)
  const [parallel, setParallel] = useState(board.parallelCommands)
  const [notifications, setNotifications] = useState(board.notifications)
  // null: the workspace scan's links, until the person edits the list.
  const [links, setLinks] = useState(board.dependencyLinks)
  const [newLink, setNewLink] = useState("")
  const shownLinks = links ?? graph.detectedLinks
  const addLink = () => {
    const [link] = asDependencyLinks([newLink]) ?? []
    if (!link) {
      toast.error(
        "Use a path inside the workspace, like apps/web/node_modules."
      )
      return
    }
    setLinks([...new Set([...shownLinks, link])])
    setNewLink("")
  }
  // Worktrees need repos; without them, cards always share the workspace.
  const canWorktree = graph.layout !== "none"
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [saving, setSaving] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const columnList = useRef<HTMLDivElement>(null)
  const columnAdded = useRef(false)
  // Show a just-added column at the bottom of a list that has started scrolling.
  useEffect(() => {
    if (!columnAdded.current) return
    columnAdded.current = false
    const list = columnList.current
    list?.scrollTo?.({ top: list.scrollHeight })
  }, [columns.length])
  const col = columns[selectedIndex]
  const mine = col?.owner === "user"
  const occupied =
    !!col?.id && graph.cards.some((card) => card.columnId === col.id)

  useEffect(() => {
    void window.cowork.agents
      .list(board.workspace ?? undefined)
      .then(setAgents)
      .catch(() => setAgents([]))
  }, [board.workspace])

  const update = (i: number, patch: Partial<(typeof columns)[number]>) =>
    setColumns((cols) => cols.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const reorder = (from: number, to: number) => {
    if (from < 0 || to < 0 || from === to) return
    const next = arrayMove(columns, from, to)
    setSelectedIndex(next.findIndex((column) => column.sortId === col?.sortId))
    setColumns(next)
  }
  const move = (i: number, by: number) => reorder(i, i + by)

  async function save() {
    const fieldRules = toRules(fieldText)
    const filter: KanbanIntakeFilter = {
      tags: splitTags(tags),
      match,
      excludeTags: splitTags(exclude),
      types: splitTags(types),
      states: splitTags(states),
      assignee:
        assignee === "user"
          ? { mode: "user", user: user.trim() }
          : { mode: assignee },
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(fieldRules.length ? { fields: fieldRules } : {}),
    }
    setSaving(true)
    try {
      const result = await window.cowork.kanban.saveSettings(board.id, {
        name,
        filter,
        syncIntervalMs: Math.max(1, Number(minutes) || 5) * 60_000,
        // goto targets are edited by sortId; a new column has no id yet, so
        // send its name. Actions are omitted, so the stored ones are kept.
        columns: columns.map(
          ({ sortId, actions, gateStates, gateTags, ...column }) => ({
            ...column,
            entryGate: {
              states: splitTags(gateStates ?? ""),
              tags: splitTags(gateTags ?? ""),
              fields: column.entryGate?.fields,
            },
            outcomes: (column.outcomes ?? []).map((o) => {
              if (o.next !== "goto") return o
              const t = columns.find((c) => c.sortId === o.target)
              return { ...o, target: t ? (t.id ?? t.name) : o.target }
            }),
          })
        ),
        writeApproval,
        actionsPaused: paused,
        worktrees,
        parallelCommands: parallel,
        notifications,
        dependencyLinks: links,
        autoPromote: {
          states: splitTags(promoteStates),
          tags: splitTags(promoteTags),
          fields: toRules(promoteFieldText),
        },
      })
      if (!result.ok) {
        toast.error(result.reason)
        return
      }
      toast.success("Board saved")
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[min(48rem,calc(100dvh-3rem))] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[56rem]">
        <DialogHeader className="shrink-0 px-6 pt-6 pr-12 pb-4">
          <DialogTitle>Board settings</DialogTitle>
          <DialogDescription className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="min-w-0 truncate">{board.name}</span>
            <span
              className="min-w-0 truncate text-xs text-muted-foreground"
              title={board.workspace ?? undefined}
            >
              {board.workspace
                ? `Workspace: ${board.workspace}`
                : "No workspace"}
            </span>
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="columns" className="min-h-0 flex-1 gap-0">
          <TabsList
            variant="line"
            className="mx-6 mb-3 shrink-0"
            aria-label="Board settings sections"
          >
            <TabsTrigger value="columns">Columns</TabsTrigger>
            <TabsTrigger value="general">General &amp; filters</TabsTrigger>
          </TabsList>
          <TabsContent
            value="general"
            className="min-h-0 overflow-y-auto border-t"
          >
            <div className="mx-auto flex max-w-2xl flex-col gap-5 p-6">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="kb-board-id">
                  Board ID (give it to the agent to edit this board)
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="kb-board-id"
                    readOnly
                    value={board.id}
                    className="font-mono text-xs"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Copy board ID"
                    onClick={() =>
                      navigator.clipboard.writeText(board.id).then(
                        () => toast.success("Board ID copied"),
                        () => toast.error("Could not copy the board ID")
                      )
                    }
                  >
                    <Copy />
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem]">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kb-name">Name</Label>
                  <Input
                    id="kb-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kb-interval">Sync every (min)</Label>
                  <Input
                    id="kb-interval"
                    type="number"
                    min={1}
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                  />
                </div>
              </div>

              <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 text-sm font-medium">
                  Intake filter
                </legend>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem]">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="kb-tags">Tags (comma-separated)</Label>
                    <Input
                      id="kb-tags"
                      value={tags}
                      onChange={(e) => setTags(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="kb-match">Match</Label>
                    <NativeSelect
                      className="w-full"
                      id="kb-match"
                      value={match}
                      onChange={(e) =>
                        setMatch(e.target.value as "any" | "all")
                      }
                    >
                      <NativeSelectOption value="any">any</NativeSelectOption>
                      <NativeSelectOption value="all">all</NativeSelectOption>
                    </NativeSelect>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kb-exclude">Exclude tags</Label>
                  <Input
                    id="kb-exclude"
                    value={exclude}
                    onChange={(e) => setExclude(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="kb-types">Types (comma-separated)</Label>
                    <Input
                      id="kb-types"
                      placeholder="Any"
                      value={types}
                      onChange={(e) => setTypes(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="kb-states">States (comma-separated)</Label>
                    <Input
                      id="kb-states"
                      placeholder="Any open state"
                      value={states}
                      onChange={(e) => setStates(e.target.value)}
                    />
                  </div>
                </div>
                {(types.trim() && !board.source?.fields.type) ||
                (states.trim() && !board.source?.fields.state) ? (
                  <p className="text-xs text-destructive">
                    The intake recipe doesn&apos;t map items&apos;{" "}
                    {types.trim() && !board.source?.fields.type
                      ? "type"
                      : "state"}
                    , so no item would pass this filter. Ask the agent to map
                    it.
                  </p>
                ) : null}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="kb-assignee">Assigned to</Label>
                    <NativeSelect
                      className="w-full"
                      id="kb-assignee"
                      value={assignee}
                      onChange={(e) =>
                        setAssignee(e.target.value as "me" | "anyone" | "user")
                      }
                    >
                      <NativeSelectOption value="me">me</NativeSelectOption>
                      <NativeSelectOption value="user">
                        a person
                      </NativeSelectOption>
                      <NativeSelectOption value="anyone">
                        anyone
                      </NativeSelectOption>
                    </NativeSelect>
                  </div>
                  {assignee === "user" ? (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="kb-user">
                        Person (as the tracker names them)
                      </Label>
                      <Input
                        id="kb-user"
                        value={user}
                        onChange={(e) => setUser(e.target.value)}
                      />
                    </div>
                  ) : null}
                </div>
                {customFields.length ? (
                  <FieldRuleInputs
                    idPrefix="kb-field"
                    fields={customFields}
                    mapped={mappedFields}
                    text={fieldText}
                    onChange={setFieldText}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    To filter on a custom field (like QA Assigned), ask the
                    agent to map it in the intake recipe.
                  </p>
                )}
                {assignee === "me" && !board.source?.whoami ? (
                  <p className="text-xs text-destructive">
                    This board has no whoami recipe, so &quot;me&quot;
                    can&apos;t be resolved. Ask the agent to add one.
                  </p>
                ) : null}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kb-query">Raw query (optional)</Label>
                  <Textarea
                    id="kb-query"
                    rows={2}
                    placeholder="Replaces the compiled GitHub search / JQL / WIQL. Tags and assignee are still checked."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
              </fieldset>

              <p className="text-xs text-muted-foreground">
                A filter change that alters the tracker query needs the intake
                recipe approved again.
              </p>

              <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 text-sm font-medium">
                  Auto-promote
                </legend>
                <p
                  id="kb-promote-description"
                  className="text-xs text-muted-foreground"
                >
                  After each sync, Inbox cards that match move to the first
                  column and start working. Fill in states, tags, or both (a
                  card must match each one you fill in). Leave both empty to
                  pick cards yourself. Custom fields below count too. A card you
                  put back in the Inbox stays there.
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="kb-promote-states">
                      When the state is (comma-separated)
                    </Label>
                    <Input
                      id="kb-promote-states"
                      aria-describedby="kb-promote-description"
                      value={promoteStates}
                      onChange={(e) => setPromoteStates(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="kb-promote-tags">
                      And it has a tag (comma-separated)
                    </Label>
                    <Input
                      id="kb-promote-tags"
                      aria-describedby="kb-promote-description"
                      value={promoteTags}
                      onChange={(e) => setPromoteTags(e.target.value)}
                    />
                  </div>
                </div>
                {customFields.length ? (
                  <FieldRuleInputs
                    idPrefix="kb-promote-field"
                    fields={customFields}
                    mapped={mappedFields}
                    text={promoteFieldText}
                    onChange={setPromoteFieldText}
                  />
                ) : null}
              </fieldset>

              <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 text-sm font-medium">
                  Tracker writes
                </legend>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="kb-write-approval">Approval</Label>
                  <NativeSelect
                    className="w-full"
                    id="kb-write-approval"
                    value={writeApproval}
                    onChange={(e) =>
                      setWriteApproval(e.target.value as KanbanWriteApproval)
                    }
                  >
                    {(Object.keys(APPROVAL_LABEL) as KanbanWriteApproval[]).map(
                      (level) => (
                        <NativeSelectOption key={level} value={level}>
                          {APPROVAL_LABEL[level]}
                        </NativeSelectOption>
                      )
                    )}
                  </NativeSelect>
                  <p className="text-xs text-muted-foreground">
                    Column actions write to the tracker (state, comments,
                    labels). Each write is logged and runs once per visit to a
                    column. A changed action asks again.
                  </p>
                </div>
                <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="kb-writes-paused">
                      Pause tracker writes
                    </Label>
                    <p
                      id="kb-writes-paused-description"
                      className="text-xs text-muted-foreground"
                    >
                      Every write waits on its card for you, whatever the
                      approval level.
                    </p>
                  </div>
                  <Switch
                    id="kb-writes-paused"
                    aria-describedby="kb-writes-paused-description"
                    checked={paused}
                    onCheckedChange={setPaused}
                  />
                </div>
              </fieldset>

              <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 text-sm font-medium">
                  Running cards
                </legend>
                {canWorktree ? (
                  <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="kb-worktrees">Worktrees</Label>
                      <p
                        id="kb-worktrees-description"
                        className="text-xs text-muted-foreground"
                      >
                        {graph.layout === "repos"
                          ? "Each card gets its own folder, and its agent opens a worktree for each repo it changes. Cards work in parallel."
                          : "Each card gets its own worktree and branch, so cards work in parallel."}{" "}
                        Off: cards work in your checkout, one at a time. A card
                        can override this before it first runs.
                      </p>
                    </div>
                    <Switch
                      id="kb-worktrees"
                      aria-describedby="kb-worktrees-description"
                      checked={worktrees}
                      onCheckedChange={setWorktrees}
                    />
                  </div>
                ) : null}
                {canWorktree ? (
                  <div className="flex flex-col gap-3 rounded-lg border p-4">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="kb-link-new">Dependency links</Label>
                      <p
                        id="kb-links-description"
                        className="text-xs text-muted-foreground"
                      >
                        Installed folders git leaves out of a worktree, like
                        node_modules. A worktree card&apos;s agent is told to
                        link each one from your checkout before building or
                        testing. Paths are relative to{" "}
                        {graph.layout === "repos"
                          ? "the workspace and start with the repo (backend/node_modules)"
                          : "the repo (apps/web/node_modules)"}
                        .{" "}
                        {links === null
                          ? "Found by checking the top of each repo; add nested ones here."
                          : null}
                      </p>
                    </div>
                    {shownLinks.length ? (
                      <ul
                        className="flex flex-col gap-1"
                        aria-label="Dependency links"
                      >
                        {shownLinks.map((link) => (
                          <li
                            key={link}
                            className="flex items-center justify-between gap-2 text-sm"
                          >
                            <code className="truncate">{link}</code>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={`Remove ${link}`}
                              onClick={() =>
                                setLinks(shownLinks.filter((l) => l !== link))
                              }
                            >
                              Remove
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted-foreground">None.</p>
                    )}
                    <div className="flex gap-2">
                      <Input
                        id="kb-link-new"
                        aria-describedby="kb-links-description"
                        placeholder={
                          graph.layout === "repos"
                            ? "frontend/packages/ui/node_modules"
                            : "apps/web/node_modules"
                        }
                        value={newLink}
                        onChange={(e) => setNewLink(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return
                          e.preventDefault()
                          if (newLink.trim()) addLink()
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!newLink.trim()}
                        onClick={addLink}
                      >
                        Add
                      </Button>
                      {links !== null ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setLinks(null)}
                        >
                          Use detected
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {!worktrees || !canWorktree ? (
                  <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="kb-parallel">
                        Run column commands in parallel
                      </Label>
                      <p
                        id="kb-parallel-description"
                        className="text-xs text-muted-foreground"
                      >
                        Up to {MAX_PARALLEL_COMMANDS} cards&apos; commands run
                        at once across the board. Only turn this on if your
                        commands keep their own work apart (for example, a
                        script that makes its own worktrees). Agents still work
                        one card at a time.
                      </p>
                    </div>
                    <Switch
                      id="kb-parallel"
                      aria-describedby="kb-parallel-description"
                      checked={parallel}
                      onCheckedChange={setParallel}
                    />
                  </div>
                ) : null}
              </fieldset>

              <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 text-sm font-medium">
                  Notifications
                </legend>
                <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="kb-notifications">
                      Notify when cards finish a column
                    </Label>
                    <p
                      id="kb-notifications-description"
                      className="text-xs text-muted-foreground"
                    >
                      A desktop notification for every card run on this board.
                      Off: only columns you turn on notify. Syncs never notify.
                    </p>
                  </div>
                  <Switch
                    id="kb-notifications"
                    aria-describedby="kb-notifications-description"
                    checked={notifications}
                    onCheckedChange={setNotifications}
                  />
                </div>
              </fieldset>
            </div>
          </TabsContent>
          <TabsContent
            value="columns"
            className="min-h-0 overflow-y-auto border-t sm:flex sm:overflow-hidden"
          >
            {/* Side by side, the column list and the editor scroll on their own. */}
            <div className="flex min-h-full flex-col sm:min-h-0 sm:flex-1 sm:flex-row">
              <nav
                aria-label="Board columns"
                className="flex shrink-0 flex-col gap-1 border-b bg-muted/30 p-3 sm:w-48 sm:border-r sm:border-b-0"
              >
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  Column order
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mb-2"
                  onClick={() => {
                    columnAdded.current = true
                    setSelectedIndex(columns.length)
                    setColumns((cols) => [
                      ...cols,
                      {
                        sortId: crypto.randomUUID(),
                        name: `Column ${cols.length + 1}`,
                        instructions: "",
                        gate: "agent",
                        agentName: null,
                      },
                    ])
                  }}
                >
                  <Plus className="size-4" />
                  Add column
                </Button>
                {/* Only the list scrolls; the heading and Add column stay put. */}
                <div
                  ref={columnList}
                  className="flex flex-col gap-1 sm:min-h-0 sm:flex-1 sm:overflow-y-auto"
                >
                  <div className="rounded-md px-3 py-2 text-sm text-muted-foreground">
                    Inbox <span className="text-xs">(always first)</span>
                  </div>
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={({ active, over }) => {
                      if (!over) return
                      reorder(
                        columns.findIndex(
                          (column) => column.sortId === active.id
                        ),
                        columns.findIndex((column) => column.sortId === over.id)
                      )
                    }}
                  >
                    <SortableContext
                      items={columns.map((column) => column.sortId)}
                      strategy={verticalListSortingStrategy}
                    >
                      {columns.map((column, i) => (
                        <SortableColumn
                          key={column.sortId}
                          id={column.sortId}
                          name={column.name}
                          selected={i === selectedIndex}
                          onSelect={() => setSelectedIndex(i)}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                </div>
              </nav>
              <div className="min-w-0 flex-1 p-6 sm:overflow-y-auto">
                {col ? (
                  <div className="flex flex-col gap-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-medium">Edit column</h3>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Move column up"
                          disabled={selectedIndex === 0}
                          onClick={() => move(selectedIndex, -1)}
                        >
                          <ArrowUp className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Move column down"
                          disabled={selectedIndex === columns.length - 1}
                          onClick={() => move(selectedIndex, 1)}
                        >
                          <ArrowDown className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove column ${col.name}`}
                          disabled={occupied}
                          onClick={() => {
                            setColumns((cols) =>
                              cols.filter((_, i) => i !== selectedIndex)
                            )
                            setSelectedIndex(Math.max(0, selectedIndex - 1))
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="kb-column-name">Column name</Label>
                      <Input
                        id="kb-column-name"
                        value={col.name}
                        onChange={(e) =>
                          update(selectedIndex, { name: e.target.value })
                        }
                      />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label htmlFor="kb-column-owner">Who works it</Label>
                      <NativeSelect
                        id="kb-column-owner"
                        className="w-full"
                        value={col.owner ?? "agent"}
                        onChange={(e) =>
                          update(selectedIndex, {
                            owner: e.target.value as "agent" | "user",
                          })
                        }
                      >
                        <NativeSelectOption value="agent">
                          An agent
                        </NativeSelectOption>
                        <NativeSelectOption value="user">Me</NativeSelectOption>
                      </NativeSelect>
                    </div>
                    {mine ? null : (
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <Label htmlFor="kb-column-agent">Agent</Label>
                        <NativeSelect
                          id="kb-column-agent"
                          className="w-full"
                          value={col.agentName ?? ""}
                          onChange={(e) =>
                            update(selectedIndex, {
                              agentName: e.target.value || null,
                            })
                          }
                        >
                          <NativeSelectOption value="">
                            North Star (default)
                          </NativeSelectOption>
                          {col.agentName &&
                          !agents.some(
                            (agent) =>
                              (agent.ref ?? agent.name) === col.agentName
                          ) ? (
                            <NativeSelectOption value={col.agentName}>
                              {col.agentName}
                            </NativeSelectOption>
                          ) : null}
                          {agents.map((agent) => (
                            <NativeSelectOption
                              key={agent.ref ?? agent.name}
                              value={agent.ref ?? agent.name}
                            >
                              {agent.label || agent.name}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                    )}
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="kb-column-instructions">
                        {mine ? "What you need to do" : "Instructions"}
                      </Label>
                      <Textarea
                        id="kb-column-instructions"
                        className="min-h-36"
                        rows={6}
                        placeholder={
                          mine
                            ? "Shown on the card while it waits for you, e.g. deploy to staging and smoke-test it."
                            : "What should the agent do to an issue in this column?"
                        }
                        value={col.instructions ?? ""}
                        onChange={(e) =>
                          update(selectedIndex, {
                            instructions: e.target.value,
                          })
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        {mine
                          ? col.command?.trim()
                            ? "No agent runs here. Each card that enters runs your command below."
                            : "No agent runs here. The card waits until you mark it done."
                          : "Entering this column runs its agent. Leave instructions empty for no agent run."}{" "}
                        Use the card&apos;s values with{" "}
                        {placeholderList(INSTRUCTION_PLACEHOLDERS)}, e.g. plan-
                        {"{{id}}"}.md.
                      </p>
                    </div>
                    {mine ? (
                      <div className="flex flex-col gap-4 rounded-lg border p-4">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="kb-column-command">Command</Label>
                          <Textarea
                            id="kb-column-command"
                            className="font-mono text-xs"
                            rows={3}
                            placeholder="Optional, e.g. npm run deploy:staging"
                            value={col.command ?? ""}
                            onChange={(e) =>
                              update(selectedIndex, {
                                command: e.target.value,
                              })
                            }
                          />
                          <p className="text-xs text-muted-foreground">
                            Runs in the card&apos;s working folder. Exit code 0
                            counts as passed; anything else as failed (use
                            outcomes named &quot;passed&quot; and
                            &quot;failed&quot; to route them). Use the
                            card&apos;s values with{" "}
                            {placeholderList(COMMAND_PLACEHOLDERS)}, e.g.{" "}
                            <code>./script.sh --ticket-id {"{{id}}"}</code>.
                            They go in quoted, so don&apos;t add quotes. They
                            are also in KANBAN_ITEM_ID, KANBAN_ITEM_TITLE,
                            KANBAN_ITEM_URL, KANBAN_BRANCH, KANBAN_CARD_ID and
                            KANBAN_WORKSPACE.
                          </p>
                        </div>
                        <div className="flex min-w-0 flex-col gap-1.5">
                          <Label htmlFor="kb-column-timeout">Time limit</Label>
                          <NativeSelect
                            id="kb-column-timeout"
                            className="w-full"
                            disabled={!col.command?.trim()}
                            value={String(col.commandTimeoutMs ?? "off")}
                            onChange={(e) =>
                              update(selectedIndex, {
                                commandTimeoutMs:
                                  e.target.value === "off"
                                    ? null
                                    : Number(e.target.value),
                              })
                            }
                          >
                            <NativeSelectOption value="off">
                              Off (runs until it finishes)
                            </NativeSelectOption>
                            {COMMAND_TIMEOUT_MINUTES.map((m) => (
                              <NativeSelectOption
                                key={m}
                                value={String(m * 60_000)}
                              >
                                {m} minutes
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </div>
                      </div>
                    ) : null}
                    {mine ? null : (
                      <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="kb-column-approval">
                            Wait for my approval
                          </Label>
                          <p
                            id="kb-column-approval-description"
                            className="text-xs text-muted-foreground"
                          >
                            {col.gate === "human"
                              ? "Keep the issue here until you review and approve the result."
                              : "Move on automatically when the agent finishes."}
                          </p>
                        </div>
                        <Switch
                          id="kb-column-approval"
                          aria-describedby="kb-column-approval-description"
                          checked={col.gate === "human"}
                          onCheckedChange={(checked) =>
                            update(selectedIndex, {
                              gate: checked ? "human" : "agent",
                            })
                          }
                        />
                      </div>
                    )}
                    {notifications ? null : (
                      <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="kb-column-notify">
                            Notify when a card finishes here
                          </Label>
                          <p
                            id="kb-column-notify-description"
                            className="text-xs text-muted-foreground"
                          >
                            Board notifications are off, so only columns with
                            this on notify.
                          </p>
                        </div>
                        <Switch
                          id="kb-column-notify"
                          aria-describedby="kb-column-notify-description"
                          checked={!!col.notify}
                          onCheckedChange={(notify) =>
                            update(selectedIndex, { notify })
                          }
                        />
                      </div>
                    )}
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="kb-column-wip">
                        WIP limit (cards working here at once)
                      </Label>
                      <div className="flex items-center gap-2">
                        <Input
                          id="kb-column-wip"
                          type="number"
                          min={1}
                          max={MAX_WIP_LIMIT}
                          placeholder="No limit"
                          className="w-32"
                          aria-describedby="kb-column-wip-note"
                          value={col.wipLimit ?? ""}
                          onChange={(e) =>
                            update(selectedIndex, {
                              wipLimit: e.target.value
                                ? Number(e.target.value)
                                : null,
                            })
                          }
                        />
                        <span
                          id="kb-column-wip-note"
                          className="text-xs text-muted-foreground"
                        >
                          1–{MAX_WIP_LIMIT}. A board runs at most{" "}
                          {MAX_WIP_LIMIT} agents at once.
                        </span>
                      </div>
                    </div>
                    <fieldset className="flex flex-col gap-3">
                      <legend className="mb-2 text-sm font-medium">
                        Entry gate
                      </legend>
                      <p
                        id="kb-column-gate-description"
                        className="text-xs text-muted-foreground"
                      >
                        When the board moves a card here, it waits until the
                        tracker item matches, checked after each sync. Fill in
                        states, tags, or both. Leave both empty to start right
                        away. Cards you move here yourself skip the gate.
                      </p>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="kb-column-gate-states">
                            When the state is (comma-separated)
                          </Label>
                          <Input
                            id="kb-column-gate-states"
                            aria-describedby="kb-column-gate-description"
                            value={col.gateStates ?? ""}
                            onChange={(e) =>
                              update(selectedIndex, {
                                gateStates: e.target.value,
                              })
                            }
                          />
                        </div>
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor="kb-column-gate-tags">
                            And it has a tag (comma-separated)
                          </Label>
                          <Input
                            id="kb-column-gate-tags"
                            aria-describedby="kb-column-gate-description"
                            value={col.gateTags ?? ""}
                            onChange={(e) =>
                              update(selectedIndex, {
                                gateTags: e.target.value,
                              })
                            }
                          />
                        </div>
                      </div>
                    </fieldset>
                    <OutcomesEditor
                      outcomes={col.outcomes ?? []}
                      columns={columns}
                      self={col.sortId}
                      onChange={(outcomes) =>
                        update(selectedIndex, { outcomes })
                      }
                    />
                    {col.actions?.length ? (
                      <div className="flex flex-col gap-1.5">
                        <Label>Tracker actions</Label>
                        <ul className="flex flex-col gap-1.5">
                          {col.actions.map((a) => (
                            <li
                              key={`${a.phase}:${a.name}`}
                              className="flex flex-col gap-0.5 rounded-md border p-2 text-xs"
                            >
                              <span className="font-medium">
                                {a.name}{" "}
                                <span className="font-normal text-muted-foreground">
                                  on {a.phase}
                                  {a.when?.length
                                    ? ` when ${a.when.join(" or ")}`
                                    : ""}
                                </span>
                              </span>
                              <span className="font-mono break-all text-muted-foreground">
                                {a.command ??
                                  `${a.tool} ${JSON.stringify(a.args ?? {})}`}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="text-xs text-muted-foreground">
                          Ask the agent to add or change actions.
                        </p>
                      </div>
                    ) : null}
                    <p
                      className={cn(
                        "text-xs text-muted-foreground",
                        occupied && "text-foreground"
                      )}
                    >
                      {occupied
                        ? "This column contains issues and cannot be removed."
                        : "Cards start in Inbox and move through these columns in order."}
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Add a column to configure its agent and instructions.
                  </p>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
        <DialogFooter className="m-0 shrink-0 px-6">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
