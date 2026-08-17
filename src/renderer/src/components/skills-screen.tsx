import { useCallback, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import {
  ArrowLeft,
  ChevronRight,
  FolderOpen,
  Plus,
  Search,
  Trash2,
  Upload,
  XIcon,
} from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Markdown } from "@/components/markdown"
import { SkillUploadModal } from "@/components/skill-upload-modal"
import { toast } from "sonner"
import type { SkillFolder, SkillMetadata, SkillTree } from "@/types"

// The Skills view — an in-panel destination (rendered in the center region of
// the app shell, beside the still-visible sidebar) for browsing, editing,
// creating, and deleting SKILL.md files. Browsing is a 3-tab card grid
// (Global / Workspace / Custom); Workspace groups skills into collapsed sections
// per workspace. Selecting a card, editing, or creating takes over the panel:
// the read-only view renders the skill's markdown; edit round-trips the RAW file
// (frontmatter + body) so YAML stays intact; create is a small metadata + body
// form. Loaded via skills.tree(), which enumerates ALL known workspaces, so the
// view is populated even with no active conversation.
//
// Writability follows the folder kind: user + custom are editable/deletable;
// github + workspace skills are read-only here (viewable only). "Add new skill"
// is disabled on the Workspace tab since workspace folders are not writable here.

// A flat, addressable skill: its metadata + folder kind + a key that uniquely
// identifies it across folders (source dir + name), since the same name can
// appear in several.
type CatalogSkill = SkillMetadata & { key: string; kind: SkillFolder["kind"] }

function skillKey(sourcePath: string, name: string): string {
  return `${sourcePath} ${name}`
}

// Whether a folder kind is writable (editable/deletable) in this UI.
function isWritable(kind: SkillFolder["kind"]): boolean {
  return kind === "user" || kind === "custom"
}

// The OS file-manager name, for the reveal button label. shell.showItemInFolder
// does the right thing on every platform; this is only the human-facing word.
function fileManagerName(): string {
  const ua = navigator.userAgent
  if (ua.includes("Mac")) return "Finder"
  if (ua.includes("Win")) return "Explorer"
  return "file manager"
}

// Case-insensitive substring match over a skill's name + description. A blank
// query matches everything.
function matchesQuery(s: SkillMetadata, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
  )
}

// The main pane is in one of three modes at a time. (Import is a modal overlay,
// not a pane mode — see importOpen + SkillUploadModal.)
type Mode =
  | { kind: "view" }
  | { kind: "edit" }
  | {
      kind: "create"
      dir: string
      name: string
      description: string
      body: string
    }

type SkillTab = "global" | "workspace" | "custom"

