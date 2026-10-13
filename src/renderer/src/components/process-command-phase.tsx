import { useCallback, useEffect, useState } from "react"
import {
  CheckCircle2,
  CircleAlert,
  Loader2,
  Pencil,
  Play,
  Plus,
  Sparkles,
  SquareTerminal,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from "@/components/ui/autocomplete"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  COMMAND_OUTPUT_DEFAULT_BYTES,
  COMMAND_OUTPUT_MAX_BYTES,
  COMMAND_OUTPUT_MIN_BYTES,
  COMMAND_TIMEOUT_DEFAULT_MS,
  COMMAND_TIMEOUT_MAX_MS,
  SUGGESTED_CHECK_NAMES,
  commandOutcomeText,
  formatDuration,
  parseCheckName,
  parseCommandConfig,
  parseWorkspaceCheck,
} from "../../../shared/process-command"
import {
  SetupTerminal,
  watchSetupOutput,
} from "@/components/mission-control/setup-terminal"
import type {
  CommandTrial,
  EnvironmentFact,
  EnvironmentSetupRun,
  PhaseRunStatus,
  ProcessCommandConfig,
  ProcessCommandReceipt,
  ProcessPhase,
  ProcessPhaseKind,
  ResolvedProcessCommand,
  Workspace,
  WorkspaceCheck,
  WorkspaceChecks,
} from "@/types"

// Deterministic command phases (plan 104): the builder's execution-type control
// and command editor, the workspace-check editors used when a run starts and
// in Mission Control, and the run monitor's receipt view.

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+':\s*(\w*Error:\s*)?/,
    ""
  )
}

export function phaseKindOf(phase: ProcessPhase): ProcessPhaseKind {
  return phase.kind ?? (phase.subprocessId ? "subprocess" : "agent")
}

const KIND_LABELS: Record<ProcessPhaseKind, string> = {
  agent: "Agent",
  command: "Command",
  subprocess: "Sub-process",
}

// What switching `phase` to `next` throws away. Empty → no confirmation needed.
export function discardedBySwitch(
  phase: ProcessPhase,
  poolSize: number,
  next: ProcessPhaseKind
): string[] {
  const current = phaseKindOf(phase)
  if (current === next) return []
  const lost: string[] = []
  if (current === "command") lost.push("the saved command")
  if (current === "subprocess") lost.push("the sub-process it runs")
  if (next === "command") {
    if (poolSize > 0)
      lost.push(
        `its agent pool (${poolSize} ${poolSize === 1 ? "entry" : "entries"})`
      )
    if (phase.fanOut) lost.push("fan-out")
    if (phase.validator) lost.push("its validator")
    if (phase.proofStep) lost.push("the proof-step marker")
    if (phase.runtimeConfig && Object.keys(phase.runtimeConfig).length > 0)
      lost.push("its model runtime overrides")
  }
  return lost
}

// A confirmation dialog driven by a pending request. Returns the element to
// render and an `ask` that resolves true on confirm.
export function useConfirmDiscard(): [
  (title: string, items: string[]) => Promise<boolean>,
  React.ReactElement,
] {
  const [pending, setPending] = useState<{
    title: string
    items: string[]
    resolve: (ok: boolean) => void
  } | null>(null)
  const ask = (title: string, items: string[]) =>
    items.length === 0
      ? Promise.resolve(true)
      : new Promise<boolean>((resolve) => setPending({ title, items, resolve }))
  const settle = (ok: boolean) => {
    pending?.resolve(ok)
    setPending(null)
  }
  const element = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) settle(false)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.title}</AlertDialogTitle>
          <AlertDialogDescription>
            This removes {joinList(pending?.items ?? [])} from the phase. Runs
            that already finished keep their records.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => settle(true)}>
            Switch
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
  return [ask, element]
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

export function PhaseKindControl({
  value,
  allowSubprocess,
  onChange,
}: {
  value: ProcessPhaseKind
  allowSubprocess: boolean
  onChange: (next: ProcessPhaseKind) => void
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Runs</span>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as ProcessPhaseKind)}
      >
        <SelectTrigger
          size="sm"
          className="text-xs"
          aria-label="Phase execution type"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="agent">{KIND_LABELS.agent}</SelectItem>
          <SelectItem value="command">{KIND_LABELS.command}</SelectItem>
          {(allowSubprocess || value === "subprocess") && (
            <SelectItem value="subprocess">{KIND_LABELS.subprocess}</SelectItem>
          )}
        </SelectContent>
      </Select>
    </label>
  )
}

type CommandSource = ProcessCommandConfig["source"]

