import { useEffect, useState } from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { XIcon, Plus, Trash2 } from "lucide-react"
import {
  ProvidersTab,
  ModelsTab,
  useLlmSettings,
} from "@/components/llm-settings"
import type {
  ExecutionSettings,
  PermissionSettings,
  IndexingSettings,
  BrowserSettings,
  ThemeSettings,
  IdeSettings,
  NotificationSettings,
  Backend,
  ApprovalCategory,
  Runtime,
  RuntimeStatus,
  SkillSourceRow,
  AgentSourceRow,
  McpSourceRow,
} from "@/types"
import {
  hexToOklch,
  DEFAULT_ACCENT_HEX,
  DEFAULT_NEUTRAL_HEX,
} from "../../../shared/theme"
import { applyThemeColors, applyThemeCss } from "@/lib/theme"

// Human-readable labels + help for each sandbox category (mirrors the taxonomy
// in the main-process settings service / regex classifier).
const CATEGORY_META: Record<ApprovalCategory, { label: string; help: string }> =
  {
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

// The nav-rail sections, in order. Sandbox is gated on a container backend.
const SECTIONS: Array<{ value: string; label: string }> = [
  { value: "providers", label: "Providers" },
  { value: "models", label: "Models" },
  { value: "backend", label: "Backend" },
  { value: "permissions", label: "Permissions" },
  { value: "indexing", label: "Context" },
  { value: "capabilities", label: "Capabilities" },
  { value: "browser", label: "Browser" },
  { value: "appearance", label: "Appearance" },
  { value: "editor", label: "Editor" },
  { value: "notifications", label: "Notifications" },
  { value: "sandbox", label: "Sandbox" },
]

// Per-event notification toggles, in display order. Labels + help mirror the
// NotificationSettings flags in the main-process settings service.
const NOTIFICATION_EVENTS: Array<{
  key: Exclude<keyof NotificationSettings, "enabled">
  label: string
  help: string
}> = [
  {
    key: "onNeedsInput",
    label: "Needs your input",
    help: "The agent paused for an approval or a question.",
  },
  {
    key: "onTurnComplete",
    label: "Turn complete",
    help: "The agent finished responding.",
  },
  {
    key: "onTurnError",
    label: "Turn failed",
    help: "A turn errored or the execution backend was unavailable.",
  },
  {
    key: "onTaskComplete",
    label: "Background task done",
    help: "A background task or delegated subagent finished.",
  },
]

// Human-readable labels for the non-custom (locked) skill-source kinds.
const SKILL_SOURCE_KIND_LABEL: Record<SkillSourceRow["kind"], string> = {
  user: "User",
  custom: "Custom",
  github: "Workspace",
  workspace: "Workspace",
}

const AGENT_SOURCE_KIND_LABEL: Record<AgentSourceRow["kind"], string> = {
  user: "User",
  custom: "Custom",
  github: "Workspace",
  workspace: "Workspace",
}

const MCP_SOURCE_KIND_LABEL: Record<McpSourceRow["kind"], string> = {
  user: "User",
  custom: "Custom",
  github: "Workspace",
  workspace: "Workspace",
}

// Parse a numeric input to an integer clamped to [min, max]. A blank/NaN entry
// (mid-edit) falls back to `fallback` so we never persist NaN into settings.
function clampInt(
  raw: string,
  min: number,
  max: number,
  fallback: number
): number {
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function SettingsScreen({
  open,
  onOpenChange,
  initialTab = "backend",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Which section to open on. The first-launch prompt opens straight to
  // "providers"; the composer's "Configure model…" also lands there.
  initialTab?: string
}) {
  const [execution, setExecution] = useState<ExecutionSettings | null>(null)
  const [permissions, setPermissions] = useState<PermissionSettings | null>(
    null
  )
  const [indexing, setIndexing] = useState<IndexingSettings | null>(null)
  const [browser, setBrowser] = useState<BrowserSettings | null>(null)
  const [ide, setIde] = useState<IdeSettings | null>(null)
  const [ideOptions, setIdeOptions] = useState<
    Array<{ id: string; label: string }>
  >([])
  const [notifications, setNotifications] =
    useState<NotificationSettings | null>(null)
  // The last-persisted theme override, and the in-progress draft the Appearance
  // pickers edit. The draft drives a live preview; Save persists it, Reset clears
  // the override, and closing without Save restores `savedTheme` (drops preview).
  const [savedTheme, setSavedTheme] = useState<ThemeSettings | null>(null)
  const [themeDraft, setThemeDraft] = useState<ThemeSettings | null>(null)
  // Skill-source rows for the Capabilities tab (built-in + custom folders, each
  // with a live skill count). Loaded independently of the other settings so a
  // slow directory scan doesn't gate the whole screen.
  const [skillSources, setSkillSources] = useState<SkillSourceRow[] | null>(
    null
  )
  // Agent-source rows for the Capabilities tab (same shape as skill sources).
  const [agentSources, setAgentSources] = useState<AgentSourceRow[] | null>(
    null
  )
  // MCP-source rows for the Capabilities tab (same shape as agent sources).
  const [mcpSources, setMcpSources] = useState<McpSourceRow[] | null>(null)
  const [runtimes, setRuntimes] = useState<Record<
    Runtime,
    RuntimeStatus
  > | null>(null)
  const llm = useLlmSettings(open)
  // When set, the first-time onboarding dialog is shown for this just-picked
  // container backend (awaiting the user's enable / not-now choice).
  const [onboarding, setOnboarding] = useState<Exclude<
    Backend,
    "local"
  > | null>(null)

  // Load current settings + runtime availability whenever the screen opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    Promise.all([
      window.cowork.settings.getExecution(),
      window.cowork.settings.getPermissions(),
      window.cowork.settings.getIndexing(),
      window.cowork.settings.getBrowser(),
      window.cowork.settings.getIde(),
      window.cowork.settings.ideOptions(),
      window.cowork.settings.getNotifications(),
      window.cowork.settings.checkRuntimes(),
      window.cowork.settings.getTheme(),
    ]).then(([exec, perms, idx, br, ideCfg, ideOpts, notif, rt, theme]) => {
      if (cancelled) return
      setExecution(exec)
      setPermissions(perms)
      setIndexing(idx)
      setBrowser(br)
      setIde(ideCfg)
      setIdeOptions(ideOpts)
      setNotifications(notif)
      setRuntimes(rt)
      setSavedTheme(theme)
      setThemeDraft(theme)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  // Load skill sources separately (a directory scan per source), so it never
  // blocks the main settings render. Re-fetched after add/remove via refreshSkillSources.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setSkillSources(null)
    window.cowork.skills.sources().then((rows) => {
      if (!cancelled) setSkillSources(rows)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  async function refreshSkillSources() {
    setSkillSources(await window.cowork.skills.sources())
  }

  // Add a custom skill-source folder via the native directory picker. Skips a
  // path that's already registered (built-in or custom), then re-scans for counts.
  async function addSkillFolder() {
    const picked = await window.cowork.pickWorkspace()
    if (!picked.path) return
    const current = await window.cowork.settings.getSkillSources()
    if (current.folders.includes(picked.path)) return
    // Also skip if it duplicates a built-in source already shown in the table.
    if (skillSources?.some((r) => r.path === picked.path)) return
    await window.cowork.settings.setSkillSources({
      folders: [...current.folders, picked.path],
    })
    await refreshSkillSources()
  }

  async function removeSkillFolder(path: string) {
    const current = await window.cowork.settings.getSkillSources()
    await window.cowork.settings.setSkillSources({
      folders: current.folders.filter((f) => f !== path),
    })
    await refreshSkillSources()
  }

  // Agent sources — same independent-scan + read-modify-write pattern as skills.
  // Custom folders registered here apply across chat/interactive/north_star.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setAgentSources(null)
    window.cowork.agents.sources().then((rows) => {
      if (!cancelled) setAgentSources(rows)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  async function refreshAgentSources() {
    setAgentSources(await window.cowork.agents.sources())
  }

  async function addAgentFolder() {
    const picked = await window.cowork.pickWorkspace()
    if (!picked.path) return
    const current = await window.cowork.settings.getAgentSources()
    if (current.folders.includes(picked.path)) return
    if (agentSources?.some((r) => r.path === picked.path)) return
    await window.cowork.settings.setAgentSources({
      folders: [...current.folders, picked.path],
    })
    await refreshAgentSources()
  }

  async function removeAgentFolder(path: string) {
    const current = await window.cowork.settings.getAgentSources()
    await window.cowork.settings.setAgentSources({
      folders: current.folders.filter((f) => f !== path),
    })
    await refreshAgentSources()
  }

  // MCP sources — same independent-scan + read-modify-write pattern as agents.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setMcpSources(null)
    window.cowork.mcp.sources().then((rows) => {
      if (!cancelled) setMcpSources(rows)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  async function refreshMcpSources() {
    setMcpSources(await window.cowork.mcp.sources())
  }

  async function addMcpFolder() {
    const picked = await window.cowork.pickWorkspace()
    if (!picked.path) return
    const current = await window.cowork.settings.getMcpSources()
    if (current.folders.includes(picked.path)) return
    if (mcpSources?.some((r) => r.path === picked.path)) return
    await window.cowork.settings.setMcpSources({
      folders: [...current.folders, picked.path],
    })
    await refreshMcpSources()
  }

  async function removeMcpFolder(path: string) {
    const current = await window.cowork.settings.getMcpSources()
    await window.cowork.settings.setMcpSources({
      folders: current.folders.filter((f) => f !== path),
    })
    await refreshMcpSources()
  }

  // Persist execution + update local state together so the UI stays in sync.
  async function saveExecution(next: ExecutionSettings) {
    setExecution(next)
    await window.cowork.settings.setExecution(next)
  }
  async function savePermissions(next: PermissionSettings) {
    setPermissions(next)
    await window.cowork.settings.setPermissions(next)
  }
  async function saveIndexing(next: IndexingSettings) {
    setIndexing(next)
    await window.cowork.settings.setIndexing(next)
  }
  async function saveBrowser(next: BrowserSettings) {
    setBrowser(next)
    await window.cowork.settings.setBrowser(next)
  }
  async function saveIde(next: IdeSettings) {
    setIde(next)
    await window.cowork.settings.setIde(next)
  }
  async function saveNotifications(next: NotificationSettings) {
    setNotifications(next)
    await window.cowork.settings.setNotifications(next)
  }

  // Update the theme draft AND live-preview it immediately (recolor the whole
  // app). Persistence waits for Save; this only paints.
  function previewTheme(next: ThemeSettings) {
    setThemeDraft(next)
    applyThemeColors(next.accent, next.neutral)
  }
  // Persist the current draft as the override.
  async function saveTheme() {
    if (!themeDraft) return
    const next = await window.cowork.settings.setTheme(themeDraft)
    setSavedTheme(next)
    setThemeDraft(next)
  }
  // Clear the in-app override (revert to the .env preset / default) and re-apply
  // the resolved baseline the main process reports.
  async function resetTheme() {
    const cleared: ThemeSettings = { accent: null, neutral: null }
    const next = await window.cowork.settings.setTheme(cleared)
    setSavedTheme(next)
    setThemeDraft(next)
    applyThemeCss(window.cowork.system().theme)
  }
  // Drop an unsaved preview: restore the last-persisted theme's paint. Called on
  // close so a previewed-but-unsaved color never lingers over the rest of the app.
  function restoreSavedTheme() {
    if (!savedTheme) return
    setThemeDraft(savedTheme)
    if (savedTheme.accent || savedTheme.neutral) {
      applyThemeColors(savedTheme.accent, savedTheme.neutral)
    } else {
      applyThemeCss(window.cowork.system().theme)
    }
  }

  // Close wrapper: drop any unsaved theme preview before the modal closes.
  function handleOpenChange(next: boolean) {
    if (!next) restoreSavedTheme()
    onOpenChange(next)
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

  const isContainer =
    execution?.backend === "docker" || execution?.backend === "podman"

  function runtimeOptionDisabled(rt: Runtime): boolean {
    return runtimes != null && runtimes[rt] !== "available"
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogPrimitive.Portal>
          {/* Clicking the backdrop closes Settings (alongside Escape and the
              [X]). We close from the overlay's own onClick rather than the
              content's onInteractOutside because the latter also fires when an
              open Select dropdown is dismissed by a click INSIDE the modal (the
              Select's dismiss resolves outside the dialog's content) — which would
              wrongly close Settings. A click that reaches the overlay element is
              unambiguously a real backdrop click. */}
          <DialogOverlay onClick={() => handleOpenChange(false)} />
          {/* A large centered modal (nearly full-screen but inset, with a
              backdrop). Built on the raw Radix primitive so we get the focus-trap
              / Escape-to-close / portal for free, but WITHOUT the shared
              DialogContent's zoom-to-small-box sizing. */}
          <DialogPrimitive.Content
            data-slot="settings-screen"
            aria-describedby={undefined}
            // Never close from an outside-interaction: an open modal Select sets
            // `pointer-events: none` on the body, so dismissing its dropdown fires
            // this with a target outside the dialog and would spuriously close
            // Settings. Backdrop-close is handled by the overlay's onClick above.
            onInteractOutside={(e) => e.preventDefault()}
            className="fixed top-1/2 left-1/2 z-50 flex h-[calc(100vh-10rem)] w-[calc(100vw-10rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl bg-background text-sm text-foreground ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            {/* Header row (no longer a window drag region — the modal is inset
                from the window edge). */}
            <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
              <DialogTitle className="font-heading text-base font-medium">
                Settings
              </DialogTitle>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon-sm">
                  <XIcon />
                  <span className="sr-only">Close</span>
                </Button>
              </DialogPrimitive.Close>
            </div>

            {execution &&
              permissions &&
              indexing &&
              browser &&
              ide &&
              notifications && (
                <Tabs
                  orientation="vertical"
                  defaultValue={initialTab}
                  className="flex min-h-0 flex-1 gap-0"
                >
                  {/* Left nav rail — the six sections as a vertical list. */}
                  <TabsList
                    variant="line"
                    className="h-full w-56 shrink-0 items-stretch justify-start gap-0.5 overflow-y-auto border-r p-3"
                  >
                    {SECTIONS.map((s) => (
                      <TabsTrigger
                        key={s.value}
                        value={s.value}
                        disabled={s.value === "sandbox" && !isContainer}
                        className="px-3 py-1.5"
                      >
                        {s.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>

                  {/* Content area — comfortable max-width so forms don't stretch
                    edge-to-edge on a wide monitor. Each TabsContent is the flex
                    child that scrolls its own overflow (as the bodies expect). */}
                  <div className="flex min-h-0 flex-1 justify-center overflow-hidden px-6">
                    <div className="flex min-h-0 w-full max-w-2xl flex-col">
                      <ProvidersTab state={llm} />
                      <ModelsTab state={llm} />

                      {/* Backend picker — Local / Docker / Podman, gated by availability. */}
                      <TabsContent
                        value="backend"
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-6"
                      >
                        <Field>
                          <FieldLabel htmlFor="backend-select">
                            Execution backend
                          </FieldLabel>
                          <Select
                            value={execution.backend}
                            onValueChange={onBackendChange}
                          >
                            <SelectTrigger id="backend-select">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="local">
                                Local (this machine)
                              </SelectItem>
                              <SelectItem
                                value="docker"
                                disabled={runtimeOptionDisabled("docker")}
                              >
                                Docker
                                {runtimes
                                  ? ` — ${RUNTIME_STATUS_LABEL[runtimes.docker]}`
                                  : ""}
                              </SelectItem>
                              <SelectItem
                                value="podman"
                                disabled={runtimeOptionDisabled("podman")}
                              >
                                Podman
                                {runtimes
                                  ? ` — ${RUNTIME_STATUS_LABEL[runtimes.podman]}`
                                  : ""}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          <FieldDescription>
                            {execution.backend === "local"
                              ? "Tools run directly on your machine. Only file reads run without asking — every command and file write/edit needs your approval."
                              : "Tools run in an isolated container with only the workspace mounted."}
                          </FieldDescription>
                        </Field>
                      </TabsContent>

                      {/* File-permission toggles — flip "require approval" per kind. */}
                      <TabsContent
                        value="permissions"
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-6"
                      >
                        {execution.backend === "local" && (
                          <FieldDescription>
                            On the local backend every file write and edit
                            already requires approval — these toggles take
                            effect only when running in a container.
                          </FieldDescription>
                        )}
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="perm-write">
                              Require approval to write files
                            </FieldLabel>
                            <FieldDescription>
                              Prompt before creating or overwriting a file.
                            </FieldDescription>
                          </FieldContent>
                          <Switch
                            id="perm-write"
                            checked={
                              permissions.file_write === "require_approval"
                            }
                            onCheckedChange={(checked) =>
                              savePermissions({
                                ...permissions,
                                file_write: checked
                                  ? "require_approval"
                                  : "auto",
                              })
                            }
                          />
                        </Field>
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="perm-edit">
                              Require approval to edit files
                            </FieldLabel>
                            <FieldDescription>
                              Prompt before replacing text in an existing file.
                            </FieldDescription>
                          </FieldContent>
                          <Switch
                            id="perm-edit"
                            checked={
                              permissions.file_edit === "require_approval"
                            }
                            onCheckedChange={(checked) =>
                              savePermissions({
                                ...permissions,
                                file_edit: checked
                                  ? "require_approval"
                                  : "auto",
                              })
                            }
                          />
                        </Field>
                      </TabsContent>

                      {/* Workspace Indexing (plan 008) — background index build + agent use. */}
                      <TabsContent
                        value="indexing"
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-6"
                      >
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="idx-auto">
                              Automatically index new workspaces
                            </FieldLabel>
                            <FieldDescription>
                              Build a background index when a workspace is
                              opened, so the agent can answer about it right
                              away. Per-workspace disable overrides this.
                            </FieldDescription>
                          </FieldContent>
                          <Switch
                            id="idx-auto"
                            checked={indexing.autoIndexNewWorkspaces}
                            onCheckedChange={(checked) =>
                              saveIndexing({
                                ...indexing,
                                autoIndexNewWorkspaces: checked,
                              })
                            }
                          />
                        </Field>
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="idx-context">
                              Use index to improve agent context
                            </FieldLabel>
                            <FieldDescription>
                              Feed a compact workspace summary into the agent.
                              Off = the index still builds but the agent ignores
                              it.
                            </FieldDescription>
                          </FieldContent>
                          <Switch
                            id="idx-context"
                            checked={indexing.useIndexForContext}
                            onCheckedChange={(checked) =>
                              saveIndexing({
                                ...indexing,
                                useIndexForContext: checked,
                              })
                            }
                          />
                        </Field>
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="idx-embed">
                              Include embeddings
                            </FieldLabel>
                            <FieldDescription>
                              Semantic search over the index — coming in a later
                              release.
                            </FieldDescription>
                          </FieldContent>
                          <Switch id="idx-embed" checked={false} disabled />
                        </Field>

                        {/* Conversation-summary triggers (plan 019). A rolling
                          digest regenerates when the un-summarized tail reaches
                          either threshold, whichever comes first. */}
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="sum-msg">
                              Summarize after N messages
                            </FieldLabel>
                            <FieldDescription>
                              Regenerate the conversation summary once this many
                              new messages accumulate. Set to 0 to trigger on
                              tokens only.
                            </FieldDescription>
                          </FieldContent>
                          <Input
                            id="sum-msg"
                            type="number"
                            min={0}
                            step={1}
                            className="w-28"
                            value={indexing.summarizeMessageThreshold}
                            onChange={(e) =>
                              saveIndexing({
                                ...indexing,
                                summarizeMessageThreshold: clampInt(
                                  e.target.value,
                                  0,
                                  Number.MAX_SAFE_INTEGER,
                                  indexing.summarizeMessageThreshold
                                ),
                              })
                            }
                          />
                        </Field>
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="sum-tok">
                              Summarize after N tokens
                            </FieldLabel>
                            <FieldDescription>
                              Regenerate the summary once the un-summarized
                              turns reach this many tokens (whichever threshold
                              is hit first). Range 6,000–150,000.
                            </FieldDescription>
                          </FieldContent>
                          <Input
                            id="sum-tok"
                            type="number"
                            min={6000}
                            max={150000}
                            step={1000}
                            className="w-28"
                            value={indexing.summarizeTokenThreshold}
                            onChange={(e) =>
                              saveIndexing({
                                ...indexing,
                                summarizeTokenThreshold: clampInt(
                                  e.target.value,
                                  6000,
                                  150000,
                                  indexing.summarizeTokenThreshold
                                ),
                              })
                            }
                          />
                        </Field>
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="log-sysprompt">
                              Log system prompts
                            </FieldLabel>
                            <FieldDescription>
                              Write each turn's assembled system prompt to
                              system-prompt-logs/ for debugging. Off by default.
                            </FieldDescription>
                          </FieldContent>
                          <Switch
                            id="log-sysprompt"
                            checked={indexing.logSystemPrompt}
                            onCheckedChange={(checked) =>
                              saveIndexing({
                                ...indexing,
                                logSystemPrompt: checked,
                              })
                            }
                          />
                        </Field>
                      </TabsContent>

                      {/* Capabilities — skill-source folders. The built-in sources
                        are locked; the user can add/remove extra folders, each
                        scanned as a container of <name>/SKILL.md subfolders. */}
                      <TabsContent
                        value="capabilities"
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-6"
                      >
                        <div className="flex flex-col gap-1">
                          <h3 className="text-sm font-medium">Skill folders</h3>
                          <p className="text-sm text-muted-foreground">
                            Folders scanned for skills. Each should contain
                            per-skill subfolders with a <code>SKILL.md</code>{" "}
                            inside. Built-in sources can't be removed. Workspace
                            folders (<code>.github/skills</code>,{" "}
                            <code>
                              {window.cowork.system().dataDirName}/skills
                            </code>
                            ) are picked up automatically when a workspace is
                            open.
                          </p>
                        </div>
                        {skillSources === null ? (
                          <p className="text-sm text-muted-foreground">
                            Scanning…
                          </p>
                        ) : (
                          <div className="overflow-hidden rounded-lg border">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Folder</TableHead>
                                  <TableHead className="w-24">Skills</TableHead>
                                  <TableHead className="w-24 text-right">
                                    Kind
                                  </TableHead>
                                  <TableHead className="w-12" />
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {skillSources.map((row) => (
                                  <TableRow key={row.path}>
                                    <TableCell className="font-mono text-xs break-all">
                                      {row.path}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                      {row.skillCount}
                                    </TableCell>
                                    <TableCell className="text-right text-muted-foreground">
                                      {SKILL_SOURCE_KIND_LABEL[row.kind]}
                                    </TableCell>
                                    <TableCell className="text-right">
                                      {row.kind === "custom" && (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon-sm"
                                          onClick={() =>
                                            removeSkillFolder(row.path)
                                          }
                                          aria-label={`Remove ${row.path}`}
                                          title="Remove folder"
                                        >
                                          <Trash2 />
                                        </Button>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                              <TableFooter>
                                <TableRow className="hover:bg-transparent">
                                  <TableCell colSpan={4}>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={addSkillFolder}
                                    >
                                      <Plus />
                                      Add folder
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              </TableFooter>
                            </Table>
                          </div>
                        )}

                        {/* Agent-source folders — where <name>.agent.md files
                          live. Custom folders registered here are pulled into
                          every conversation (Chat, Interactive, North Star). */}
                        <div className="flex flex-col gap-1">
                          <h3 className="text-sm font-medium">Agent folders</h3>
                          <p className="text-sm text-muted-foreground">
                            Folders scanned for custom agents. Each should
                            contain <code>&lt;name&gt;.agent.md</code> files.
                            Registered folders apply across Chat, Interactive,
                            and North Star. Built-in sources can't be removed.
                            Workspace folders (<code>.github/agents</code>,{" "}
                            <code>
                              {window.cowork.system().dataDirName}/agents
                            </code>
                            ) are picked up automatically when a workspace is
                            open.
                          </p>
                        </div>
                        {agentSources === null ? (
                          <p className="text-sm text-muted-foreground">
                            Scanning…
                          </p>
                        ) : (
                          <div className="overflow-hidden rounded-lg border">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Folder</TableHead>
                                  <TableHead className="w-24">Agents</TableHead>
                                  <TableHead className="w-24 text-right">
                                    Kind
                                  </TableHead>
                                  <TableHead className="w-12" />
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {agentSources.map((row) => (
                                  <TableRow key={row.path}>
                                    <TableCell className="font-mono text-xs break-all">
                                      {row.path}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                      {row.agentCount}
                                    </TableCell>
                                    <TableCell className="text-right text-muted-foreground">
                                      {AGENT_SOURCE_KIND_LABEL[row.kind]}
                                    </TableCell>
                                    <TableCell className="text-right">
                                      {row.kind === "custom" && (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon-sm"
                                          onClick={() =>
                                            removeAgentFolder(row.path)
                                          }
                                          aria-label={`Remove ${row.path}`}
                                          title="Remove folder"
                                        >
                                          <Trash2 />
                                        </Button>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                              <TableFooter>
                                <TableRow className="hover:bg-transparent">
                                  <TableCell colSpan={4}>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={addAgentFolder}
                                    >
                                      <Plus />
                                      Add folder
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              </TableFooter>
                            </Table>
                          </div>
                        )}

                        {/* MCP-source folders — where mcp.json config files live.
                          Custom folders registered here are scanned alongside the
                          user + workspace configs. Manage individual servers in the
                          MCP view (sidebar). */}
                        <div className="flex flex-col gap-1">
                          <h3 className="text-sm font-medium">MCP folders</h3>
                          <p className="text-sm text-muted-foreground">
                            Folders scanned for an <code>mcp.json</code> config.
                            Built-in sources can't be removed. Workspace configs (
                            <code>.github/mcp.json</code>,{" "}
                            <code>
                              {window.cowork.system().dataDirName}/mcp.json
                            </code>
                            ) are picked up automatically when a workspace is open.
                          </p>
                        </div>
                        {mcpSources === null ? (
                          <p className="text-sm text-muted-foreground">
                            Scanning…
                          </p>
                        ) : (
                          <div className="overflow-hidden rounded-lg border">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Folder</TableHead>
                                  <TableHead className="w-24">
                                    Servers
                                  </TableHead>
                                  <TableHead className="w-24 text-right">
                                    Kind
                                  </TableHead>
                                  <TableHead className="w-12" />
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {mcpSources.map((row) => (
                                  <TableRow key={row.path}>
                                    <TableCell className="font-mono text-xs break-all">
                                      {row.path}
                                    </TableCell>
                                    <TableCell className="text-muted-foreground">
                                      {row.serverCount}
                                    </TableCell>
                                    <TableCell className="text-right text-muted-foreground">
                                      {MCP_SOURCE_KIND_LABEL[row.kind]}
                                    </TableCell>
                                    <TableCell className="text-right">
                                      {row.kind === "custom" && (
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon-sm"
                                          onClick={() =>
                                            removeMcpFolder(row.path)
                                          }
                                          aria-label={`Remove ${row.path}`}
                                          title="Remove folder"
                                        >
                                          <Trash2 />
                                        </Button>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                              <TableFooter>
                                <TableRow className="hover:bg-transparent">
                                  <TableCell colSpan={4}>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={addMcpFolder}
                                    >
                                      <Plus />
                                      Add folder
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              </TableFooter>
                            </Table>
                          </div>
                        )}
                      </TabsContent>

                      {/* Agent browser preferences. */}
                      <TabsContent
                        value="browser"
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-6"
                      >
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="browser-reveal">
                              Show the browser when the agent uses it
                            </FieldLabel>
                            <FieldDescription>
                              Bring the browser window to the front when the
                              agent navigates in the conversation you're
                              viewing. When off, the browser stays hidden and
                              works in the background (a login or CAPTCHA still
                              brings it up).
                            </FieldDescription>
                          </FieldContent>
                          <Switch
                            id="browser-reveal"
                            checked={browser.revealOnAgentUse === "always"}
                            onCheckedChange={(checked) =>
                              saveBrowser({
                                revealOnAgentUse: checked ? "always" : "never",
                              })
                            }
                          />
                        </Field>
                      </TabsContent>

                      {/* Appearance — the brand accent + neutral colors. Editing
                        a picker live-previews the whole app; Save persists (over
                        the .env preset), Reset clears the override. */}
                      <TabsContent
                        value="appearance"
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-6"
                      >
                        {themeDraft && (
                          <AppearanceSection
                            draft={themeDraft}
                            saved={savedTheme}
                            onPreview={previewTheme}
                            onSave={saveTheme}
                            onReset={resetTheme}
                          />
                        )}
                      </TabsContent>

                      {/* Editor — which IDE a changed-file pill / "open in editor"
                        launches. Opens the repo root first (focusing an existing
                        window), then the file. "System Default" uses the OS. */}
                      <TabsContent
                        value="editor"
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-6"
                      >
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="editor-ide">
                              Open files in
                            </FieldLabel>
                            <FieldDescription>
                              When you click a changed-file pill, open it here.
                              The repo root opens first so an already-open
                              window is reused; then the file opens in it.
                              "System Default" uses your OS's default app for
                              the file type.
                            </FieldDescription>
                          </FieldContent>
                          <Select
                            value={ide.ide}
                            onValueChange={(value) => saveIde({ ide: value })}
                          >
                            <SelectTrigger id="editor-ide" className="w-48">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="system">
                                System Default
                              </SelectItem>
                              {ideOptions.map((opt) => (
                                <SelectItem key={opt.id} value={opt.id}>
                                  {opt.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      </TabsContent>

                      {/* Desktop notifications — master switch + per-event opt-ins.
                        The renderer only fires when the window is unfocused, or
                        focused on a different conversation than the event is
                        about, so these never interrupt what you're looking at. */}
                      <TabsContent
                        value="notifications"
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-6"
                      >
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="notif-enabled">
                              Desktop notifications
                            </FieldLabel>
                            <FieldDescription>
                              Show a system notification when the agent needs
                              you or finishes work — but only while the app is
                              in the background or you're viewing another
                              conversation.
                            </FieldDescription>
                          </FieldContent>
                          <Switch
                            id="notif-enabled"
                            checked={notifications.enabled}
                            onCheckedChange={(checked) =>
                              saveNotifications({
                                ...notifications,
                                enabled: checked,
                              })
                            }
                          />
                        </Field>
                        {NOTIFICATION_EVENTS.map((evt) => (
                          <Field key={evt.key} orientation="horizontal">
                            <FieldContent>
                              <FieldLabel htmlFor={`notif-${evt.key}`}>
                                {evt.label}
                              </FieldLabel>
                              <FieldDescription>{evt.help}</FieldDescription>
                            </FieldContent>
                            <Switch
                              id={`notif-${evt.key}`}
                              // The per-event toggles are meaningless with the
                              // master switch off — disable them to make that clear.
                              disabled={!notifications.enabled}
                              checked={notifications[evt.key]}
                              onCheckedChange={(checked) =>
                                saveNotifications({
                                  ...notifications,
                                  [evt.key]: checked,
                                })
                              }
                            />
                          </Field>
                        ))}
                      </TabsContent>

                      {/* Sandbox auto-approve — master switch + per-category opt-ins.
                        Only meaningful with a container backend (tab is disabled otherwise). */}
                      <TabsContent
                        value="sandbox"
                        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-6"
                      >
                        <Field orientation="horizontal">
                          <FieldContent>
                            <FieldLabel htmlFor="sandbox-master">
                              Sandbox auto-approve
                            </FieldLabel>
                            <FieldDescription>
                              Auto-approve selected actions while running in a
                              container. Hard-blocked commands are never
                              auto-approved.
                            </FieldDescription>
                          </FieldContent>
                          <Switch
                            id="sandbox-master"
                            checked={execution.sandbox.autoApprove}
                            onCheckedChange={(checked) =>
                              saveExecution({
                                ...execution,
                                sandbox: {
                                  ...execution.sandbox,
                                  autoApprove: checked,
                                },
                              })
                            }
                          />
                        </Field>

                        {execution.sandbox.autoApprove &&
                          CATEGORY_ORDER.map((cat) => (
                            <Field key={cat} orientation="horizontal">
                              <FieldContent>
                                <FieldLabel htmlFor={`cat-${cat}`}>
                                  {CATEGORY_META[cat].label}
                                </FieldLabel>
                                <FieldDescription>
                                  {CATEGORY_META[cat].help}
                                </FieldDescription>
                              </FieldContent>
                              <Switch
                                id={`cat-${cat}`}
                                checked={
                                  execution.sandbox.categories[cat] === true
                                }
                                onCheckedChange={(checked) =>
                                  saveExecution({
                                    ...execution,
                                    sandbox: {
                                      ...execution.sandbox,
                                      categories: {
                                        ...execution.sandbox.categories,
                                        [cat]: checked,
                                      },
                                    },
                                  })
                                }
                              />
                            </Field>
                          ))}
                      </TabsContent>
                    </div>
                  </div>
                </Tabs>
              )}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </Dialog>

      {/* One-time explanation the first time a container backend is chosen. */}
      <Dialog
        open={onboarding !== null}
        onOpenChange={(o) => !o && resolveOnboarding(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable sandbox auto-approve?</DialogTitle>
            <DialogDescription>
              You're now running tools inside an isolated container — a bad
              command trashes the container, not your machine. You can let the
              agent auto-approve a curated set of otherwise-prompting actions
              (starting with workspace edits). Catastrophic commands (e.g.{" "}
              <code>rm -rf /</code>) are still always blocked. You can change
              this anytime in Settings.
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

// The Appearance section body: two color rows (accent + neutral), each a native
// swatch + a hex field, with live preview on change and Save / Reset actions.
// `null` on a channel means "use the .env preset / default" — the swatch shows
// that effective default. Save is disabled while a hex is invalid or nothing
// changed; Reset clears the whole override.
function AppearanceSection({
  draft,
  saved,
  onPreview,
  onSave,
  onReset,
}: {
  draft: ThemeSettings
  saved: ThemeSettings | null
  onPreview: (next: ThemeSettings) => void
  onSave: () => void
  onReset: () => void
}) {
  const accentValid = draft.accent === null || hexToOklch(draft.accent) !== null
  const neutralValid =
    draft.neutral === null || hexToOklch(draft.neutral) !== null
  const allValid = accentValid && neutralValid
  const dirty =
    (draft.accent ?? null) !== (saved?.accent ?? null) ||
    (draft.neutral ?? null) !== (saved?.neutral ?? null)
  const hasOverride = draft.accent !== null || draft.neutral !== null

  return (
    <div className="flex flex-col gap-6">
      <ColorField
        label="Accent color"
        description="The brand / primary hue — buttons, links, active states."
        fallbackHex={DEFAULT_ACCENT_HEX}
        value={draft.accent}
        valid={accentValid}
        onChange={(accent) => onPreview({ ...draft, accent })}
      />
      <ColorField
        label="Neutral color"
        description="The surface base — backgrounds, cards, borders, muted text."
        fallbackHex={DEFAULT_NEUTRAL_HEX}
        value={draft.neutral}
        valid={neutralValid}
        onChange={(neutral) => onPreview({ ...draft, neutral })}
      />
      <p className="text-xs text-muted-foreground">
        Changes preview live. Save to keep them (this overrides the preset colors
        from the app config); Reset to preset clears your override.
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={!allValid || !dirty}>
          Save
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onReset}
          disabled={!hasOverride && !dirty}
        >
          Reset to preset
        </Button>
      </div>
    </div>
  )
}

// One color row: a native color swatch + a hex text field, kept in sync. The
// swatch always shows a concrete hex (the value, or `fallbackHex` when the value
// is null / invalid); typing in the field drives `onChange` (null when cleared).
function ColorField({
  label,
  description,
  fallbackHex,
  value,
  valid,
  onChange,
}: {
  label: string
  description: string
  fallbackHex: string
  value: string | null
  valid: boolean
  onChange: (next: string | null) => void
}) {
  // The swatch needs a full #rrggbb; fall back to the default when the field is
  // empty or not yet a valid hex.
  const swatchHex = value && hexToOklch(value) ? normalizeHex(value) : fallbackHex
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel>{label}</FieldLabel>
        <FieldDescription>{description}</FieldDescription>
        {!valid && (
          <p className="text-xs text-destructive">
            Enter a valid hex color (e.g. #2563eb).
          </p>
        )}
      </FieldContent>
      <div className="flex shrink-0 items-center gap-2">
        <input
          type="color"
          aria-label={`${label} swatch`}
          value={swatchHex}
          onChange={(e) => onChange(e.target.value)}
          className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
        />
        <Input
          value={value ?? ""}
          placeholder={fallbackHex}
          spellCheck={false}
          onChange={(e) => {
            const v = e.target.value.trim()
            onChange(v === "" ? null : v)
          }}
          aria-invalid={!valid}
          className="w-32 font-mono text-xs"
        />
      </div>
    </Field>
  )
}

// Normalize a valid hex (expand #rgb → #rrggbb, add the hash) so <input
// type="color"> accepts it. Assumes the input already passed hexToOklch.
function normalizeHex(hex: string): string {
  let h = hex.trim().replace(/^#/, "")
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("")
  return `#${h.toLowerCase()}`
}