export function SkillsScreen({ onClose }: { onClose: () => void }) {
  const [tree, setTree] = useState<SkillTree | null>(null)
  // Selected skill's key (source path + name), or null when nothing is selected.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: "view" })
  // Whether the Upload-skill modal is open (import is an overlay, not a pane mode).
  const [importOpen, setImportOpen] = useState(false)
  // The raw SKILL.md text being edited (null until loaded / not editing).
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // Which browse tab is active. Independent of the view/edit/create takeover, so
  // Back/Cancel return the user to the tab they came from.
  const [activeTab, setActiveTab] = useState<SkillTab>("global")
  // Free-text filter over the cards (matches name + description). Applies across
  // all three tabs.
  const [query, setQuery] = useState("")

  // Flatten every folder's skills into one addressable list (tagged with kind),
  // so selection and the dirty-guard don't care about the tree's shape.
  const allSkills = useMemo<CatalogSkill[]>(() => {
    if (!tree) return []
    const folders: SkillFolder[] = [
      ...tree.global,
      ...tree.workspaces.flatMap((w) => w.folders),
      ...tree.custom,
    ]
    return folders.flatMap((f) =>
      f.skills.map((s) => ({
        ...s,
        key: skillKey(f.path, s.name),
        kind: f.kind,
      }))
    )
  }, [tree])

  const selected = useMemo(
    () => allSkills.find((s) => s.key === selectedKey) ?? null,
    [allSkills, selectedKey]
  )

  // Writable source dirs (user + custom) for the New-skill target dropdown.
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
    window.cowork.skills.tree().then(setTree)
  }, [])

  // Load on mount. The component is mounted only while the Skills view is open
  // (main.tsx renders it conditionally), so it starts fresh each time.
  useEffect(() => {
    loadTree()
  }, [loadTree])

  // Esc closes the view, dropping the user back to their last open conversation.
  // Matches the sidebar-navigation behavior (no discard prompt).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  // Guard against acting on a skill that vanished from a refreshed tree.
  useEffect(() => {
    if (selectedKey && tree && !allSkills.some((s) => s.key === selectedKey)) {
      setSelectedKey(null)
      setMode({ kind: "view" })
      setDraft(null)
    }
  }, [tree, allSkills, selectedKey])

  // Dirty whenever a form (edit or create) is open with in-progress content.
  const dirty =
    (mode.kind === "edit" && draft !== null) ||
    (mode.kind === "create" &&
      (!!mode.name.trim() || !!mode.description.trim() || !!mode.body.trim()))

  function confirmDiscard(): boolean {
    return !dirty || window.confirm("Discard unsaved changes to this skill?")
  }

  // Switch the selected skill, prompting to discard unsaved edits first.
  function selectSkill(key: string) {
    if (key === selectedKey && mode.kind === "view") return
    if (!confirmDiscard()) return
    setSelectedKey(key)
    setMode({ kind: "view" })
    setDraft(null)
  }

  // Return from a view/edit takeover to the tabbed card browser.
  function backToCards() {
    if (!confirmDiscard()) return
    setSelectedKey(null)
    setMode({ kind: "view" })
    setDraft(null)
  }

  // Enter edit mode: fetch the RAW file (frontmatter + body) into the textarea.
  async function startEditing() {
    if (!selected) return
    try {
      const raw = await window.cowork.skills.read(selected.path)
      setDraft(raw)
      setMode({ kind: "edit" })
    } catch (err) {
      toast.error(`Could not open skill for editing: ${err}`)
    }
  }

  function cancelEditing() {
    if (!confirmDiscard()) return
    setMode({ kind: "view" })
    setDraft(null)
  }

  // Reveal the selected skill's SKILL.md in the OS file manager (Finder/Explorer).
  async function revealSkill() {
    if (!selected) return
    try {
      await window.cowork.skills.reveal(selected.path)
    } catch (err) {
      toast.error(`Could not open the folder: ${err}`)
    }
  }

  // Open the blank create form, targeting the first writable dir.
  function startCreating() {
    if (!confirmDiscard()) return
    setSelectedKey(null)
    setDraft(null)
    setMode({
      kind: "create",
      dir: writableDirs[0]?.path ?? "",
      name: "",
      description: "",
      body: "",
    })
  }

  async function save() {
    if (!selected || draft === null) return
    setSaving(true)
    try {
      await window.cowork.skills.write(selected.path, draft)
      // Refetch so the rendered body reflects the saved change, then drop back
      // to View mode.
      loadTree()
      setMode({ kind: "view" })
      setDraft(null)
      toast.success("Skill saved")
    } catch (err) {
      toast.error(`Could not save skill: ${err}`)
    } finally {
      setSaving(false)
    }
  }

  // Scaffold the SKILL.md (create validates name + collision + writable dir) with
  // the authored body, then refresh, select the new skill, and drop into View.
  async function createSkill() {
    if (mode.kind !== "create") return
    const name = mode.name.trim()
    if (!name || !mode.dir) return
    setSaving(true)
    try {
      await window.cowork.skills.create({
        dir: mode.dir,
        name,
        description: mode.description.trim(),
        body: mode.body,
      })
      loadTree()
      setSelectedKey(skillKey(mode.dir, name))
      setMode({ kind: "view" })
      setDraft(null)
      toast.success("Skill created")
    } catch (err) {
      toast.error(`Could not create skill: ${err}`)
    } finally {
      setSaving(false)
    }
  }

  // Open the Upload-skill modal (import runs there via picker or drag-and-drop).
  function startImport() {
    if (!confirmDiscard()) return
    setImportOpen(true)
  }

  // After the modal imports a skill: refresh the tree, select the new skill (its
  // folder name is the last segment of the returned <dir>/<name>/SKILL.md path),
  // and drop to View.
  function onImported(newPath: string, dir: string) {
    const name = newPath
      .replace(/[/\\]SKILL\.md$/, "")
      .split(/[/\\]/)
      .pop()!
    loadTree()
    setSelectedKey(skillKey(dir, name))
    setMode({ kind: "view" })
    setDraft(null)
  }

  async function deleteSkill(s: CatalogSkill) {
    if (!isWritable(s.kind)) return
    if (!window.confirm(`Delete skill “${s.name}”? This cannot be undone.`)) {
      return
    }
    try {
      await window.cowork.skills.delete(s.path)
      if (selectedKey === s.key) {
        setSelectedKey(null)
        setMode({ kind: "view" })
        setDraft(null)
      }
      loadTree()
      toast.success("Skill deleted")
    } catch (err) {
      toast.error(`Could not delete skill: ${err}`)
    }
  }

  return (
    <div
      data-slot="skills-screen"
      className="flex min-h-0 flex-1 flex-col bg-background pt-11 text-sm text-foreground"
    >
      {/* Header row (matches the app's h-11 top bar; the Shell drag bar sits
          above via pt-11). */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close skills"
          className="group/back flex items-center gap-2 rounded-md text-left"
        >
          <ArrowLeft className="size-4 text-muted-foreground transition-colors group-hover/back:text-foreground" />
          <h1 className="font-heading text-base font-medium">Skills</h1>
        </button>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      {mode.kind === "create" ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
            <p className="truncate font-medium">New skill</p>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={cancelEditing}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={createSkill}
                disabled={saving || !mode.name.trim() || !mode.dir}
              >
                {saving ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="max-w-2xl space-y-6 px-6 py-5">
              <Field label="Location">
                <Select
                  value={mode.dir}
                  onValueChange={(dir) => setMode({ ...mode, dir })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a location" />
                  </SelectTrigger>
                  <SelectContent>
                    {writableDirs.map((d) => (
                      <SelectItem key={d.path} value={d.path}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label="Name"
                hint="Lowercase letters, digits, and single hyphens. Becomes the folder name."
              >
                <Input
                  value={mode.name}
                  onChange={(e) => setMode({ ...mode, name: e.target.value })}
                  placeholder="my-skill"
                  autoFocus
                />
              </Field>
              <Field
                label="Description"
                hint="What it does AND when to use it — this is what the agent sees when deciding to load the skill."
              >
                <Textarea
                  value={mode.description}
                  onChange={(e) =>
                    setMode({ ...mode, description: e.target.value })
                  }
                  spellCheck={false}
                  className="min-h-20 resize-y text-sm leading-relaxed"
                  placeholder="Formats and validates CSV exports before upload."
                />
              </Field>
              <Field
                label="Skill instructions"
                hint="The markdown body the agent reads once the skill is loaded. Leave blank for a starter template."
              >
                <Textarea
                  value={mode.body}
                  onChange={(e) => setMode({ ...mode, body: e.target.value })}
                  spellCheck={false}
                  className="min-h-64 resize-y font-mono text-xs leading-relaxed"
                  placeholder={`# ${mode.name.trim() || "my-skill"}\n\n## When to use\n\n…\n\n## Steps\n\n1. …`}
                />
              </Field>
            </div>
          </ScrollArea>
        </div>
      ) : selected ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={backToCards}
                aria-label="Back to skills"
              >
                <ArrowLeft />
              </Button>
              <div className="min-w-0">
                <p className="truncate font-medium">{selected.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {selected.path}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {mode.kind === "edit" ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={cancelEditing}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" onClick={save} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={revealSkill}
                    title={`Show in ${fileManagerName()}`}
                  >
                    <FolderOpen className="size-4" />
                    Show in {fileManagerName()}
                  </Button>
                  {isWritable(selected.kind) ? (
                    <Button variant="outline" size="sm" onClick={startEditing}>
                      Edit
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Read-only
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
          {mode.kind === "edit" && draft !== null ? (
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-xs leading-relaxed focus-visible:ring-0"
            />
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-6 py-5">
                <Markdown content={selected.body} />
              </div>
            </ScrollArea>
          )}
        </div>
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={(v) => setActiveTab(v as SkillTab)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
            <TabsList variant="line" className="gap-1">
              <TabsTrigger value="global">Global</TabsTrigger>
              <TabsTrigger value="workspace">Workspace</TabsTrigger>
              <TabsTrigger value="custom">Custom</TabsTrigger>
            </TabsList>
            {/* Shown on all tabs; disabled on Workspace (its folders aren't
                writable here) and when there's no writable target dir. */}
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={startImport}
                disabled={
                  activeTab === "workspace" ||
                  tree === null ||
                  writableDirs.length === 0
                }
              >
                <Upload className="size-4" />
                Import
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={startCreating}
                disabled={
                  activeTab === "workspace" ||
                  tree === null ||
                  writableDirs.length === 0
                }
              >
                <Plus className="size-4" />
                Add new skill
              </Button>
            </div>
          </div>

          <div className="shrink-0 border-b px-4 py-2">
            <FilterInput
              value={query}
              onChange={setQuery}
              placeholder="Filter skills…"
            />
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              <TabsContent value="global">
                {(() => {
                  const cards = (tree?.global ?? []).flatMap((f) =>
                    f.skills
                      .filter((s) => matchesQuery(s, query))
                      .map((s) => (
                        <SkillCard
                          key={skillKey(f.path, s.name)}
                          skill={{
                            ...s,
                            key: skillKey(f.path, s.name),
                            kind: f.kind,
                          }}
                          onOpen={() => selectSkill(skillKey(f.path, s.name))}
                          onDelete={deleteSkill}
                        />
                      ))
                  )
                  if (tree !== null && cards.length === 0) {
                    return <EmptyLine>{emptyLabel(query)}</EmptyLine>
                  }
                  return <CardGrid>{cards}</CardGrid>
                })()}
              </TabsContent>

              <TabsContent value="workspace" className="space-y-1">
                {tree?.workspaces.length === 0 && (
                  <EmptyLine>No workspaces opened yet.</EmptyLine>
                )}
                {tree?.workspaces.map((ws) => (
                  <WorkspaceSection
                    key={ws.path}
                    ws={ws}
                    query={query}
                    onOpen={selectSkill}
                    onDelete={deleteSkill}
                  />
                ))}
              </TabsContent>

              <TabsContent value="custom" className="space-y-4">
                {tree?.custom.length === 0 && (
                  <EmptyLine>No custom folders.</EmptyLine>
                )}
                {tree?.custom.map((folder) => {
                  const matched = folder.skills.filter((s) =>
                    matchesQuery(s, query)
                  )
                  return (
                    <div key={folder.path} className="space-y-2">
                      {tree.custom.length > 1 && (
                        <p className="px-1 text-xs font-medium text-muted-foreground">
                          {folder.label}
                        </p>
                      )}
                      <CardGrid>
                        {matched.map((s) => (
                          <SkillCard
                            key={skillKey(folder.path, s.name)}
                            skill={{
                              ...s,
                              key: skillKey(folder.path, s.name),
                              kind: folder.kind,
                            }}
                            onOpen={() =>
                              selectSkill(skillKey(folder.path, s.name))
                            }
                            onDelete={deleteSkill}
                          />
                        ))}
                      </CardGrid>
                      {matched.length === 0 && (
                        <EmptyLine>{emptyLabel(query)}</EmptyLine>
                      )}
                    </div>
                  )
                })}
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      )}

      <SkillUploadModal
        open={importOpen}
        onOpenChange={setImportOpen}
        writableDirs={writableDirs}
        onImported={onImported}
      />
    </div>
  )
}

// A shared field wrapper (label + control + hint), mirroring agents-screen.
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

// ── Card browser pieces ─────────────────────────────────────────────────────

function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs text-muted-foreground">{children}</p>
}

// Empty-state text that reflects whether a filter is narrowing the results.
function emptyLabel(query: string): string {
  return query.trim() ? "No skills match your filter." : "No skills."
}

// The card-filter text field: a search icon + input, with a clear button once
// the user has typed.
function FilterInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => onChange("")}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}

// A responsive grid of skill cards.
function CardGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,20rem))] gap-3">
      {children}
    </div>
  )
}