interface Draft {
  source: CommandSource
  check: string
  command: string
  cwd: string
  timeoutMinutes: string
  outputKiB: string
}

function draftOf(config: ProcessCommandConfig | null | undefined): Draft {
  return {
    // A new command phase names a workspace check: processes are reused
    // across workspaces, and a literal command is the exception.
    source: config?.source ?? "check",
    check: config?.source === "check" ? config.check : "",
    command: config?.source === "literal" ? config.command : "",
    cwd: config?.source === "literal" ? (config.cwd ?? "") : "",
    timeoutMinutes: String(
      (config?.timeoutMs ?? COMMAND_TIMEOUT_DEFAULT_MS) / 60_000
    ),
    outputKiB: String(
      (config?.maxOutputBytes ?? COMMAND_OUTPUT_DEFAULT_BYTES) / 1024
    ),
  }
}

// Parse the editor's fields into a config, or an error message.
export function configFromDraft(
  draft: Draft
): { config: ProcessCommandConfig } | { error: string } {
  const minutes = Number(draft.timeoutMinutes)
  const kib = Number(draft.outputKiB)
  if (!Number.isFinite(minutes) || minutes <= 0)
    return { error: "The timeout must be a positive number of minutes." }
  if (!Number.isFinite(kib) || kib <= 0)
    return { error: "The output limit must be a positive number of KiB." }
  const limits = {
    timeoutMs: Math.round(minutes * 60_000),
    maxOutputBytes: Math.round(kib * 1024),
  }
  try {
    return {
      config: parseCommandConfig(
        draft.source === "check"
          ? { source: "check", check: draft.check, ...limits }
          : {
              source: "literal",
              command: draft.command,
              cwd: draft.cwd,
              ...limits,
            }
      ),
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

function sameConfig(
  a: ProcessCommandConfig | null | undefined,
  b: ProcessCommandConfig
): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b)
}

// The command editor for a command phase. `saved` is the persisted config
// (null while switching an agent/sub-process phase over: nothing is stored
// until Save). A phase names a workspace check by default; a literal command
// is optional. An Ask AI proposal only fills the fields; it is never saved or
// run until the user saves it.
export function CommandPhaseEditor({
  phaseId,
  saved,
  onSave,
  onCancel,
}: {
  phaseId: string
  saved: ProcessCommandConfig | null | undefined
  onSave: (config: ProcessCommandConfig) => Promise<boolean>
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved))
  const [saving, setSaving] = useState(false)

  // Follow the saved value when it changes underneath (another save, reload).
  useEffect(() => {
    setDraft(draftOf(saved))
  }, [saved])

  const parsed = configFromDraft(draft)
  const dirty = "config" in parsed ? !sameConfig(saved, parsed.config) : true
  const typed =
    draft.source === "check" ? draft.check.trim() : draft.command.trim()
  const showError = typed !== "" && "error" in parsed

  async function save() {
    if (!("config" in parsed)) return
    setSaving(true)
    try {
      await onSave(parsed.config)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed p-2">
      <div
        role="radiogroup"
        aria-label="Command source"
        className="flex flex-wrap gap-1"
      >
        {(
          [
            ["check", "Workspace check"],
            ["literal", "Literal command"],
          ] as const
        ).map(([source, label]) => (
          <Button
            key={source}
            type="button"
            size="xs"
            role="radio"
            aria-checked={draft.source === source}
            variant={draft.source === source ? "secondary" : "ghost"}
            onClick={() => setDraft({ ...draft, source })}
          >
            {label}
          </Button>
        ))}
      </div>

      {draft.source === "check" ? (
        <>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">Check</span>
            <CheckNameInput
              value={draft.check}
              onChange={(check) => setDraft({ ...draft, check })}
              placeholder="test"
              label="Check name"
              className="w-44"
            />
          </label>
          <p className="text-[10px] text-muted-foreground">
            Each workspace says what this check runs (for example{" "}
            <code>pnpm test</code> in one project, <code>cargo test</code> in
            another). Starting a run asks for any check the workspace
            hasn&apos;t defined yet; there is no default.
          </p>
        </>
      ) : (
        <LiteralCommandFields
          phaseId={phaseId}
          draft={draft}
          onChange={setDraft}
        />
      )}

      <div className="flex flex-wrap items-end gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Timeout (min)</span>
          <Input
            type="number"
            min={1}
            max={COMMAND_TIMEOUT_MAX_MS / 60_000}
            value={draft.timeoutMinutes}
            onChange={(e) =>
              setDraft({ ...draft, timeoutMinutes: e.target.value })
            }
            aria-label="Timeout in minutes"
            className="h-7 w-20 text-xs"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Output limit (KiB)</span>
          <Input
            type="number"
            min={COMMAND_OUTPUT_MIN_BYTES / 1024}
            max={COMMAND_OUTPUT_MAX_BYTES / 1024}
            value={draft.outputKiB}
            onChange={(e) => setDraft({ ...draft, outputKiB: e.target.value })}
            aria-label="Output limit in KiB"
            className="h-7 w-24 text-xs"
          />
        </label>
      </div>
      {showError && (
        <p className="text-xs text-destructive" role="alert">
          {"error" in parsed ? parsed.error : ""}
        </p>
      )}
      <p className="text-[10px] text-muted-foreground">
        The command runs in the run&apos;s workspace with the configured
        execution backend. Exit code 0 completes the phase; anything else fails
        it. No model is involved when the process runs.
      </p>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="xs"
          onClick={save}
          disabled={!("config" in parsed) || !dirty || saving}
        >
          {saved ? "Save command" : "Save as command phase"}
        </Button>
        {saved && dirty && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setDraft(draftOf(saved))}
          >
            Revert
          </Button>
        )}
        {onCancel && (
          <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {!saved && (
          <span className="text-[10px] text-muted-foreground">
            Nothing changes until you save.
          </span>
        )}
      </div>
    </div>
  )
}

// A check name: type any name, or pick a common one from the app's own
// suggestion list (not the browser's native datalist).
export function CheckNameInput({
  value,
  onChange,
  placeholder,
  label,
  exclude = [],
  className,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  label: string
  // Names to leave out of the suggestions (already defined).
  exclude?: string[]
  className?: string
}) {
  const suggestions = SUGGESTED_CHECK_NAMES.filter(
    (name) => !exclude.includes(name)
  )
  return (
    <Autocomplete
      items={suggestions}
      value={value}
      onValueChange={(next) => onChange(next)}
      openOnInputClick
    >
      <AutocompleteInput
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        showTrigger={false}
        className={cn("h-7 [&_input]:font-mono [&_input]:text-xs", className)}
      />
      <AutocompleteContent>
        <AutocompleteEmpty>Any name works.</AutocompleteEmpty>
        <AutocompleteList>
          {(name: string) => (
            <AutocompleteItem key={name} value={name}>
              <span className="font-mono text-xs">{name}</span>
            </AutocompleteItem>
          )}
        </AutocompleteList>
      </AutocompleteContent>
    </Autocomplete>
  )
}

function LiteralCommandFields({
  phaseId,
  draft,
  onChange,
}: {
  phaseId: string
  draft: Draft
  onChange: (draft: Draft) => void
}) {
  return (
    <>
      <CommandTextFields
        command={draft.command}
        cwd={draft.cwd}
        onChange={(patch) => onChange({ ...draft, ...patch })}
      />
      <p className="text-[10px] text-muted-foreground">
        A literal command runs the same in every workspace. Use it only when
        that&apos;s true (for example <code>git diff --check</code>).
      </p>
      <AskAi
        request={{ phaseId }}
        onUse={(proposal) =>
          onChange({
            ...draft,
            command: proposal.command,
            cwd: proposal.cwd ?? "",
          })
        }
      />
    </>
  )
}

function CommandTextFields({
  command,
  cwd,
  onChange,
}: {
  command: string
  cwd: string
  onChange: (patch: { command?: string; cwd?: string }) => void
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Command</span>
        <Textarea
          value={command}
          onChange={(e) => onChange({ command: e.target.value })}
          placeholder="pnpm test"
          aria-label="Command"
          spellCheck={false}
          className="min-h-16 resize-y font-mono text-xs"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Working directory</span>
        <Input
          value={cwd}
          onChange={(e) => onChange({ cwd: e.target.value })}
          placeholder="(workspace root)"
          aria-label="Working directory"
          className="h-7 w-44 font-mono text-xs"
        />
      </label>
    </>
  )
}

type DraftRequest = Parameters<typeof window.cowork.process.draftCommand>[0]

// Ask AI: an inert proposal the user can copy into the fields.
function AskAi({
  request,
  onUse,
}: {
  request: DraftRequest
  onUse: (proposal: { command: string; cwd: string | null }) => void
}) {
  const [asking, setAsking] = useState(false)
  const [instruction, setInstruction] = useState("")
  const [proposal, setProposal] = useState<{
    command: string
    cwd: string | null
    rationale: string
  } | null>(null)

  async function ask() {
    setAsking(true)
    try {
      setProposal(
        await window.cowork.process.draftCommand({
          ...request,
          instruction: instruction.trim() || null,
        })
      )
    } catch (err) {
      toast.error(`Ask AI could not draft a command: ${errorText(err)}`)
    } finally {
      setAsking(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Optional: what should the command check?"
          aria-label="Ask AI instruction"
          className="h-7 min-w-48 flex-1 text-xs"
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={ask}
          disabled={asking}
        >
          {asking ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Sparkles className="size-3" />
          )}
          Ask AI
        </Button>
      </div>
      {proposal && (
        <div
          className="flex flex-col gap-1 rounded-md bg-muted/60 p-2 text-xs"
          data-testid="command-proposal"
        >
          <span className="text-muted-foreground">
            Proposed command (not saved)
          </span>
          <code className="font-mono break-all whitespace-pre-wrap">
            {proposal.command}
          </code>
          {proposal.cwd && (
            <span className="text-muted-foreground">in {proposal.cwd}</span>
          )}
          {proposal.rationale && (
            <span className="text-muted-foreground">{proposal.rationale}</span>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => {
                onUse(proposal)
                setProposal(null)
              }}
            >
              Use in editor
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setProposal(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

// Define one workspace check: command + working directory, with Ask AI. The
// proposal and the fields stay local until Save.
export function WorkspaceCheckForm({
  name,
  workspacePath,
  processId,
  initial,
  environment,
  onSave,
  onCancel,
}: {
  name: string
  workspacePath: string
  processId?: string
  initial?: WorkspaceCheck
  // The workspace's environment facts when a surrounding list already shows
  // them; otherwise the form shows its own environment panel.
  environment?: EnvironmentFact[]
  onSave: (check: WorkspaceCheck) => Promise<void>
  onCancel?: () => void
}) {
  const [command, setCommand] = useState(initial?.command ?? "")
  const [cwd, setCwd] = useState(initial?.cwd ?? "")
  const [saving, setSaving] = useState(false)
  const [ownFacts, setOwnFacts] = useState<EnvironmentFact[]>([])
  const trial = useCommandTrial(workspacePath)
  const facts = environment ?? ownFacts
  const interpreterFix = projectInterpreterFix(command, cwd, facts)
  let parsed: { check: WorkspaceCheck } | { error: string }
  try {
    parsed = { check: parseWorkspaceCheck({ command, cwd }) }
  } catch (err) {
    parsed = { error: errorText(err) }
  }

  async function save() {
    if (!("check" in parsed)) return
    setSaving(true)
    try {
      await onSave(parsed.check)
    } catch (err) {
      toast.error(`Could not save the check: ${errorText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-dashed p-2"
      data-testid={`check-form-${name}`}
    >
      {!environment && (
        <WorkspaceEnvironmentPanel
          workspacePath={workspacePath}
          onFacts={setOwnFacts}
        />
      )}
      <CommandTextFields
        command={command}
        cwd={cwd}
        onChange={(patch) => {
          if (patch.command !== undefined) setCommand(patch.command)
          if (patch.cwd !== undefined) setCwd(patch.cwd)
        }}
      />
      {command.trim() && "error" in parsed && (
        <p className="text-xs text-destructive" role="alert">
          {parsed.error}
        </p>
      )}
      {interpreterFix && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 p-2 text-xs"
          data-testid="interpreter-fix"
        >
          <span>
            This project runs Python through{" "}
            <code>{interpreterFix.interpreter}</code>. A bare{" "}
            <code>{interpreterFix.bare}</code> won&apos;t use it, so the check
            may fail or test the wrong packages.
          </span>
          <Button
            type="button"
            size="xs"
            variant="secondary"
            onClick={() => setCommand(interpreterFix.command)}
          >
            Use the project&apos;s Python
          </Button>
        </div>
      )}
      <AskAi
        request={{ check: name, processId, workspacePath }}
        onUse={(proposal) => {
          setCommand(proposal.command)
          setCwd(proposal.cwd ?? "")
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="xs"
          onClick={save}
          disabled={!("check" in parsed) || saving}
        >
          Save check
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => "check" in parsed && void trial.start(parsed.check)}
          disabled={!("check" in parsed) || trial.running}
        >
          {trial.running ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Play className="size-3" />
          )}
          Try it
        </Button>
        {onCancel && (
          <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <TrialResult trial={trial} />
    </div>
  )
}

type TrialState = ReturnType<typeof useCommandTrial>

// Run a check once in the workspace (Try it) and follow its output until it
// settles. Nothing is saved; the result just shows whether it works here.
export function useCommandTrial(workspacePath: string) {
  const [current, setCurrent] = useState<CommandTrial | null>(null)
  const running = current?.status === "running"

  useEffect(() => {
    if (!current || current.status !== "running") return
    const timer = setInterval(async () => {
      const next = await window.cowork.process.checkTrialStatus(current.id)
      if (next) setCurrent(next)
    }, 500)
    return () => clearInterval(timer)
  }, [current?.id, current?.status])

  return {
    current,
    running,
    async start(check: WorkspaceCheck) {
      try {
        setCurrent(
          await window.cowork.process.tryCheck({ workspacePath, check })
        )
      } catch (err) {
        toast.error(`Could not run the command: ${errorText(err)}`)
      }
    },
    cancel() {
      if (current) void window.cowork.process.cancelCheckTrial(current.id)
    },
    dismiss() {
      setCurrent(null)
    },
  }
}

function TrialResult({ trial }: { trial: TrialState }) {
  const current = trial.current
  if (!current) return null
  const headline =
    current.status === "running"
      ? "Running the command once in this workspace…"
      : current.status === "passed"
        ? "It works: the command exited with code 0."
        : current.status === "cancelled"
          ? "Stopped."
          : "It didn't pass here. Check the output below."
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-md border p-2 text-xs",
        current.status === "passed" && "border-emerald-500/40",
        current.status === "failed" && "border-destructive/40"
      )}
      data-testid="check-trial"
    >
      <div className="flex items-center gap-2">
        {current.status === "passed" ? (
          <CheckCircle2 className="size-3.5 text-emerald-600" />
        ) : current.status === "failed" ? (
          <CircleAlert className="size-3.5 text-destructive" />
        ) : current.status === "running" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : null}
        <span className="flex-1 font-medium">{headline}</span>
        {current.status === "running" ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={trial.cancel}
          >
            Stop
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={trial.dismiss}
          >
            Dismiss
          </Button>
        )}
      </div>
      {current.error && !current.receipt && (
        <p className="text-destructive">{current.error}</p>
      )}
      {current.receipt && (
        <CommandReceiptView
          config={null}
          receipt={current.receipt}
          status={current.status === "running" ? "running" : "completed"}
        />
      )}
    </div>
  )
}

// When a command calls a bare `python`/`python3`/`pytest` but the project
// has its own environment where the command runs, the same command through
// that environment's interpreter. Commands run with nothing activated, so the
// bare name would find the system Python instead.
export function projectInterpreterFix(
  command: string,
  cwd: string,
  facts: EnvironmentFact[]
): { command: string; interpreter: string; bare: string } | null {
  const text = command.trim()
  const match = /^(python3?(?:\.\d+)?|pytest)(?=\s|$)/.exec(text)
  if (!match) return null
  const root = cwd
    .trim()
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "")
  const here = facts.filter((f) => f.root === root)
  const rest = text.slice(match[1].length)
  // The project's own venv interpreter, as seen from the command's directory.
  const venv = here.find((f) => f.interpreter)
  if (venv?.interpreter) {
    const interpreter = root
      ? venv.interpreter.slice(root.length + 1)
      : venv.interpreter
    return {
      command:
        match[1] === "pytest"
          ? `${interpreter} -m pytest${rest}`
          : `${interpreter}${rest}`,
      interpreter,
      bare: match[1],
    }
  }
  // Otherwise the manager's runner: Poetry and Pipenv may keep the venv
  // outside the project, and uv's runner syncs it.
  const managed = here.find((f) => f.runner)
  if (managed?.runner)
    return {
      command: `${managed.runner} ${text}`,
      interpreter: managed.runner,
      bare: match[1],
    }
  return null
}

function needsSetup(fact: EnvironmentFact): boolean {
  return (
    (fact.status === "missing" || fact.status === "stale") &&
    fact.setup.length > 0
  )
}

// The workspace's project environments: what's ready (and the interpreter to
// use), what's missing, and a one-click setup that runs the workspace
// analysis's own setup steps in a terminal the user watches.
export function WorkspaceEnvironmentPanel({
  workspacePath,
  onFacts,
}: {
  workspacePath: string
  onFacts?: (facts: EnvironmentFact[]) => void
}) {
  const [facts, setFacts] = useState<EnvironmentFact[] | null>(null)
  const [run, setRun] = useState<EnvironmentSetupRun | null>(null)
  const [starting, setStarting] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await window.cowork.process.workspaceEnvironment({
        workspacePath,
      })
      setFacts(next)
      onFacts?.(next)
    } catch {
      setFacts([])
    }
  }, [workspacePath, onFacts])

  useEffect(() => {
    void load()
  }, [load])

  // Follow a setup run until it settles, then re-read the environment.
  useEffect(() => {
    if (run?.status !== "running") return
    watchSetupOutput()
    const timer = setInterval(async () => {
      const next = await window.cowork.process.environmentSetupStatus(run.id)
      if (!next) return
      setRun(next)
      if (next.status !== "running") {
        if (next.status === "completed") toast.success("Environment set up")
        void load()
      }
    }, 700)
    return () => clearInterval(timer)
  }, [run?.id, run?.status, load])

  async function setUp() {
    setStarting(true)
    try {
      watchSetupOutput()
      setRun(
        await window.cowork.process.startEnvironmentSetup({ workspacePath })
      )
    } catch (err) {
      toast.error(`Could not set up the environment: ${errorText(err)}`)
    } finally {
      setStarting(false)
    }
  }

  if (!facts || facts.length === 0) return null
  const missing = facts.filter(needsSetup)
  const ready = facts.filter((f) => f.status === "ready" && f.interpreter)
  const activeStep =
    run?.steps.find((s) => s.status === "running") ??
    [...(run?.steps ?? [])].reverse().find((s) => s.sessionId)
  return (
    <div className="flex flex-col gap-1.5 text-xs" data-testid="workspace-env">
      {ready.map((fact) => (
        <div
          key={`${fact.root}|${fact.ecosystem}`}
          className="flex items-center gap-1.5 text-muted-foreground"
        >
          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />
          <span>
            {fact.noun}
            {fact.root ? ` in ${fact.root}/` : ""} is ready:{" "}
            <code>{fact.interpreter}</code>
            {fact.tools.length ? ` (${fact.tools.join(", ")} installed)` : ""}
          </span>
        </div>
      ))}
      {missing.length > 0 && run?.status !== "running" && (
        <div className="flex flex-col gap-1.5 rounded-md bg-amber-500/10 p-2">
          {missing.map((fact) => (
            <div
              key={`${fact.root}|${fact.ecosystem}`}
              className="flex items-start gap-1.5"
            >
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              <span>
                {fact.noun}
                {fact.root ? ` in ${fact.root}/` : ""}{" "}
                {fact.status === "stale"
                  ? "is out of date"
                  : "isn't set up yet"}
                . Checks that use it will fail until it is.
              </span>
            </div>
          ))}
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              What setup runs
            </summary>
            <ol className="mt-1 list-decimal pl-5">
              {missing.flatMap((fact) =>
                fact.setup.map((step) => (
                  <li key={`${fact.root}|${step.command}`}>
                    {step.label}: <code>{step.command}</code>
                    {step.cwd ? ` (in ${step.cwd})` : ""}
                  </li>
                ))
              )}
            </ol>
          </details>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => void setUp()}
              disabled={starting}
            >
              {starting && <Loader2 className="size-3 animate-spin" />}
              Set up environment
            </Button>
            {run && run.status !== "completed" && (
              <span className="text-destructive">
                Setup {run.status === "cancelled" ? "was cancelled" : "failed"};
                see the output below.
              </span>
            )}
          </div>
        </div>
      )}
      {run && (
        <div className="flex flex-col gap-1">
          <ol className="flex flex-col gap-0.5">
            {run.steps.map((step, i) => (
              <li key={i} className="flex items-center gap-1.5">
                {step.status === "running" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : step.status === "ok" ? (
                  <CheckCircle2 className="size-3 text-emerald-600" />
                ) : step.status === "failed" ? (
                  <CircleAlert className="size-3 text-destructive" />
                ) : (
                  <span className="size-3" />
                )}
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
          {activeStep?.sessionId && (
            <div className="h-48 shrink-0 overflow-hidden rounded-md">
              <SetupTerminal
                sessionId={activeStep.sessionId}
                interactive={activeStep.status === "running"}
              />
            </div>
          )}
          {run.status === "running" && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="self-start"
              onClick={() =>
                void window.cowork.process.cancelEnvironmentSetup(run.id)
              }
            >
              Cancel setup
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function CheckLine({
  name,
  check,
  onEdit,
  onRemove,
}: {
  name: string
  check: WorkspaceCheck
  onEdit: () => void
  onRemove?: () => void
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />
      <span className="shrink-0 font-mono">{name}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
        $ {check.command}
        {check.cwd ? `  (in ${check.cwd})` : ""}
      </code>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Edit check ${name}`}
        onClick={onEdit}
      >
        <Pencil className="size-3" />
      </Button>
      {onRemove && (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove check ${name}`}
          onClick={onRemove}
        >
          <Trash2 className="size-3" />
        </Button>
      )}
    </div>
  )
}

// The checks a process needs in the chosen workspace, at run start. Defined
// ones show their command; missing ones open a form. `onReadyChange` reports
// whether every required check is defined (a run with a missing check won't
// start).
export function RunChecksPanel({
  processId,
  workspacePath,
  onReadyChange,
}: {
  processId: string
  workspacePath: string
  onReadyChange: (ready: boolean) => void
}) {
  const [status, setStatus] = useState<{
    required: string[]
    missing: string[]
    checks: WorkspaceChecks
  } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [environment, setEnvironment] = useState<EnvironmentFact[]>([])

  const load = useCallback(async () => {
    const next = await window.cowork.process.checkStatus({
      processId,
      workspacePath,
    })
    setStatus(next)
  }, [processId, workspacePath])

  useEffect(() => {
    setStatus(null)
    setEditing(null)
    void load()
  }, [load])

  useEffect(() => {
    onReadyChange(!!status && status.missing.length === 0)
  }, [status, onReadyChange])

  if (!status || status.required.length === 0) return null
  return (
    <div className="flex flex-col gap-2" data-testid="run-checks">
      <div className="text-xs font-medium text-muted-foreground">
        Workspace checks
      </div>
      <p className="text-[10px] text-muted-foreground">
        Command phases in this process run these checks. Each is saved to this
        workspace and reused by later runs.
      </p>
      <WorkspaceEnvironmentPanel
        workspacePath={workspacePath}
        onFacts={setEnvironment}
      />
      {status.required.map((name) => {
        const check = status.checks[name]
        if (check && editing !== name)
          return (
            <CheckLine
              key={name}
              name={name}
              check={check}
              onEdit={() => setEditing(name)}
            />
          )
        return (
          <div key={name} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs">
              {check ? (
                <Pencil className="size-3.5 text-muted-foreground" />
              ) : (
                <CircleAlert className="size-3.5 text-amber-600" />
              )}
              <span className="font-mono">{name}</span>
              {!check && (
                <span className="text-amber-600 dark:text-amber-500">
                  not defined for this workspace yet
                </span>
              )}
            </div>
            <WorkspaceCheckForm
              name={name}
              workspacePath={workspacePath}
              processId={processId}
              initial={check}
              environment={environment}
              onCancel={check ? () => setEditing(null) : undefined}
              onSave={async (next) => {
                await window.cowork.process.setWorkspaceCheck({
                  workspacePath,
                  name,
                  check: next,
                })
                setEditing(null)
                await load()
              }}
            />
          </div>
        )
      })}
    </div>
  )
}

// Every check a workspace defines (Mission Control advanced settings): edit,
// remove, or add one by name.
export function WorkspaceChecksEditor({
  workspace,
  onSaved,
}: {
  workspace: Workspace
  onSaved: (workspace: Workspace) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [newName, setNewName] = useState("")
  const [adding, setAdding] = useState<string | null>(null)
  const [environment, setEnvironment] = useState<EnvironmentFact[]>([])
  const checks = workspace.commandChecks ?? {}
  const names = Object.keys(checks).sort()

  async function write(name: string, check: WorkspaceCheck | null) {
    onSaved(
      await window.cowork.process.setWorkspaceCheck({
        workspacePath: workspace.path,
        name,
        check,
      })
    )
  }

  let newNameError: string | null = null
  if (newName.trim()) {
    try {
      const parsed = parseCheckName(newName)
      if (checks[parsed]) newNameError = `“${parsed}” is already defined.`
    } catch (err) {
      newNameError = errorText(err)
    }
  }

  return (
    <div className="space-y-2" data-testid="workspace-checks">
      <div>
        <div className="text-sm font-medium">Workspace checks</div>
        <p className="text-xs text-muted-foreground">
          What each named check runs in this workspace. Playbook command steps
          name a check (like <code>test</code>), so one playbook works across
          projects. A user story whose playbook needs an undefined check
          won&apos;t start.
        </p>
      </div>
      <WorkspaceEnvironmentPanel
        workspacePath={workspace.path}
        onFacts={setEnvironment}
      />
      {names.length === 0 && (
        <p className="text-xs text-muted-foreground">No checks yet.</p>
      )}
      {names.map((name) =>
        editing === name ? (
          <WorkspaceCheckForm
            key={name}
            name={name}
            workspacePath={workspace.path}
            initial={checks[name]}
            environment={environment}
            onCancel={() => setEditing(null)}
            onSave={async (check) => {
              await write(name, check)
              setEditing(null)
            }}
          />
        ) : (
          <CheckLine
            key={name}
            name={name}
            check={checks[name]}
            onEdit={() => setEditing(name)}
            onRemove={() =>
              void write(name, null).catch((err) =>
                toast.error(`Could not remove the check: ${errorText(err)}`)
              )
            }
          />
        )
      )}
      {adding ? (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs">{adding}</span>
          <WorkspaceCheckForm
            name={adding}
            workspacePath={workspace.path}
            environment={environment}
            onCancel={() => setAdding(null)}
            onSave={async (check) => {
              await write(adding, check)
              setAdding(null)
              setNewName("")
            }}
          />
        </div>
      ) : (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (newNameError || !newName.trim()) return
            setAdding(parseCheckName(newName))
          }}
        >
          <CheckNameInput
            value={newName}
            onChange={setNewName}
            placeholder="Check name (e.g. test)"
            label="New check name"
            exclude={names}
            className="w-48"
          />
          <Button
            type="submit"
            size="xs"
            variant="outline"
            disabled={!newName.trim() || !!newNameError}
          >
            <Plus className="size-3" />
            Add check
          </Button>
          {newNameError && (
            <span className="text-xs text-destructive">{newNameError}</span>
          )}
        </form>
      )}
    </div>
  )
}

export function CommandBadge({
  config,
}: {
  config?: ProcessCommandConfig | null
}) {
  return (
    <Badge variant="outline" className="h-5 gap-1 text-[10px]">
      <SquareTerminal className="size-3 text-muted-foreground" />
      {config?.source === "check" ? `check: ${config.check}` : "command"}
    </Badge>
  )
}

// The monitor's view of a command phase: the frozen command (before and
// during execution), its state and duration, and the bounded stdout/stderr
// with exit and truncation metadata.
export function CommandReceiptView({
  config,
  resolved,
  receipt,
  status,
}: {
  config: ProcessCommandConfig | null | undefined
  // The command frozen on the run at start, if resolved yet.
  resolved?: ResolvedProcessCommand | null
  receipt: ProcessCommandReceipt | null | undefined
  status: PhaseRunStatus
}) {
  const literal = config?.source === "literal" ? config : null
  const command = receipt?.command ?? resolved?.command ?? literal?.command
  const cwd = receipt
    ? receipt.cwd
    : resolved
      ? resolved.cwd
      : (literal?.cwd ?? null)
  const check =
    receipt?.check ??
    resolved?.check ??
    (config?.source === "check" ? config.check : null)
  const [now, setNow] = useState(() => Date.now())
  const running = receipt?.status === "running" && status === "running"
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [running])

  if (!command && !check)
    return (
      <p className="text-xs text-destructive">
        This command phase has no saved command.
      </p>
    )
  const failed = !!receipt && receipt.status !== "completed" && !running
  const duration = receipt
    ? formatDuration((receipt.finishedAt ?? now) - receipt.startedAt)
    : null
  return (
    <div
      className="flex flex-col gap-1.5 text-xs"
      data-testid="command-receipt"
    >
      {command ? (
        <code className="rounded bg-muted px-2 py-1 font-mono break-all whitespace-pre-wrap">
          $ {command}
        </code>
      ) : (
        <span className="text-muted-foreground">
          Runs the workspace&apos;s “{check}” check
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        {check && command && (
          <>
            <span>check {check}</span>
            <span aria-hidden>·</span>
          </>
        )}
        {command && <span>{cwd ? `in ${cwd}` : "in the workspace root"}</span>}
        {receipt && (
          <>
            <span aria-hidden>·</span>
            <span>
              {receipt.environment === "container" ? "container" : "local"}
            </span>
            <span aria-hidden>·</span>
            <span className={cn(failed && "text-destructive")}>
              {running
                ? `running for ${duration}`
                : `the command ${commandOutcomeText(receipt)}${duration ? ` after ${duration}` : ""}`}
            </span>
          </>
        )}
        {!receipt && status === "pending" && (
          <>
            {command && <span aria-hidden>·</span>}
            <span>not started</span>
          </>
        )}
      </div>
      {receipt?.outputTruncated && (
        <p className="text-amber-600 dark:text-amber-500">
          Output truncated: kept {receipt.capturedOutputBytes} of{" "}
          {receipt.observedOutputBytes} bytes (the start and the end).
        </p>
      )}
      {receipt && (receipt.stdout || receipt.stderr) && (
        <details open={failed || running}>
          <summary className="cursor-pointer text-muted-foreground">
            Output
          </summary>
          {receipt.stdout && (
            <OutputBlock label="stdout" text={receipt.stdout} />
          )}
          {receipt.stderr && (
            <OutputBlock label="stderr" text={receipt.stderr} />
          )}
        </details>
      )}
    </div>
  )
}

function OutputBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="mt-1 flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground uppercase">
        {label}
      </span>
      <pre className="max-h-72 overflow-auto rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  )
}
