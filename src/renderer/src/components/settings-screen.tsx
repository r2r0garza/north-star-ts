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
  IdeSettings,
  Backend,
  ApprovalCategory,
  Runtime,
  RuntimeStatus,
  SkillSourceRow,
} from "@/types"

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
  { value: "editor", label: "Editor" },
  { value: "sandbox", label: "Sandbox" },
]

// Human-readable labels for the non-custom (locked) skill-source kinds.
const SKILL_SOURCE_KIND_LABEL: Record<SkillSourceRow["kind"], string> = {
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
  // Skill-source rows for the Capabilities tab (built-in + custom folders, each
  // with a live skill count). Loaded independently of the other settings so a
  // slow directory scan doesn't gate the whole screen.
  const [skillSources, setSkillSources] = useState<SkillSourceRow[] | null>(
    null
  )
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
      window.cowork.settings.checkRuntimes(),
    ]).then(([exec, perms, idx, br, ideCfg, ideOpts, rt]) => {
      if (cancelled) return
      setExecution(exec)
      setPermissions(perms)
      setIndexing(idx)
      setBrowser(br)
      setIde(ideCfg)
      setIdeOptions(ideOpts)
      setRuntimes(rt)
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
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogPrimitive.Portal>
          {/* Full-viewport takeover. Built on the raw Radix primitive so we get
              the focus-trap / Escape-to-close / portal for free, but WITHOUT the
              centered-modal translate + zoom animation of the shared
              DialogContent (twMerge can't strip tw-animate-css utilities). */}
          <DialogPrimitive.Content
            data-slot="settings-screen"
            aria-describedby={undefined}
            // A full-screen takeover has no meaningful "outside" to click, so
            // close is Escape / the [X] only. This also fixes a Radix quirk: an
            // open modal Select sets `pointer-events: none` on the body, so a
            // click dismissing the dropdown resolves its target to <body> — which
            // the dialog would otherwise read as an outside-click and close on.
            onInteractOutside={(e) => e.preventDefault()}
            className="fixed inset-0 z-50 flex h-screen w-screen flex-col bg-background text-sm text-foreground outline-none data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-2"
          >
            {/* Header row. Doubles as the window drag region (matching the app's
                h-11 top bar) so the window stays draggable; interactive children
                opt out with no-drag. Left padding clears the macOS traffic
                lights; the close button sits top-right. */}
            <div className="flex h-11 shrink-0 items-center justify-between border-b pr-3 pl-20 [-webkit-app-region:drag]">
              <DialogTitle className="font-heading text-base font-medium">
                Settings
              </DialogTitle>
              <DialogPrimitive.Close asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="[-webkit-app-region:no-drag]"
                >
                  <XIcon />
                  <span className="sr-only">Close</span>
                </Button>
              </DialogPrimitive.Close>
            </div>

            {execution && permissions && indexing && browser && ide && (
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
                          On the local backend every file write and edit already
                          requires approval — these toggles take effect only when
                          running in a container.
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
                              file_write: checked ? "require_approval" : "auto",
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
                            Build a background index when a workspace is opened,
                            so the agent can answer about it right away.
                            Per-workspace disable overrides this.
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
                            Feed a compact workspace summary into the agent. Off
                            = the index still builds but the agent ignores it.
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
                            Regenerate the summary once the un-summarized turns
                            reach this many tokens (whichever threshold is hit
                            first). Range 6,000–150,000.
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
                          <code>{window.cowork.system().dataDirName}/skills</code>
                          ) are picked up automatically when a workspace is open.
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
                            Bring the browser window to the front when the agent
                            navigates in the conversation you're viewing. When
                            off, the browser stays hidden and works in the
                            background (a login or CAPTCHA still brings it up).
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
                            When you click a changed-file pill, open it here. The
                            repo root opens first so an already-open window is
                            reused; then the file opens in it. "System Default"
                            uses your OS's default app for the file type.
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