// One clickable skill card: name + (clamped) description. Writable (user/custom)
// skills get a hover delete; read-only (github/workspace) ones show a badge.
function SkillCard({
  skill,
  onOpen,
  onDelete,
}: {
  skill: CatalogSkill
  onOpen: () => void
  onDelete: (s: CatalogSkill) => void
}) {
  const writable = isWritable(skill.kind)
  return (
    <Card
      size="sm"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onOpen()
        }
      }}
      className="cursor-pointer transition-shadow hover:ring-foreground/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <CardHeader>
        <CardTitle className="truncate">{skill.name}</CardTitle>
        <CardAction className="flex items-center gap-1">
          {writable ? (
            <button
              type="button"
              aria-label={`Delete ${skill.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onDelete(skill)
              }}
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/card:opacity-100 hover:bg-destructive/10 hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
            </button>
          ) : (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              Read-only
            </span>
          )}
        </CardAction>
        <CardDescription className="line-clamp-2">
          {skill.description}
        </CardDescription>
      </CardHeader>
    </Card>
  )
}

// A collapsible section for one workspace (collapsed by default), holding the
// cards for that workspace's skills. When a filter query is active it only shows
// matching skills, auto-expands so matches are visible, and hides itself if it
// has none.
function WorkspaceSection({
  ws,
  query,
  onOpen,
  onDelete,
}: {
  ws: SkillTree["workspaces"][number]
  query: string
  onOpen: (key: string) => void
  onDelete: (s: CatalogSkill) => void
}) {
  const [open, setOpen] = useState(false)
  const filtering = query.trim().length > 0
  const wsSkills = ws.folders
    .flatMap((f) => f.skills.map((s) => ({ folder: f, skill: s })))
    .filter(({ skill }) => matchesQuery(skill, query))
  // A filtered section with no matches drops out entirely.
  if (filtering && wsSkills.length === 0) return null
  return (
    <Collapsible
      open={filtering || open}
      onOpenChange={setOpen}
      disabled={filtering}
      className="border-b"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group/ws flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left hover:bg-accent disabled:hover:bg-transparent"
        >
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/ws:rotate-90" />
          <span className="truncate font-medium">{ws.label}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {wsSkills.length}
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="py-2 pl-6">
          <CardGrid>
            {wsSkills.map(({ folder, skill }) => (
              <SkillCard
                key={skillKey(folder.path, skill.name)}
                skill={{
                  ...skill,
                  key: skillKey(folder.path, skill.name),
                  kind: folder.kind,
                }}
                onOpen={() => onOpen(skillKey(folder.path, skill.name))}
                onDelete={onDelete}
              />
            ))}
          </CardGrid>
          {wsSkills.length === 0 && <EmptyLine>No skills.</EmptyLine>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
