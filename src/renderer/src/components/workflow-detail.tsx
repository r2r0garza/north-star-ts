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
import type { AgentSummary, LlmSettings } from "@/types"
import {
  effortLabel,
  effortOrDefault,
  type ReasoningEffort,
} from "../../../shared/reasoning-effort"
import type { SkillSummary } from "../../../preload"

import type {
  WorkflowDefinition,
  WorkflowStep,
} from "../../../shared/workflows"

// Effort levels the resolved account/model accepts (empty: no effort control).
function useEffortLevels(accountId: string | null, modelId: string | null) {
  const [levels, setLevels] = useState<ReasoningEffort[]>([])
  useEffect(() => {
    setLevels([])
    if (!accountId || !modelId) return
    let cancelled = false
    void window.cowork.providers
      .effortLevels(accountId, modelId)
      .then((found) => !cancelled && setLevels(found))
    return () => {
      cancelled = true
    }
  }, [accountId, modelId])
  return levels
}

// Renders nothing when the model has no levels.
function EffortSelect({
  id,
  label,
  levels,
  value,
  onChange,
}: {
  id: string
  label: string
  levels: ReasoningEffort[]
  value: ReasoningEffort | null | undefined
  onChange: (effort: ReasoningEffort | null) => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  if (!levels.length) return null
  const items = levels.map((level) => ({
    value: level,
    label: effortLabel(level),
  }))
  // Unset shows the level requests use (medium when listed), as the composer does.
  const shown = effortOrDefault(value, levels)
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Combobox
        items={items}
        value={items.find((item) => item.value === shown) ?? null}
        isItemEqualToValue={(a, b) => a?.value === b?.value}
        onValueChange={(item) => item && onChange(item.value)}
      >
        <ComboboxTrigger
          ref={trigger}
          id={id}
          className="flex h-9 w-full min-w-0 items-center justify-between gap-2 overflow-hidden rounded-lg border border-input px-3 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ComboboxValue>
            {(item: { label: string } | null) => (
              <span className="truncate">{item?.label}</span>
            )}
          </ComboboxValue>
        </ComboboxTrigger>
        <ComboboxContent anchor={trigger} className="min-w-48">
          <ComboboxInput placeholder="Search effort…" showTrigger={false} />
          <ComboboxEmpty>No levels found.</ComboboxEmpty>
          <ComboboxList>
            <ComboboxCollection>
              {(item: { value: string; label: string }) => (
                <ComboboxItem key={item.value} value={item}>
                  {item.label}
                </ComboboxItem>
              )}
            </ComboboxCollection>
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  )
}

