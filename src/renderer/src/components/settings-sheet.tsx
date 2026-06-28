import { useEffect, useState } from "react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ProvidersTab, ModelsTab, useLlmSettings } from "@/components/llm-settings"
import type {
  ExecutionSettings,
  PermissionSettings,
  Backend,
  ApprovalCategory,
  Runtime,
  RuntimeStatus,
} from "@/types"

// Human-readable labels + help for each sandbox category (mirrors the taxonomy
// in the main-process settings service / regex classifier).
const CATEGORY_META: Record<ApprovalCategory, { label: string; help: string }> = {
  workspace_mutation: {
    label: "Workspace edits",
    help: "Create, write, and edit files inside the workspace.",
  },
  destructive_fs: {
    label: "Destructive file ops",
    help: "Recursive/forced deletes (rm -r, find -delete, git clean -f).",
  },
  history_rewrite: {
    label: "Git history rewrite",
    help: "git reset --hard, force-push, branch delete.",
  },
  system_mutation: {
    label: "System changes",
    help: "Permissions, services, devices, or credential/system paths.",
  },
  code_exec: {
    label: "Arbitrary code execution",
    help: "Inline interpreters and piping remote scripts to a shell.",
  },
}
const CATEGORY_ORDER: ApprovalCategory[] = [
  "workspace_mutation",
  "destructive_fs",
  "history_rewrite",
  "system_mutation",
  "code_exec",
]

const RUNTIME_STATUS_LABEL: Record<RuntimeStatus, string> = {
  available: "available",
  not_installed: "not installed",
  unavailable: "installed, not running",
}

