import { useEffect, useMemo, useState } from "react"
import { FolderOpen, Play, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { RuntimePicker, nextRuntimeConfig } from "@/components/process-screen"
import type {
  AccountWithModels,
  AgentSummary,
  PlaybookWithHooks,
  ProcessDefinition,
  ProcessRun,
  ProcessRuntimeConfig,
} from "@/types"

// Quick run (plan 106.9): run a playbook or any Process definition against an
// objective with no feature. It's an ordinary Process run; a role-bound
// definition gets an ad-hoc "solo" binding from the agents picked per role.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

function folderName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "")
  return trimmed.split(/[/\\]/).pop() || trimmed || path
}

export function QuickRunDialog({
  open,
  onOpenChange,
  playbooks,
  definitions,
  agents,
  providers,
  initialProcessId,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  playbooks: PlaybookWithHooks[]
  definitions: ProcessDefinition[]
  agents: AgentSummary[]
  providers: AccountWithModels[]
  initialProcessId?: string | null
  onStarted: (run: ProcessRun) => void
}) {
  const [processId, setProcessId] = useState("")
  const [objective, setObjective] = useState("")
  const [folder, setFolder] = useState("")
  const [runtimeConfig, setRuntimeConfig] =
    useState<ProcessRuntimeConfig | null>(null)
  const [roles, setRoles] = useState<string[] | null>(null)
  const [roleAgents, setRoleAgents] = useState<Record<string, string>>({})
  const [starting, setStarting] = useState(false)

  // User story playbooks first (their run hook), then every other definition.
  const playbookOptions = useMemo(
    () =>
      playbooks
        .filter((playbook) => playbook.altitude === "user_story")
        .flatMap((playbook) => {
          const hook = playbook.hooks.find((h) => h.hook === "run")
          return hook
            ? [{ processId: hook.processId, name: playbook.name }]
            : []
        }),
    [playbooks]
  )
  const otherDefinitions = useMemo(() => {
    const used = new Set(playbookOptions.map((option) => option.processId))
    return [...definitions]
      .filter((definition) => !used.has(definition.id))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      )
  }, [definitions, playbookOptions])

  useEffect(() => {
    if (!open) return
    setProcessId(initialProcessId ?? "")
    setObjective("")
    setFolder("")
    setRuntimeConfig(null)
    setRoleAgents({})
    setStarting(false)
  }, [open, initialProcessId])

  useEffect(() => {
    setRoles(null)
    if (!processId) return
    let cancelled = false
    window.cowork.process
      .quickRunRoles(processId)
      .then((next) => {
        if (cancelled) return
        setRoles(next)
        // Suggest the agent whose name matches the role, when there is one.
        setRoleAgents((current) => {
          const picked = { ...current }
          for (const role of next) {
            if (picked[role]) continue
            const match = agents.find(
              (agent) =>
                agent.name.toLowerCase() === role ||
                agent.label.toLowerCase() === role
            )
            if (match) picked[role] = match.refId
          }
          return picked
        })
      })
      .catch((error) => {
        if (!cancelled) toast.error(errorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [processId, agents])

  const missingRole = (roles ?? []).some((role) => !roleAgents[role])
  const canStart =
    !!processId && !!folder.trim() && roles !== null && !missingRole

  async function pickFolder() {
    const picked = await window.cowork.pickWorkspace()
    if (picked.path) setFolder(picked.path)
  }

  async function start() {
    if (!canStart) return
    setStarting(true)
    try {
      const run = await window.cowork.process.quickRun({
        processId,
        objective,
        workspacePath: folder,
        runtimeConfig,
        roleAgents: Object.fromEntries(
          (roles ?? []).map((role) => [role, roleAgents[role]])
        ),
      })
      onOpenChange(false)
      onStarted(run)
    } catch (error) {
      toast.error(errorMessage(error))
      setStarting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Quick run</DialogTitle>
          <DialogDescription>
            Run a playbook or process against an objective, without a feature.
            It shows in History while it runs.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>Playbook or process</Label>
            <Select value={processId} onValueChange={setProcessId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose what to run…" />
              </SelectTrigger>
              <SelectContent>
                {playbookOptions.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>User story playbooks</SelectLabel>
                    {playbookOptions.map((option) => (
                      <SelectItem
                        key={`playbook:${option.processId}`}
                        value={option.processId}
                      >
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
                {otherDefinitions.length > 0 && (
                  <SelectGroup>
                    <SelectLabel>Process definitions</SelectLabel>
                    {otherDefinitions.map((definition) => (
                      <SelectItem key={definition.id} value={definition.id}>
                        {definition.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="quick-run-objective">Objective</Label>
            <Textarea
              id="quick-run-objective"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
              placeholder="Describe what this run should accomplish…"
              className="min-h-20 resize-y"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>
              Working directory <span className="text-destructive">*</span>
            </Label>
            {folder ? (
              <div className="flex items-center gap-2">
                <span
                  className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs"
                  title={folder}
                >
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  {folderName(folder)}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void pickFolder()}
                >
                  Change
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setFolder("")}
                  aria-label="Clear folder"
                >
                  <XIcon />
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={() => void pickFolder()}
              >
                <FolderOpen className="size-4" /> Choose folder…
              </Button>
            )}
          </div>
          {roles && roles.length > 0 && (
            <div className="flex flex-col gap-2">
              <div>
                <Label>Seat roles</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  This one runs steps by seat role. Pick the agent that fills
                  each role for this run.
                </p>
              </div>
              {roles.map((role) => (
                <div key={role} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 truncate font-mono text-xs">
                    {role}
                  </span>
                  <Select
                    value={roleAgents[role] ?? ""}
                    onValueChange={(refId) =>
                      setRoleAgents((current) => ({
                        ...current,
                        [role]: refId,
                      }))
                    }
                  >
                    <SelectTrigger
                      className="min-w-0 flex-1"
                      aria-label={`Agent for ${role}`}
                    >
                      <SelectValue placeholder="Choose an agent…" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.refId} value={agent.refId}>
                          {agent.label || agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}
          {providers.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <RuntimePicker
                label="Default model for this run"
                providers={providers}
                value={runtimeConfig?.worker}
                onChange={(selection) =>
                  setRuntimeConfig(
                    nextRuntimeConfig(runtimeConfig, "worker", selection)
                  )
                }
              />
              <span className="text-xs text-muted-foreground">
                Step runtime overrides still win over this run default.
              </span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={starting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void start()}
            disabled={starting || !canStart}
          >
            <Play className="size-4" />
            {starting ? "Starting…" : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