// Origins are stored normalized (scheme://host[:port]) so the runtime check is exact.
function parseOrigins(text: string) {
  const origins: string[] = []
  const invalid: string[] = []
  for (const line of text.split(/\s+/)) {
    if (!line) continue
    try {
      const origin = new URL(line).origin
      if (origin === "null") throw new Error()
      if (!origins.includes(origin)) origins.push(origin)
    } catch {
      invalid.push(line)
    }
  }
  return { origins, invalid }
}

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
  defaultLlm,
  initiallyOpen,
  electronUnavailable,
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
  defaultLlm: LlmSettings | null
  initiallyOpen: boolean
  electronUnavailable: string | null
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
  // Null fields resolve like the runtime: global default; an unset validator model reuses the worker's.
  const workerAccountId = step.accountId ?? defaultLlm?.activeAccountId ?? null
  const workerModelId = step.modelId ?? defaultLlm?.activeModelId ?? null
  const validatorSelected = Boolean(
    step.validatorAccountId || step.validatorModelId
  )
  const workerLevels = useEffortLevels(workerAccountId, workerModelId)
  const validatorLevels = useEffortLevels(
    validatorSelected
      ? (step.validatorAccountId ?? defaultLlm?.activeAccountId ?? null)
      : workerAccountId,
    validatorSelected
      ? (step.validatorModelId ?? defaultLlm?.activeModelId ?? null)
      : workerModelId
  )
  const shownEffort = effortOrDefault(step.effort, workerLevels)
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
                  {shownEffort ? ` - ${effortLabel(shownEffort)} effort` : ""}
                  {step.validateCompletion ? " / Completion check on" : ""}
                  {step.browser ? " / Browser" : ""}
                  {step.electron ? " / Electron" : ""}
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
                rows={10}
                value={step.instructions}
                onBlur={onSave}
                onChange={(event) =>
                  onChange({ ...step, instructions: event.target.value })
                }
                placeholder="What should this step do?"
                className="field-sizing-fixed overflow-y-auto leading-relaxed"
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
                    // A level picked for the old model may not exist on the new one.
                    const efforts = {
                      effort: null,
                      ...(validatorSelected ? {} : { validatorEffort: null }),
                    }
                    if (!item) {
                      onChange({
                        ...step,
                        ...efforts,
                        accountId: null,
                        modelId: null,
                      })
                    } else {
                      const separator = item.value.indexOf("::")
                      if (separator >= 0)
                        onChange({
                          ...step,
                          ...efforts,
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
              <EffortSelect
                id={`${step.id}-effort`}
                label="Effort"
                levels={workerLevels}
                value={step.effort}
                onChange={(effort) => {
                  onChange({ ...step, effort })
                  onSave()
                }}
              />
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
                <span>Browser and apps</span>
                <span className="text-xs text-muted-foreground">
                  {[step.browser && "Browser", step.electron && "Electron"]
                    .filter(Boolean)
                    .join(" + ") || "Off"}{" "}
                  · Configure
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor={`${step.id}-browser`}>Agent browser</Label>
                  <Switch
                    id={`${step.id}-browser`}
                    checked={step.browser ?? false}
                    onCheckedChange={(checked) => {
                      onChange({ ...step, browser: checked })
                      onSave()
                    }}
                  />
                </div>
                {step.browser && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor={`${step.id}-origins`}>
                        Allowed origins
                      </Label>
                      <Textarea
                        id={`${step.id}-origins`}
                        rows={3}
                        placeholder={"http://localhost:5173\nhttps://staging.example.com"}
                        defaultValue={(step.allowedOrigins ?? []).join("\n")}
                        // Record on every keystroke like the other fields, so leaving the editor flushes it.
                        onChange={(event) =>
                          onChange({
                            ...step,
                            allowedOrigins: parseOrigins(event.target.value).origins,
                          })
                        }
                        onBlur={(event) => {
                          const { origins, invalid } = parseOrigins(
                            event.currentTarget.value
                          )
                          if (invalid.length)
                            toast.error(`Not a valid origin: ${invalid.join(", ")}`)
                          event.currentTarget.value = origins.join("\n")
                          onSave()
                        }}
                      />
                      {!step.allowedOrigins?.length && (
                        <p className="text-xs text-destructive">
                          No origins yet: the step can't open any page.
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        One per line. The step can open only these origins;
                        redirects and links elsewhere are blocked, and new
                        windows are refused. Local dev servers must be listed
                        too.
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor={`${step.id}-evaluate`}>
                        Allow page JavaScript (browser_evaluate)
                      </Label>
                      <Switch
                        id={`${step.id}-evaluate`}
                        checked={step.browserEvaluate ?? false}
                        onCheckedChange={(checked) => {
                          onChange({ ...step, browserEvaluate: checked })
                          onSave()
                        }}
                      />
                    </div>
                  </>
                )}
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor={`${step.id}-electron`}>
                    Electron app control
                  </Label>
                  <Switch
                    id={`${step.id}-electron`}
                    checked={step.electron ?? false}
                    disabled={!!electronUnavailable && !step.electron}
                    onCheckedChange={(checked) => {
                      onChange({ ...step, electron: checked })
                      onSave()
                    }}
                  />
                </div>
                {electronUnavailable && (
                  <p className="text-xs text-muted-foreground">
                    {electronUnavailable}
                  </p>
                )}
                {(step.browser || step.electron) && (
                  <>
                    <div className="flex items-center justify-between gap-4">
                      <Label htmlFor={`${step.id}-consequential`}>
                        Allow consequential actions
                      </Label>
                      <Switch
                        id={`${step.id}-consequential`}
                        checked={step.allowConsequential ?? false}
                        onCheckedChange={(checked) => {
                          onChange({ ...step, allowConsequential: checked })
                          onSave()
                        }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Runs are unattended. When on, the step can delete,
                      submit, send, purchase or publish on the allowed origins
                      and in launched apps without asking anyone. Off blocks
                      those actions.
                    </p>
                  </>
                )}
              </CollapsibleContent>
            </Collapsible>
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
                              validatorEffort: null,
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
                      <EffortSelect
                        id={`${step.id}-validator-effort`}
                        label="Validator effort"
                        levels={validatorLevels}
                        value={step.validatorEffort}
                        onChange={(validatorEffort) => {
                          onChange({ ...step, validatorEffort })
                          onSave()
                        }}
                      />
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
  const [defaultLlm, setDefaultLlm] = useState<LlmSettings | null>(null)
  const systemAgentName = window.cowork.system().mainAgentName
  useEffect(() => {
    void window.cowork.providers
      .getDefault()
      .then(setDefaultLlm, () => toast.error("Could not load default model"))
    void window.cowork.providers
      .listWithModels()
      .then(setModelGroups, () => toast.error("Could not load models"))
    void window.cowork.agents
      .list()
      .then(setAgents, () => toast.error("Could not load agents"))
    void window.cowork.skills
      .list()
      .then(setSkills, () => toast.error("Could not load skills"))
    // Same conditions chat uses to offer Electron tools (plan 119).
    void Promise.all([
      window.cowork.settings.getBrowser(),
      window.cowork.settings.getExecution(),
    ]).then(([browser, execution]) =>
      setElectronUnavailable(
        !browser.electronApps
          ? "Electron app control is off in Settings → Browser."
          : execution.backend !== "local" ||
              execution.localProfile === "read-only"
            ? "Electron app control needs a local, writable execution profile."
            : null
      )
    )
  }, [])

  const [newStepId, setNewStepId] = useState<string | null>(null)
  const [electronUnavailable, setElectronUnavailable] = useState<
    string | null
  >(null)
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
                      defaultLlm={defaultLlm}
                      electronUnavailable={electronUnavailable}
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
            <p className="mt-1 ml-6 text-xs text-muted-foreground">
              The objective prefilled when starting a run, and whether this
              workflow appears in the conversation sidebar.
            </p>
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