export function SettingsSheet({
  open,
  onOpenChange,
  initialTab = "backend",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Which tab to open on. The first-launch prompt opens straight to "providers".
  initialTab?: string
}) {
  const [execution, setExecution] = useState<ExecutionSettings | null>(null)
  const [permissions, setPermissions] = useState<PermissionSettings | null>(null)
  const [runtimes, setRuntimes] = useState<Record<Runtime, RuntimeStatus> | null>(null)
  const llm = useLlmSettings(open)
  // When set, the first-time onboarding dialog is shown for this just-picked
  // container backend (awaiting the user's enable / not-now choice).
  const [onboarding, setOnboarding] = useState<Exclude<Backend, "local"> | null>(null)

  // Load current settings + runtime availability whenever the sheet opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    Promise.all([
      window.cowork.settings.getExecution(),
      window.cowork.settings.getPermissions(),
      window.cowork.settings.checkRuntimes(),
    ]).then(([exec, perms, rt]) => {
      if (cancelled) return
      setExecution(exec)
      setPermissions(perms)
      setRuntimes(rt)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  // Persist execution + update local state together so the UI stays in sync.
  async function saveExecution(next: ExecutionSettings) {
    setExecution(next)
    await window.cowork.settings.setExecution(next)
  }
  async function savePermissions(next: PermissionSettings) {
    setPermissions(next)
    await window.cowork.settings.setPermissions(next)
  }

  function onBackendChange(value: string) {
    if (!execution) return
    const backend = value as Backend
    const next: ExecutionSettings = { ...execution, backend }
    // First time switching to a container backend: persist the choice, then ask
    // (once) whether to enable sandbox auto-approve. `prompted` guards re-asking.
    if (backend !== "local" && !execution.sandbox.prompted) {
      setOnboarding(backend)
    }
    void saveExecution(next)
  }

  function resolveOnboarding(enable: boolean) {
    if (!execution) return
    const next: ExecutionSettings = {
      ...execution,
      sandbox: { ...execution.sandbox, prompted: true, autoApprove: enable },
    }
    setOnboarding(null)
    void saveExecution(next)
  }

  const isContainer = execution?.backend === "docker" || execution?.backend === "podman"

  function runtimeOptionDisabled(rt: Runtime): boolean {
    return runtimes != null && runtimes[rt] !== "available"
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-[28rem] sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Settings</SheetTitle>
            <SheetDescription>
              Execution backend and approval policy. Changes apply on the next turn.
            </SheetDescription>
          </SheetHeader>

          {execution && permissions && (
            <Tabs defaultValue={initialTab} className="flex min-h-0 flex-1 flex-col px-4">
              <TabsList>
                <TabsTrigger value="providers">Providers</TabsTrigger>
                <TabsTrigger value="models">Models</TabsTrigger>
                <TabsTrigger value="backend">Backend</TabsTrigger>
                <TabsTrigger value="permissions">Permissions</TabsTrigger>
                <TabsTrigger value="sandbox" disabled={!isContainer}>
                  Sandbox
                </TabsTrigger>
              </TabsList>

              <ProvidersTab state={llm} />
              <ModelsTab state={llm} />

              {/* Backend picker — Local / Docker / Podman, gated by availability. */}
              <TabsContent value="backend" className="flex flex-col gap-4 py-2">
                <Field>
                  <FieldLabel htmlFor="backend-select">Execution backend</FieldLabel>
                  <Select value={execution.backend} onValueChange={onBackendChange}>
                    <SelectTrigger id="backend-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">Local (this machine)</SelectItem>
                      <SelectItem value="docker" disabled={runtimeOptionDisabled("docker")}>
                        Docker
                        {runtimes ? ` — ${RUNTIME_STATUS_LABEL[runtimes.docker]}` : ""}
                      </SelectItem>
                      <SelectItem value="podman" disabled={runtimeOptionDisabled("podman")}>
                        Podman
                        {runtimes ? ` — ${RUNTIME_STATUS_LABEL[runtimes.podman]}` : ""}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {execution.backend === "local"
                      ? "Tools run directly on your machine. The approval gate is the only guard."
                      : "Tools run in an isolated container with only the workspace mounted."}
                  </FieldDescription>
                </Field>
              </TabsContent>

              {/* File-permission toggles — flip "require approval" per kind. */}
              <TabsContent value="permissions" className="flex flex-col gap-4 py-2">
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="perm-write">Require approval to write files</FieldLabel>
                    <FieldDescription>
                      Prompt before creating or overwriting a file.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="perm-write"
                    checked={permissions.file_write === "require_approval"}
                    onCheckedChange={(checked) =>
                      savePermissions({
                        ...permissions,
                        file_write: checked ? "require_approval" : "auto",
                      })
                    }
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="perm-edit">Require approval to edit files</FieldLabel>
                    <FieldDescription>
                      Prompt before replacing text in an existing file.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="perm-edit"
                    checked={permissions.file_edit === "require_approval"}
                    onCheckedChange={(checked) =>
                      savePermissions({
                        ...permissions,
                        file_edit: checked ? "require_approval" : "auto",
                      })
                    }
                  />
                </Field>
              </TabsContent>

              {/* Sandbox auto-approve — master switch + per-category opt-ins.
                  Only meaningful with a container backend (tab is disabled otherwise). */}
              <TabsContent value="sandbox" className="flex flex-col gap-4 py-2">
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="sandbox-master">Sandbox auto-approve</FieldLabel>
                    <FieldDescription>
                      Auto-approve selected actions while running in a container. Hard-blocked
                      commands are never auto-approved.
                    </FieldDescription>
                  </FieldContent>
                  <Switch
                    id="sandbox-master"
                    checked={execution.sandbox.autoApprove}
                    onCheckedChange={(checked) =>
                      saveExecution({
                        ...execution,
                        sandbox: { ...execution.sandbox, autoApprove: checked },
                      })
                    }
                  />
                </Field>

                {execution.sandbox.autoApprove &&
                  CATEGORY_ORDER.map((cat) => (
                    <Field key={cat} orientation="horizontal">
                      <FieldContent>
                        <FieldLabel htmlFor={`cat-${cat}`}>{CATEGORY_META[cat].label}</FieldLabel>
                        <FieldDescription>{CATEGORY_META[cat].help}</FieldDescription>
                      </FieldContent>
                      <Switch
                        id={`cat-${cat}`}
                        checked={execution.sandbox.categories[cat] === true}
                        onCheckedChange={(checked) =>
                          saveExecution({
                            ...execution,
                            sandbox: {
                              ...execution.sandbox,
                              categories: { ...execution.sandbox.categories, [cat]: checked },
                            },
                          })
                        }
                      />
                    </Field>
                  ))}
              </TabsContent>
            </Tabs>
          )}
        </SheetContent>
      </Sheet>

      {/* One-time explanation the first time a container backend is chosen. */}
      <Dialog open={onboarding !== null} onOpenChange={(o) => !o && resolveOnboarding(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable sandbox auto-approve?</DialogTitle>
            <DialogDescription>
              You're now running tools inside an isolated container — a bad command trashes the
              container, not your machine. You can let the agent auto-approve a curated set of
              otherwise-prompting actions (starting with workspace edits). Catastrophic commands
              (e.g. <code>rm -rf /</code>) are still always blocked. You can change this anytime in
              Settings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => resolveOnboarding(false)}>
              Not now
            </Button>
            <Button onClick={() => resolveOnboarding(true)}>Enable</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
