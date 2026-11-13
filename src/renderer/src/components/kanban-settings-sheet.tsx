import { useEffect, useState } from "react"
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react"
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
import type {
  KanbanBoardGraph,
  KanbanColumnInput,
  KanbanIntakeFilter,
} from "../../../shared/kanban"

const splitTags = (text: string) =>
  text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)

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
  const [columns, setColumns] = useState<
    (KanbanColumnInput & { sortId: string })[]
  >(
    graph.columns.map(({ id, name, agentName, instructions, gate }) => ({
      sortId: id,
      id,
      name,
      agentName,
      instructions,
      gate,
    }))
  )
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [saving, setSaving] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const col = columns[selectedIndex]
  const occupied =
    !!col?.id && graph.cards.some((card) => card.columnId === col.id)

  useEffect(() => {
    void window.cowork.agents
      .list(board.workspace ?? undefined)
      .then(setAgents)
      .catch(() => setAgents([]))
  }, [board.workspace])

  const update = (i: number, patch: Partial<KanbanColumnInput>) =>
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
    const filter: KanbanIntakeFilter = {
      tags: splitTags(tags),
      match,
      excludeTags: splitTags(exclude),
      assignee:
        assignee === "user"
          ? { mode: "user", user: user.trim() }
          : { mode: assignee },
      ...(query.trim() ? { query: query.trim() } : {}),
    }
    setSaving(true)
    try {
      const result = await window.cowork.kanban.saveSettings(board.id, {
        name,
        filter,
        syncIntervalMs: Math.max(1, Number(minutes) || 5) * 60_000,
        columns: columns.map(({ sortId, ...column }) => column),
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
          <DialogDescription>{board.name}</DialogDescription>
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
            </div>
          </TabsContent>
          <TabsContent
            value="columns"
            className="min-h-0 overflow-y-auto border-t"
          >
            <div className="flex min-h-full flex-col sm:flex-row">
              <nav
                aria-label="Board columns"
                className="flex shrink-0 flex-col gap-1 border-b bg-muted/30 p-3 sm:w-48 sm:border-r sm:border-b-0"
              >
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  Column order
                </p>
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
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
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
              </nav>
              <div className="min-w-0 flex-1 p-6">
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
                          (agent) => (agent.ref ?? agent.name) === col.agentName
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
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="kb-column-instructions">
                        Instructions
                      </Label>
                      <Textarea
                        id="kb-column-instructions"
                        className="min-h-36"
                        rows={6}
                        placeholder="What should the agent do to an issue in this column?"
                        value={col.instructions ?? ""}
                        onChange={(e) =>
                          update(selectedIndex, {
                            instructions: e.target.value,
                          })
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        Entering this column runs its agent. Leave instructions
                        empty for no agent run.
                      </p>
                    </div>
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
