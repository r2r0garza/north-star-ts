import { useCallback, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { ChevronRight, Plus, Trash2, XIcon } from "lucide-react"
import { Dialog, DialogTitle } from "@/components/ui/dialog"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Markdown } from "@/components/markdown"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import type { AgentDefinition, AgentFolder, AgentTree } from "@/types"

// The Agents view — a full-viewport takeover (same shell as SkillsScreen) for
// browsing, editing, creating, and deleting `<name>.agent.md` agents. The left
// rail is the same two-level tree (Global / Workspace / Custom). The main pane is
// a STRUCTURED form (not raw text): metadata inputs + All/None/Choose tri-state
// pickers for tools / skills / children, so the load-bearing undefined-vs-[]
// distinction is expressed as UI rather than hand-edited YAML. Serialization lives
// in the main process (agents:save takes structured fields).
//
// Writability follows the folder kind: user + custom are editable/deletable;
// github + workspace agents are read-only here (viewable only).

// The 8 friendly tool categories, in display order. Mirrors TOOL_CATEGORIES in
// the main process (src/main/agent/agents/tool-categories.ts). Duplicated here
// rather than imported to avoid pulling a main-process module into the renderer.
const TOOL_CATEGORIES = [
  "read",
  "search",
  "edit",
  "execute",
  "web",
  "browser",
  "todo",
  "agent",
] as const

// A flat, addressable agent: its definition + folder kind + a key unique across
// folders (source dir + name), since the same name can appear in several.
type CatalogAgent = AgentDefinition & { key: string; kind: AgentFolder["kind"] }

function agentKey(sourcePath: string, name: string): string {
  return `${sourcePath} ${name}`
}

// Whether a folder kind is writable (editable/deletable) in this UI.
function isWritable(kind: AgentFolder["kind"]): boolean {
  return kind === "user" || kind === "custom"
}

// The editable field set (mirrors the main-process AgentFields).
type Draft = {
  name: string
  description: string
  tools?: string[]
  skills?: string[]
  children?: string[]
  userInvocable: boolean
  body: string
}

function draftFromAgent(a: AgentDefinition): Draft {
  return {
    name: a.name,
    description: a.description,
    tools: a.tools,
    skills: a.skills,
    children: a.children,
    userInvocable: a.userInvocable,
    body: a.body,
  }
}

// The main pane is in one of three modes at a time.
type Mode =
  | { kind: "view" }
  | { kind: "edit" }
  | { kind: "create"; dir: string }

