import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ChevronRight, GripVertical, Plus, Trash2 } from "lucide-react"
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
import { ScreenHeader } from "@/components/screen-header"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Combobox,
  ComboboxContent,
  ComboboxCollection,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox"
import type { AccountWithModels } from "../../../main/ipc/provider-handlers"
import type { AgentSummary } from "@/types"
import type { SkillSummary } from "../../../preload"

import type {
  WorkflowDefinition,
  WorkflowStep,
} from "../../../shared/workflows"

function SortableStep({
  step,
  index,
  onChange,
  onDelete,
  onSave,
  modelGroups,
  agents,
  skills,
  systemAgentName,
  initiallyOpen,
}: {
  step: WorkflowStep
  index: number
  onChange: (step: WorkflowStep) => void
  onDelete: () => void
  onSave: () => void
  modelGroups: AccountWithModels[]
  agents: AgentSummary[]
  skills: SkillSummary[]
  systemAgentName: string
  initiallyOpen: boolean
}) {
  const [open, setOpen] = useState(initiallyOpen)
  const titleInput = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!initiallyOpen) return
    titleInput.current?.focus()
    titleInput.current?.scrollIntoView?.({ block: "nearest" })
  }, [initiallyOpen])
  const modelTrigger = useRef<HTMLButtonElement>(null)
  const agentTrigger = useRef<HTMLButtonElement>(null)
  const skillTrigger = useRef<HTMLButtonElement>(null)
  const skillOptions = [
    { value: "", label: "Automatic (no assigned skill)" },
    ...skills.map((skill) => ({ value: skill.name, label: skill.name })),
  ]
  const groups = modelGroups
    .filter((account) => account.models.length > 0)
    .map(({ account, models }) => ({
      value: account.id,
      label: account.displayName,
      items: models.map((model) => ({
        value: `${account.id}::${model.modelId}`,
        label: model.modelName?.trim() || model.modelId,
      })),
    }))
  const selectedModel =
    groups
      .flatMap((group) => group.items)
      .find((item) => item.value === `${step.accountId}::${step.modelId}`) ??
    (step.modelId
      ? { value: `${step.accountId}::${step.modelId}`, label: step.modelId }
      : null)
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id })

  const selectedAgent = agents.find(
    (agent) => (agent.ref ?? agent.name) === step.agentName
  )
  const agentLabel =
    selectedAgent?.label ??
    selectedAgent?.name ??
    step.agentName ??
    systemAgentName

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1 : undefined,
      }}
      className="relative rounded-lg border bg-card"
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2 p-2">
          <Button
            ref={setActivatorNodeRef}
            variant="ghost"
            size="icon-sm"
            className="cursor-grab touch-none active:cursor-grabbing"
            {...attributes}
            {...listeners}
            aria-describedby="step-reorder-help"
            title="Drag to reorder, or press Space, arrow keys, then Space"
            aria-label={`Reorder step ${index + 1}: ${step.title || "Untitled step"}`}
          >
            <GripVertical className="size-4 text-muted-foreground" />
          </Button>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              id={`step-toggle-${step.id}`}
              aria-label={`${index + 1}. ${step.title || "Untitled step"}`}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ChevronRight
                className={`size-4 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
              />
              <span className="shrink-0 text-xs text-muted-foreground">
                {index + 1}.
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {step.title || "Untitled step"}
                </span>
                <span
                  aria-hidden="true"
                  className="block truncate text-xs text-muted-foreground"
                >
                  {agentLabel} / {selectedModel?.label ?? "Default model"}
                  {step.validateCompletion ? " / Completion check on" : ""}
                </span>
              </span>
            </button>
          </CollapsibleTrigger>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Delete step ${index + 1}: ${step.title || "Untitled step"}`}
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        <CollapsibleContent>
          <div className="space-y-4 border-t p-4">
            <div className="space-y-2">
              <Label htmlFor={`${step.id}-title`}>Title</Label>
              <Input
                ref={titleInput}
                id={`${step.id}-title`}
                value={step.title}
                onBlur={onSave}
                onChange={(event) =>
                  onChange({ ...step, title: event.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${step.id}-instructions`}>Instructions</Label>
              <Textarea
                id={`${step.id}-instructions`}
                value={step.instructions}
                onBlur={onSave}
                onChange={(event) =>
                  onChange({ ...step, instructions: event.target.value })
                }
                placeholder="What should this step do?"
                className="min-h-60 resize-y overflow-y-auto leading-relaxed"
              />
            </div>
            <h4 className="font-medium">Execution</h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <Label htmlFor={`${step.id}-model`}>Model</Label>
                <Combobox
                  items={groups}
                  value={selectedModel}
                  isItemEqualToValue={(a, b) => a?.value === b?.value}
                  onValueChange={(item) => {
                    if (!item) {
                      onChange({ ...step, accountId: null, modelId: null })
                    } else {
                      const separator = item.value.indexOf("::")
                      if (separator >= 0)
                        onChange({
                          ...step,
                          accountId: item.value.slice(0, separator),
                          modelId: item.value.slice(separator + 2),
                        })
                    }
                    onSave()
                  }}
                >
                  <ComboboxTrigger
                    ref={modelTrigger}
                    id={`${step.id}-model`}
                    className="flex h-9 w-full min-w-0 items-center justify-between gap-2 overflow-hidden rounded-lg border border-input px-3 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <ComboboxValue placeholder="Use default model">
                      {(value: { label: string } | null) => (
                        <span className="truncate">
                          {value?.label ?? "Use default model"}
                        </span>
                      )}
                    </ComboboxValue>
                  </ComboboxTrigger>
                  <ComboboxContent anchor={modelTrigger} className="min-w-72">
                    <ComboboxInput
                      placeholder="Search models…"
                      showTrigger={false}
                    />
                    <ComboboxEmpty>No models found.</ComboboxEmpty>
                    <ComboboxList>
                      {(group: {
                        value: string
                        label: string
                        items: { value: string; label: string }[]
                      }) => (
                        <ComboboxGroup key={group.value} items={group.items}>
                          <ComboboxLabel>{group.label}</ComboboxLabel>
                          <ComboboxCollection>
                            {(model: { value: string; label: string }) => (
                              <ComboboxItem key={model.value} value={model}>
                                {model.label}
                              </ComboboxItem>
                            )}
                          </ComboboxCollection>
                        </ComboboxGroup>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor={`${step.id}-agent`}>Agent</Label>
                <Combobox
                  items={[
                    { value: "", label: systemAgentName },
                    ...agents.map((agent) => ({
                      value: agent.ref ?? agent.name,
                      label: agent.label ?? agent.name,
                    })),
                  ]}
                  value={
                    [
                      { value: "", label: systemAgentName },
                      ...agents.map((agent) => ({
                        value: agent.ref ?? agent.name,
                        label: agent.label ?? agent.name,
                      })),
                    ].find(
                      (agent) => agent.value === (step.agentName ?? "")
                    ) ?? {
                      value: step.agentName ?? "",
                      label: step.agentName ?? systemAgentName,
                    }
                  }
                  isItemEqualToValue={(a, b) => a?.value === b?.value}
                  onValueChange={(agent) => {
                    onChange({
                      ...step,
                      agentName: agent?.value || undefined,
                    })
                    onSave()
                  }}
                >
                  <ComboboxTrigger
                    ref={agentTrigger}
                    id={`${step.id}-agent`}
                    className="flex h-9 w-full min-w-0 items-center justify-between gap-2 overflow-hidden rounded-lg border border-input px-3 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <ComboboxValue>
                      {(value: { label: string } | null) => (
                        <span className="truncate">
                          {value?.label ?? systemAgentName}
                        </span>
                      )}
                    </ComboboxValue>
                  </ComboboxTrigger>
                  <ComboboxContent anchor={agentTrigger} className="min-w-64">
                    <ComboboxInput
                      placeholder="Search agents…"
                      showTrigger={false}
                    />
                    <ComboboxEmpty>No agents found.</ComboboxEmpty>
                    <ComboboxList>
                      <ComboboxCollection>
                        {(agent: { value: string; label: string }) => (
                          <ComboboxItem
                            key={agent.value || "__system__"}
                            value={agent}
                          >
                            {agent.label}
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${step.id}-skill`}>Skill</Label>
              <Combobox
                items={skillOptions}
                value={
                  skillOptions.find(
                    (item) => item.value === (step.skillName ?? "")
                  ) ?? {
                    value: step.skillName!,
                    label: step.skillName!,
                  }
                }
                isItemEqualToValue={(a, b) => a?.value === b?.value}
                onValueChange={(skill) => {
                  onChange({ ...step, skillName: skill?.value || undefined })
                  onSave()
                }}
              >
                <ComboboxTrigger
                  ref={skillTrigger}
                  id={`${step.id}-skill`}
                  className="flex h-9 w-full min-w-0 items-center justify-between gap-2 overflow-hidden rounded-lg border border-input px-3 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <ComboboxValue>
                    {(value: { label: string } | null) => (
                      <span className="truncate">
                        {value?.label ?? "Automatic (no assigned skill)"}
                      </span>
                    )}
                  </ComboboxValue>
                </ComboboxTrigger>
                <ComboboxContent anchor={skillTrigger} className="min-w-64">
                  <ComboboxInput
                    placeholder="Search skills…"
                    showTrigger={false}
                  />
                  <ComboboxEmpty>No skills found.</ComboboxEmpty>
                  <ComboboxList>
                    {(skill: { value: string; label: string }) => (
                      <ComboboxItem
                        key={skill.value || "__automatic__"}
                        value={skill}
                      >
                        {skill.label}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              <p className="text-xs text-muted-foreground">
                Without an assigned skill, the agent may choose any relevant
                skills for this step.
              </p>
            </div>
            <Collapsible className="space-y-3 border-t pt-4">
              <CollapsibleTrigger className="flex w-full items-center justify-between text-left font-medium">
                <span>Completion check</span>
                <span className="text-xs text-muted-foreground">
                  {step.validateCompletion ? "On" : "Off"} · Configure
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor={`${step.id}-validate`}>
                    Validate step completion
                  </Label>
                  <Switch
                    id={`${step.id}-validate`}
                    checked={step.validateCompletion ?? false}
                    onCheckedChange={(checked) => {
                      onChange({ ...step, validateCompletion: checked })
                      onSave()
                    }}
                  />
                </div>
                {step.validateCompletion && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor={`${step.id}-correction-loops`}>
                        Maximum correction loops
                      </Label>
                      <Input
                        id={`${step.id}-correction-loops`}
                        type="number"
                        min={0}
                        max={10}
                        step={1}
                        defaultValue={step.maxCorrectionLoops ?? 2}
                        key={step.maxCorrectionLoops ?? 2}
                        className="w-24"
                        onBlur={(event) => {
                          const value = event.currentTarget.valueAsNumber
                          if (
                            Number.isInteger(value) &&
                            value >= 0 &&
                            value <= 10
                          ) {
                            onChange({ ...step, maxCorrectionLoops: value })
                            onSave()
                          } else {
                            event.currentTarget.value = String(
                              step.maxCorrectionLoops ?? 2
                            )
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur()
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        The validator runs once initially, plus up to{" "}
                        {step.maxCorrectionLoops ?? 2} correction attempts.
                      </p>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="min-w-0 space-y-2">
                        <Label htmlFor={`${step.id}-validator-model`}>
                          Validator model
                        </Label>
                        <Combobox
                          items={groups}
                          value={
                            groups
                              .flatMap((group) => group.items)
                              .find(
                                (item) =>
                                  item.value ===
                                  `${step.validatorAccountId}::${step.validatorModelId}`
                              ) ??
                            (step.validatorModelId
                              ? {
                                  value: `${step.validatorAccountId}::${step.validatorModelId}`,
                                  label: step.validatorModelId,
                                }
                              : null)
                          }
                          isItemEqualToValue={(a, b) => a?.value === b?.value}
                          onValueChange={(item) => {
                            const separator = item?.value.indexOf("::") ?? -1
                            onChange({
                              ...step,
                              validatorAccountId:
                                separator >= 0
                                  ? item!.value.slice(0, separator)
                                  : null,
                              validatorModelId:
                                separator >= 0
                                  ? item!.value.slice(separator + 2)
                                  : null,
                            })
                            onSave()
                          }}
                        >
                          <ComboboxTrigger
                            id={`${step.id}-validator-model`}
                            className="flex h-9 w-full items-center justify-between rounded-lg border border-input px-3 text-sm"
                          >
                            <ComboboxValue placeholder="Use default model" />
                          </ComboboxTrigger>
                          <ComboboxContent className="min-w-72">
                            <ComboboxInput
                              placeholder="Search models…"
                              showTrigger={false}
                            />
                            <ComboboxList>
                              {(group: {
                                value: string
                                label: string
                                items: { value: string; label: string }[]
                              }) => (
                                <ComboboxGroup
                                  key={group.value}
                                  items={group.items}
                                >
                                  <ComboboxLabel>{group.label}</ComboboxLabel>
                                  <ComboboxCollection>
                                    {(model: {
                                      value: string
                                      label: string
                                    }) => (
                                      <ComboboxItem
                                        key={model.value}
                                        value={model}
                                      >
                                        {model.label}
                                      </ComboboxItem>
                                    )}
                                  </ComboboxCollection>
                                </ComboboxGroup>
                              )}
                            </ComboboxList>
                          </ComboboxContent>
                        </Combobox>
                      </div>
                      <div className="min-w-0 space-y-2">
                        <Label htmlFor={`${step.id}-validator-agent`}>
                          Validator agent
                        </Label>
                        <Combobox
                          items={[
                            { value: "", label: systemAgentName },
                            ...agents.map((agent) => ({
                              value: agent.ref ?? agent.name,
                              label: agent.label ?? agent.name,
                            })),
                          ]}
                          value={
                            [
                              { value: "", label: systemAgentName },
                              ...agents.map((agent) => ({
                                value: agent.ref ?? agent.name,
                                label: agent.label ?? agent.name,
                              })),
                            ].find(
                              (agent) =>
                                agent.value === (step.validatorAgentName ?? "")
                            ) ?? {
                              value: step.validatorAgentName ?? "",
                              label: step.validatorAgentName ?? systemAgentName,
                            }
                          }
                          isItemEqualToValue={(a, b) => a?.value === b?.value}
                          onValueChange={(agent) => {
                            onChange({
                              ...step,
                              validatorAgentName: agent?.value || null,
                            })
                            onSave()
                          }}
                        >
                          <ComboboxTrigger
                            id={`${step.id}-validator-agent`}
                            className="flex h-9 w-full items-center justify-between rounded-lg border border-input px-3 text-sm"
                          >
                            <ComboboxValue />
                          </ComboboxTrigger>
                          <ComboboxContent className="min-w-64">
                            <ComboboxInput
                              placeholder="Search agents…"
                              showTrigger={false}
                            />
                            <ComboboxList>
                              <ComboboxCollection>
                                {(agent: { value: string; label: string }) => (
                                  <ComboboxItem
                                    key={agent.value || "__system__"}
                                    value={agent}
                                  >
                                    {agent.label}
                                  </ComboboxItem>
                                )}
                              </ComboboxCollection>
                            </ComboboxList>
                          </ComboboxContent>
                        </Combobox>
                      </div>
                    </div>
                  </>
                )}
              </CollapsibleContent>
            </Collapsible>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

export function WorkflowDetail({
  workflow,
  onChange,
  onBack,
  onClose,
}: {
  workflow: WorkflowDefinition
  onChange: (workflow: WorkflowDefinition) => void
  onBack: () => void
  onClose: () => void
}) {
  const [modelGroups, setModelGroups] = useState<AccountWithModels[]>([])
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const systemAgentName = window.cowork.system().mainAgentName
  useEffect(() => {
    void window.cowork.providers
      .listWithModels()
      .then(setModelGroups, () => toast.error("Could not load models"))
    void window.cowork.agents
      .list()
      .then(setAgents, () => toast.error("Could not load agents"))
    void window.cowork.skills
      .list()
      .then(setSkills, () => toast.error("Could not load skills"))
  }, [])

  const [newStepId, setNewStepId] = useState<string | null>(null)
  const [saveState, setSaveState] = useState("Saved")
  const latest = useRef(workflow)
  const saved = useRef(JSON.stringify(workflow))
  const queued = useRef(saved.current)
  const saves = useRef(Promise.resolve())
  const active = useRef(true)

  function change(updated: WorkflowDefinition) {
    latest.current = updated
    onChange(updated)
    setSaveState(
      JSON.stringify(updated) === saved.current ? "Saved" : "Unsaved changes"
    )
  }

  function save() {
    const snapshot = latest.current
    const serialized = JSON.stringify(snapshot)
    if (serialized === queued.current) return
    queued.current = serialized
    setSaveState("Saving…")
    saves.current = saves.current.then(async () => {
      if (!active.current) return
      try {
        await window.cowork.db.workflows.update(snapshot)
        saved.current = serialized
        if (active.current)
          setSaveState(
            JSON.stringify(latest.current) === serialized
              ? "Saved"
              : queued.current === JSON.stringify(latest.current)
                ? "Saving…"
                : "Unsaved changes"
          )
      } catch {
        if (queued.current === serialized) queued.current = saved.current
        if (active.current) setSaveState("Could not save")
        toast.error(
          "Could not save workflow. Your latest changes may be lost when this view closes."
        )
      }
    })
  }

  function commit(updated: WorkflowDefinition) {
    change(updated)
    save()
  }

  useEffect(() => {
    active.current = true
    const flush = () => {
      const snapshot = latest.current
      const serialized = JSON.stringify(snapshot)
      if (serialized === saved.current) return true
      const result = window.cowork.db.workflows.flush(snapshot)
      if (result.ok) {
        saved.current = serialized
        queued.current = serialized
      } else {
        toast.error(
          "Could not save workflow. Your latest changes may be lost when this view closes."
        )
      }
      return result.ok
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      active.current = false
      if (!flush()) {
        active.current = true
        event.preventDefault()
        event.returnValue = ""
      }
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => {
      active.current = false
      window.removeEventListener("beforeunload", beforeUnload)
      flush()
    }
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  return (
    <div
      data-slot="workflow-detail"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background pt-11 text-sm text-foreground"
    >
      <ScreenHeader
        title={workflow.name}
        onBack={onBack}
        backLabel="Back to library"
        onClose={onClose}
        trailing={
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span role="status" aria-live="polite">
              {saveState}
            </span>
            {saveState === "Could not save" && (
              <Button variant="outline" size="sm" onClick={save}>
                Retry
              </Button>
            )}
          </div>
        }
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
          <div>
            <div className="space-y-2">
              <Label htmlFor="workflow-title">Name</Label>
              <Input
                id="workflow-title"
                value={workflow.name}
                onBlur={save}
                onChange={(event) =>
                  change({ ...workflow, name: event.target.value })
                }
              />
            </div>
            <div className="mt-4 space-y-2">
              <Label htmlFor="workflow-description">Description</Label>
              <Textarea
                id="workflow-description"
                value={workflow.description}
                onBlur={save}
                onChange={(event) =>
                  change({ ...workflow, description: event.target.value })
                }
              />
            </div>
          </div>
          <section aria-label="Workflow steps" className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Steps</h3>
                <p id="step-reorder-help" className="sr-only">
                  Drag the handle to reorder. You can also use Space, arrow
                  keys, and Space again.
                </p>
              </div>
              <Button
                id="add-workflow-step"
                variant="outline"
                className="shrink-0"
                onClick={() => {
                  const id = crypto.randomUUID()
                  setNewStepId(id)
                  commit({
                    ...latest.current,
                    steps: [
                      ...latest.current.steps,
                      { id, title: "New step", instructions: "" },
                    ],
                  })
                }}
              >
                <Plus className="size-4" />
                Add step
              </Button>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={({ active, over }) => {
                if (!over || active.id === over.id) return
                const from = workflow.steps.findIndex(
                  (step) => step.id === active.id
                )
                const to = workflow.steps.findIndex(
                  (step) => step.id === over.id
                )
                if (from < 0 || to < 0) return
                commit({
                  ...workflow,
                  steps: arrayMove(workflow.steps, from, to),
                })
              }}
            >
              <SortableContext
                items={workflow.steps.map((step) => step.id)}
                strategy={verticalListSortingStrategy}
              >
                <ol className="space-y-3">
                  {workflow.steps.length === 0 && (
                    <li className="py-8 text-center text-muted-foreground">
                      Add your first step to start building this workflow.
                    </li>
                  )}
                  {workflow.steps.map((step, index) => (
                    <SortableStep
                      key={step.id}
                      step={step}
                      index={index}
                      initiallyOpen={newStepId === step.id}
                      onDelete={() => {
                        const previousId = workflow.steps[index - 1]?.id
                        const nextId = workflow.steps[index + 1]?.id
                        commit({
                          ...latest.current,
                          steps: latest.current.steps.filter(
                            (current) => current.id !== step.id
                          ),
                        })
                        let restored = false
                        toast("Step deleted", {
                          action: {
                            label: "Undo",
                            onClick: () => {
                              if (
                                restored ||
                                !active.current ||
                                latest.current.steps.some(
                                  (current) => current.id === step.id
                                )
                              )
                                return
                              restored = true
                              const steps = [...latest.current.steps]
                              const nextIndex = steps.findIndex(
                                (current) => current.id === nextId
                              )
                              const previousIndex = steps.findIndex(
                                (current) => current.id === previousId
                              )
                              const position =
                                nextIndex >= 0
                                  ? nextIndex
                                  : previousIndex >= 0
                                    ? previousIndex + 1
                                    : Math.min(index, steps.length)
                              steps.splice(position, 0, step)
                              setNewStepId(step.id)
                              commit({ ...latest.current, steps })
                            },
                          },
                        })
                        requestAnimationFrame(() => {
                          if (!active.current) return
                          const target =
                            document.getElementById(
                              `step-toggle-${nextId ?? previousId}`
                            ) ?? document.getElementById("add-workflow-step")
                          target?.focus()
                        })
                      }}
                      onSave={save}
                      modelGroups={modelGroups}
                      agents={agents}
                      skills={skills}
                      systemAgentName={systemAgentName}
                      onChange={(updated) =>
                        change({
                          ...workflow,
                          steps: workflow.steps.map((current) =>
                            current.id === updated.id ? updated : current
                          ),
                        })
                      }
                    />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
          </section>
          <Collapsible className="border-t pt-4">
            <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left font-medium">
              <ChevronRight className="size-4 group-data-[state=open]:rotate-90" />
              Run settings
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-4 space-y-2">
                <Label htmlFor="workflow-default-objective">
                  Default objective
                </Label>
                <p
                  id="objective-help"
                  className="text-xs text-muted-foreground"
                >
                  Prefills the objective when starting a run. You can change it
                  for each run.
                </p>
                <Textarea
                  aria-describedby="objective-help"
                  id="workflow-default-objective"
                  value={workflow.defaultObjective}
                  onBlur={save}
                  onChange={(event) =>
                    change({
                      ...workflow,
                      defaultObjective: event.target.value,
                    })
                  }
                />
              </div>
              <div className="mt-4 flex items-center justify-between gap-4">
                <Label htmlFor="workflow-view-in-sidebar">
                  Show in conversation sidebar
                </Label>
                {!workflow.defaultObjective.trim() ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex" tabIndex={0}>
                          <Switch
                            id="workflow-view-in-sidebar"
                            checked={
                              workflow.viewInConversationSidebar ?? false
                            }
                            disabled
                            onCheckedChange={(checked) =>
                              commit({
                                ...workflow,
                                viewInConversationSidebar: checked,
                              })
                            }
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Add a default objective to enable this option.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <Switch
                    id="workflow-view-in-sidebar"
                    checked={workflow.viewInConversationSidebar ?? false}
                    onCheckedChange={(checked) =>
                      commit({
                        ...workflow,
                        viewInConversationSidebar: checked,
                      })
                    }
                  />
                )}
              </div>
              {!workflow.defaultObjective.trim() && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Add a default objective to show this workflow in the
                  conversation sidebar.
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </ScrollArea>
    </div>
  )
}