export function AgentsScreen({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [tree, setTree] = useState<AgentTree | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: "view" })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  // Skill names for the skills picker's "Choose" list. Loaded once per open.
  const [skillNames, setSkillNames] = useState<string[]>([])

  // Flatten every folder's agents into one addressable list (tagged with kind).
  const allAgents = useMemo<CatalogAgent[]>(() => {
    if (!tree) return []
    const folders: AgentFolder[] = [
      ...tree.global,
      ...tree.workspaces.flatMap((w) => w.folders),
      ...tree.custom,
    ]
    return folders.flatMap((f) =>
      f.agents.map((a) => ({
        ...a,
        key: agentKey(f.path, a.name),
        kind: f.kind,
      }))
    )
  }, [tree])

  const selected = useMemo(
    () => allAgents.find((a) => a.key === selectedKey) ?? null,
    [allAgents, selectedKey]
  )

  // All agent names (deduped) for the children picker's "Choose" list.
  const agentNames = useMemo(
    () => [...new Set(allAgents.map((a) => a.name))].sort(),
    [allAgents]
  )

  // Writable source dirs (user + custom) for the New-agent target dropdown.
  const writableDirs = useMemo(() => {
    if (!tree) return [] as Array<{ path: string; label: string }>
    return [
      ...tree.global.map((f) => ({ path: f.path, label: "Global (user)" })),
      ...tree.custom.map((f) => ({
        path: f.path,
        label: `Custom · ${f.label}`,
      })),
    ]
  }, [tree])

  const loadTree = useCallback(() => {
    window.cowork.agents.tree().then(setTree)
  }, [])

  // (Re)load whenever the view opens; reset transient edit/create state.
  useEffect(() => {
    if (!open) return
    setTree(null)
    setMode({ kind: "view" })
    setDraft(null)
    setSelectedKey(null)
    loadTree()
    window.cowork.skills
      .list()
      .then((rows) => setSkillNames(rows.map((s) => s.name)))
      .catch(() => setSkillNames([]))
  }, [open, loadTree])

  // Drop a selection that vanished from a refreshed tree.
  useEffect(() => {
    if (selectedKey && tree && !allAgents.some((a) => a.key === selectedKey)) {
      setSelectedKey(null)
      setMode({ kind: "view" })
      setDraft(null)
    }
  }, [tree, allAgents, selectedKey])

  // Dirty whenever a form (edit or create) is open with an in-progress draft.
  const dirty = mode.kind !== "view" && draft !== null

  function confirmDiscard(): boolean {
    return !dirty || window.confirm("Discard unsaved changes to this agent?")
  }

  function selectAgent(key: string) {
    if (key === selectedKey && mode.kind === "view") return
    if (!confirmDiscard()) return
    setSelectedKey(key)
    setMode({ kind: "view" })
    setDraft(null)
  }

  function startEditing() {
    if (!selected) return
    setDraft(draftFromAgent(selected))
    setMode({ kind: "edit" })
  }

  function cancelForm() {
    if (!confirmDiscard()) return
    setMode({ kind: "view" })
    setDraft(null)
  }

  // Open a blank full-form create, targeting the first writable dir.
  function startCreating() {
    if (!confirmDiscard()) return
    setSelectedKey(null)
    setDraft({
      name: "",
      description: "",
      // Permissive defaults, matching the scaffold: all tools, all skills, and
      // no spawn (children undefined).
      tools: undefined,
      skills: undefined,
      children: undefined,
      userInvocable: true,
      body: "",
    })
    setMode({ kind: "create", dir: writableDirs[0]?.path ?? "" })
  }

  async function save() {
    if (!selected || !draft) return
    setSaving(true)
    try {
      await window.cowork.agents.save(selected.path, toFields(draft))
      loadTree()
      setMode({ kind: "view" })
      setDraft(null)
      toast.success("Agent saved")
    } catch (err) {
      toast.error(`Could not save agent: ${err}`)
    } finally {
      setSaving(false)
    }
  }

  // Scaffold the file (create validates name + collision + writable dir), then
  // write the full form to it, refresh, and drop into View on the new agent.
  async function createAgent() {
    if (mode.kind !== "create" || !draft) return
    const name = draft.name.trim()
    if (!name || !mode.dir) return
    setSaving(true)
    try {
      const path = await window.cowork.agents.create({
        dir: mode.dir,
        name,
        description: draft.description.trim(),
      })
      // Persist the full form (tools/skills/children/body/user-invocable) — create
      // only scaffolds name+description with defaults.
      await window.cowork.agents.save(path, toFields({ ...draft, name }))
      loadTree()
      setSelectedKey(agentKey(mode.dir, name))
      setMode({ kind: "view" })
      setDraft(null)
      toast.success("Agent created")
    } catch (err) {
      toast.error(`Could not create agent: ${err}`)
    } finally {
      setSaving(false)
    }
  }

  async function deleteAgent(a: CatalogAgent) {
    if (!isWritable(a.kind)) return
    if (!window.confirm(`Delete agent “${a.name}”? This cannot be undone.`)) {
      return
    }
    try {
      await window.cowork.agents.delete(a.path)
      if (selectedKey === a.key) {
        setSelectedKey(null)
        setMode({ kind: "view" })
        setDraft(null)
      }
      loadTree()
      toast.success("Agent deleted")
    } catch (err) {
      toast.error(`Could not delete agent: ${err}`)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-slot="agents-screen"
          aria-describedby={undefined}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed inset-0 z-50 flex h-screen w-screen flex-col bg-background text-sm text-foreground outline-none data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-2"
        >
          {/* Header row / window drag region (matches the app's h-11 top bar). */}
          <div className="flex h-11 shrink-0 items-center justify-between border-b pr-3 pl-20 [-webkit-app-region:drag]">
            <DialogTitle className="font-heading text-base font-medium">
              Agents
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

          <div className="flex min-h-0 flex-1">
            {/* Left rail — New button + Global (flat) + Workspace/Custom (nested). */}
            <div className="flex w-72 shrink-0 flex-col border-r">
              <div className="shrink-0 border-b p-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={startCreating}
                  disabled={tree === null || writableDirs.length === 0}
                  className="w-full justify-start"
                >
                  <Plus className="size-4" />
                  New agent
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto py-2">
                <AgentGroup
                  label="Global"
                  count={tree?.global.reduce((n, f) => n + f.agents.length, 0)}
                  loading={tree === null}
                >
                  {tree?.global.flatMap((f) =>
                    f.agents.map((a) => (
                      <AgentRow
                        key={agentKey(f.path, a.name)}
                        agent={{
                          ...a,
                          key: agentKey(f.path, a.name),
                          kind: f.kind,
                        }}
                        active={agentKey(f.path, a.name) === selectedKey}
                        onSelect={() => selectAgent(agentKey(f.path, a.name))}
                        onDelete={deleteAgent}
                      />
                    ))
                  )}
                  {tree !== null &&
                    tree.global.every((f) => f.agents.length === 0) && (
                      <EmptyLine>No agents.</EmptyLine>
                    )}
                </AgentGroup>

                <AgentGroup
                  label="Workspace"
                  count={tree?.workspaces.reduce(
                    (n, w) =>
                      n + w.folders.reduce((m, f) => m + f.agents.length, 0),
                    0
                  )}
                  loading={tree === null}
                >
                  {tree?.workspaces.length === 0 && (
                    <EmptyLine>No workspaces opened yet.</EmptyLine>
                  )}
                  {tree?.workspaces.map((ws) => {
                    const wsAgents = ws.folders.flatMap((f) =>
                      f.agents.map((a) => ({ folder: f, agent: a }))
                    )
                    return (
                      <AgentFolderNode
                        key={ws.path}
                        label={ws.label}
                        count={wsAgents.length}
                      >
                        {wsAgents.map(({ folder, agent }) => (
                          <AgentRow
                            key={agentKey(folder.path, agent.name)}
                            agent={{
                              ...agent,
                              key: agentKey(folder.path, agent.name),
                              kind: folder.kind,
                            }}
                            active={
                              agentKey(folder.path, agent.name) === selectedKey
                            }
                            onSelect={() =>
                              selectAgent(agentKey(folder.path, agent.name))
                            }
                            onDelete={deleteAgent}
                          />
                        ))}
                        {wsAgents.length === 0 && (
                          <EmptyLine>No agents.</EmptyLine>
                        )}
                      </AgentFolderNode>
                    )
                  })}
                </AgentGroup>

                <AgentGroup
                  label="Custom"
                  count={tree?.custom.reduce((n, f) => n + f.agents.length, 0)}
                  loading={tree === null}
                >
                  {tree?.custom.length === 0 && (
                    <EmptyLine>No custom folders.</EmptyLine>
                  )}
                  {tree?.custom.map((folder) => (
                    <AgentFolderNode
                      key={folder.path}
                      label={folder.label}
                      count={folder.agents.length}
                    >
                      {folder.agents.map((a) => (
                        <AgentRow
                          key={agentKey(folder.path, a.name)}
                          agent={{
                            ...a,
                            key: agentKey(folder.path, a.name),
                            kind: folder.kind,
                          }}
                          active={agentKey(folder.path, a.name) === selectedKey}
                          onSelect={() =>
                            selectAgent(agentKey(folder.path, a.name))
                          }
                          onDelete={deleteAgent}
                        />
                      ))}
                      {folder.agents.length === 0 && (
                        <EmptyLine>No agents.</EmptyLine>
                      )}
                    </AgentFolderNode>
                  ))}
                </AgentGroup>
              </div>
            </div>

            {/* Main pane — full form (create/edit) or read-only view. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {mode.kind === "create" && draft ? (
                <>
                  <FormHeader
                    title="New agent"
                    saving={saving}
                    saveLabel={saving ? "Creating…" : "Create"}
                    canSave={!!draft.name.trim() && !!mode.dir}
                    onCancel={cancelForm}
                    onSave={createAgent}
                  />
                  <AgentForm
                    draft={draft}
                    onChange={setDraft}
                    skillNames={skillNames}
                    agentNames={agentNames}
                    nameEditable
                    dirs={writableDirs}
                    dir={mode.dir}
                    onDirChange={(dir) => setMode({ kind: "create", dir })}
                  />
                </>
              ) : mode.kind === "edit" && draft && selected ? (
                <>
                  <FormHeader
                    title={selected.name}
                    subtitle={selected.path}
                    saving={saving}
                    saveLabel={saving ? "Saving…" : "Save"}
                    canSave
                    onCancel={cancelForm}
                    onSave={save}
                  />
                  <AgentForm
                    draft={draft}
                    onChange={setDraft}
                    skillNames={skillNames}
                    agentNames={agentNames.filter((n) => n !== draft.name)}
                  />
                </>
              ) : selected ? (
                <>
                  <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{selected.name}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {selected.path}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {isWritable(selected.kind) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={startEditing}
                        >
                          Edit
                        </Button>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Read-only
                        </span>
                      )}
                    </div>
                  </div>
                  <AgentView agent={selected} />
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
                  Select an agent to view, or create a new one.
                </div>
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  )
}

// Map a Draft to the main-process AgentFields (identical shape today; a seam if
// they diverge).
function toFields(d: Draft) {
  return {
    name: d.name,
    description: d.description,
    tools: d.tools,
    skills: d.skills,
    children: d.children,
    userInvocable: d.userInvocable,
    body: d.body,
  }
}

// ── Form header (shared by create + edit) ───────────────────────────────────

function FormHeader({
  title,
  subtitle,
  saving,
  saveLabel,
  canSave,
  onCancel,
  onSave,
}: {
  title: string
  subtitle?: string
  saving: boolean
  saveLabel: string
  canSave: boolean
  onCancel: () => void
  onSave: () => void
}) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
      <div className="min-w-0">
        <p className="truncate font-medium">{title}</p>
        {subtitle && (
          <p className="truncate font-mono text-xs text-muted-foreground">
            {subtitle}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={saving || !canSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  )
}

// ── Structured form (shared by create + edit) ───────────────────────────────

function AgentForm({
  draft,
  onChange,
  skillNames,
  agentNames,
  nameEditable = false,
  dirs,
  dir,
  onDirChange,
}: {
  draft: Draft
  onChange: (d: Draft) => void
  skillNames: string[]
  agentNames: string[]
  // Create mode only: allow editing the name and choosing a target location.
  nameEditable?: boolean
  dirs?: Array<{ path: string; label: string }>
  dir?: string
  onDirChange?: (dir: string) => void
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="max-w-2xl space-y-6 px-6 py-5">
        {nameEditable && (
          <Field
            label="Name"
            hint="Lowercase letters, digits, and single hyphens. Becomes the file name."
          >
            <Input
              value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              placeholder="my-agent"
              autoFocus
            />
          </Field>
        )}

        {nameEditable && dirs && onDirChange && (
          <Field label="Location">
            <Select value={dir} onValueChange={onDirChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a location" />
              </SelectTrigger>
              <SelectContent>
                {dirs.map((d) => (
                  <SelectItem key={d.path} value={d.path}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        <Field label="Description" hint="What it does and when to use it.">
          <Textarea
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            spellCheck={false}
            className="min-h-20 resize-y text-sm leading-relaxed"
            placeholder="Reviews code for correctness and style."
          />
        </Field>

        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm">User-invocable</Label>
            <p className="text-xs text-muted-foreground">
              Show this agent in the composer picker. Non-invocable agents are
              still reachable as another agent's child.
            </p>
          </div>
          <Switch
            checked={draft.userInvocable}
            onCheckedChange={(v) => onChange({ ...draft, userInvocable: v })}
          />
        </div>

        <TriStatePicker
          label="Tools"
          hint="All tools, read-only floor (read + search), or a chosen set of categories."
          allLabel="All tools"
          noneLabel="Read-only (read + search)"
          options={TOOL_CATEGORIES as readonly string[]}
          value={draft.tools}
          onChange={(tools) => onChange({ ...draft, tools })}
        />

        <TriStatePicker
          label="Skills"
          hint="All applicable skills, none, or a chosen set."
          allLabel="All skills"
          noneLabel="No skills"
          options={skillNames}
          value={draft.skills}
          onChange={(skills) => onChange({ ...draft, skills })}
          emptyOptionsNote="No skills found."
        />

        <TriStatePicker
          label="Children (subagents)"
          hint="Which agents this one may spawn. Only takes effect if 'agent' is in Tools."
          allLabel="Cannot spawn"
          noneLabel="Any agent"
          options={agentNames}
          value={draft.children}
          onChange={(children) => onChange({ ...draft, children })}
          emptyOptionsNote="No other agents to choose."
        />

        <Field label="System prompt" hint="The agent's instructions (markdown).">
          <Textarea
            value={draft.body}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
            spellCheck={false}
            className="min-h-64 resize-y font-mono text-xs leading-relaxed"
          />
        </Field>
      </div>
    </ScrollArea>
  )
}

// A three-way control mapping to the tri-state list contract:
//   All    → undefined (key omitted)
//   None   → []        (key present, empty)
//   Choose → [list]
// The mode is tracked as LOCAL state, not derived from the value, so "Choose"
// with nothing checked yet ([]) stays in Choose mode rather than snapping back to
// None (both are the empty array). Switching to Choose keeps any existing list.
type TriMode = "all" | "none" | "choose"

function modeOf(value: string[] | undefined): TriMode {
  if (value === undefined) return "all"
  if (value.length === 0) return "none"
  return "choose"
}

function TriStatePicker({
  label,
  hint,
  allLabel,
  noneLabel,
  options,
  value,
  onChange,
  emptyOptionsNote,
}: {
  label: string
  hint?: string
  allLabel: string
  noneLabel: string
  options: readonly string[]
  value: string[] | undefined
  onChange: (v: string[] | undefined) => void
  emptyOptionsNote?: string
}) {
  // Seed the mode from the incoming value, then own it locally so an empty
  // "Choose" selection doesn't get misread as "None".
  const [mode, setMode] = useState<TriMode>(() => modeOf(value))

  function changeMode(next: TriMode) {
    setMode(next)
    if (next === "all") onChange(undefined)
    else if (next === "none") onChange([])
    else onChange(value ?? []) // Choose: keep any existing selection, else start empty
  }

  function toggle(name: string, checked: boolean) {
    const cur = value ?? []
    onChange(checked ? [...cur, name] : cur.filter((n) => n !== name))
  }

  return (
    <div className="space-y-2">
      <div>
        <Label className="text-sm">{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Select value={mode} onValueChange={(v) => changeMode(v as TriMode)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          <SelectItem value="none">{noneLabel}</SelectItem>
          <SelectItem value="choose">Choose…</SelectItem>
        </SelectContent>
      </Select>
      {mode === "choose" && (
        <div className="rounded-md border p-3">
          {options.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {emptyOptionsNote ?? "Nothing to choose."}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {options.map((name) => {
                const checked = !!value?.includes(name)
                return (
                  <label
                    key={name}
                    className="flex cursor-pointer items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => toggle(name, v === true)}
                    />
                    <span className="truncate">{name}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Read-only view ──────────────────────────────────────────────────────────

function AgentView({ agent }: { agent: AgentDefinition }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="max-w-2xl space-y-4 px-6 py-5">
        <p className="text-sm text-muted-foreground">{agent.description}</p>
        <div className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-sm">
          <ViewRow
            label="Tools"
            value={triSummary(agent.tools, "All tools", "Read-only")}
          />
          <ViewRow
            label="Skills"
            value={triSummary(agent.skills, "All skills", "None")}
          />
          <ViewRow
            label="Children"
            value={triSummary(agent.children, "Cannot spawn", "Any agent")}
          />
          <ViewRow
            label="User-invocable"
            value={agent.userInvocable ? "Yes" : "No"}
          />
        </div>
        <div className="border-t pt-4">
          <Markdown content={agent.body} />
        </div>
      </div>
    </ScrollArea>
  )
}

function triSummary(
  value: string[] | undefined,
  allLabel: string,
  emptyLabel: string
): string {
  if (value === undefined) return allLabel
  if (value.length === 0) return emptyLabel
  return value.join(", ")
}

function ViewRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="break-words">{value}</span>
    </>
  )
}

// ── Shared field wrapper ────────────────────────────────────────────────────

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ── Left-rail tree pieces (mirror skills-screen) ────────────────────────────

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs text-muted-foreground">{children}</p>
}

function AgentGroup({
  label,
  count,
  loading,
  children,
}: {
  label: string
  count: number | undefined
  loading: boolean
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(true)
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <SidebarGroup>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group/agentgroup flex w-full items-center gap-1"
          >
            <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]/agentgroup:rotate-90" />
            <SidebarGroupLabel className="cursor-pointer">
              {label}
              <span className="ml-1 text-muted-foreground">
                ({loading ? "…" : (count ?? 0)})
              </span>
            </SidebarGroupLabel>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>{children}</SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}

function AgentFolderNode({
  label,
  count,
  children,
}: {
  label: string
  count: number
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group/agentfolder flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-sm hover:bg-sidebar-accent"
        >
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/agentfolder:rotate-90" />
          <span className="truncate">{label}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {count}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pl-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}

// One clickable agent row: name + (clamped) description, with a hover delete for
// writable (user/custom) agents.
function AgentRow({
  agent,
  active,
  onSelect,
  onDelete,
}: {
  agent: CatalogAgent
  active: boolean
  onSelect: () => void
  onDelete: (a: CatalogAgent) => void
}) {
  return (
    <SidebarMenuItem className="group/agentrow relative">
      <SidebarMenuButton
        isActive={active}
        onClick={onSelect}
        className={cn("h-auto flex-col items-start gap-0.5 py-1.5 pr-8")}
      >
        <div className="w-full truncate font-medium">{agent.name}</div>
        <div className="line-clamp-2 w-full text-xs font-normal text-muted-foreground">
          {agent.description}
        </div>
      </SidebarMenuButton>
      {isWritable(agent.kind) && (
        <button
          type="button"
          aria-label={`Delete ${agent.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(agent)
          }}
          className="absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/agentrow:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </SidebarMenuItem>
  )
}
