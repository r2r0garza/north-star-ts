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
import type { SkillFolder, SkillMetadata, SkillTree } from "@/types"

// The Skills view — a full-viewport takeover (same shell as SettingsScreen) for
// browsing, editing, creating, and deleting SKILL.md files. The left rail is a
// two-level tree: the top level is Global / Workspace / Custom; under Workspace
// and Custom, a second collapsible level lists each folder (every known repo,
// every custom folder), and under those, the folder's skills. Global is a single
// flat list. Loaded via skills.tree(), which enumerates ALL known workspaces, so
// the view is populated even with no active conversation.
//
// The main pane renders the selected skill's markdown with a View/Edit toggle,
// or a small create form. Editing round-trips the RAW file (frontmatter + body),
// not SkillMetadata.body (which has frontmatter stripped), so YAML stays intact.
//
// Writability follows the folder kind: user + custom are editable/deletable;
// github + workspace skills are read-only here (viewable only).

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

// The main pane is in one of three modes at a time.
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

export function SkillsScreen({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [tree, setTree] = useState<SkillTree | null>(null)
  // Selected skill's key (source path + name), or null when nothing is selected.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: "view" })
  // The raw SKILL.md text being edited (null until loaded / not editing).
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

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

  // (Re)load the tree whenever the view opens. Reset the transient edit state so a
  // reopen starts clean.
  useEffect(() => {
    if (!open) return
    setTree(null)
    setMode({ kind: "view" })
    setDraft(null)
    setSelectedKey(null)
    loadTree()
  }, [open, loadTree])

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
      (!!mode.name.trim() ||
        !!mode.description.trim() ||
        !!mode.body.trim()))

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        {/* Full-viewport takeover — same treatment as SettingsScreen: raw Radix
            primitive (focus-trap / Escape / portal) without the centered-modal
            animation. No meaningful outside to click, so close is Escape / [X]. */}
        <DialogPrimitive.Content
          data-slot="skills-screen"
          aria-describedby={undefined}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed inset-0 z-50 flex h-screen w-screen flex-col bg-background text-sm text-foreground outline-none data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-bottom-2 data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-bottom-2"
        >
          {/* Header row / window drag region (matches the app's h-11 top bar). */}
          <div className="flex h-11 shrink-0 items-center justify-between border-b pr-3 pl-20 [-webkit-app-region:drag]">
            <DialogTitle className="font-heading text-base font-medium">
              Skills
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
                  New skill
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto py-2">
                {/* Global: one flat list of the user dir's skills. */}
                <SkillGroup
                  label="Global"
                  count={tree?.global.reduce((n, f) => n + f.skills.length, 0)}
                  loading={tree === null}
                >
                  {tree?.global.flatMap((f) =>
                    f.skills.map((s) => (
                      <SkillRow
                        key={skillKey(f.path, s.name)}
                        skill={{
                          ...s,
                          key: skillKey(f.path, s.name),
                          kind: f.kind,
                        }}
                        active={skillKey(f.path, s.name) === selectedKey}
                        onSelect={() => selectSkill(skillKey(f.path, s.name))}
                        onDelete={deleteSkill}
                      />
                    ))
                  )}
                  {tree !== null &&
                    tree.global.every((f) => f.skills.length === 0) && (
                      <EmptyLine>No skills.</EmptyLine>
                    )}
                </SkillGroup>

                {/* Workspace: one collapsible folder node per known repo, each
                    combining its .github/skills + .<system>/skills. */}
                <SkillGroup
                  label="Workspace"
                  count={tree?.workspaces.reduce(
                    (n, w) =>
                      n + w.folders.reduce((m, f) => m + f.skills.length, 0),
                    0
                  )}
                  loading={tree === null}
                >
                  {tree?.workspaces.length === 0 && (
                    <EmptyLine>No workspaces opened yet.</EmptyLine>
                  )}
                  {tree?.workspaces.map((ws) => {
                    const wsSkills = ws.folders.flatMap((f) =>
                      f.skills.map((s) => ({ folder: f, skill: s }))
                    )
                    return (
                      <SkillFolderNode
                        key={ws.path}
                        label={ws.label}
                        count={wsSkills.length}
                      >
                        {wsSkills.map(({ folder, skill }) => (
                          <SkillRow
                            key={skillKey(folder.path, skill.name)}
                            skill={{
                              ...skill,
                              key: skillKey(folder.path, skill.name),
                              kind: folder.kind,
                            }}
                            active={
                              skillKey(folder.path, skill.name) === selectedKey
                            }
                            onSelect={() =>
                              selectSkill(skillKey(folder.path, skill.name))
                            }
                            onDelete={deleteSkill}
                          />
                        ))}
                        {wsSkills.length === 0 && (
                          <EmptyLine>No skills.</EmptyLine>
                        )}
                      </SkillFolderNode>
                    )
                  })}
                </SkillGroup>

                {/* Custom: one collapsible folder node per registered folder. */}
                <SkillGroup
                  label="Custom"
                  count={tree?.custom.reduce((n, f) => n + f.skills.length, 0)}
                  loading={tree === null}
                >
                  {tree?.custom.length === 0 && (
                    <EmptyLine>No custom folders.</EmptyLine>
                  )}
                  {tree?.custom.map((folder) => (
                    <SkillFolderNode
                      key={folder.path}
                      label={folder.label}
                      count={folder.skills.length}
                    >
                      {folder.skills.map((s) => (
                        <SkillRow
                          key={skillKey(folder.path, s.name)}
                          skill={{
                            ...s,
                            key: skillKey(folder.path, s.name),
                            kind: folder.kind,
                          }}
                          active={skillKey(folder.path, s.name) === selectedKey}
                          onSelect={() =>
                            selectSkill(skillKey(folder.path, s.name))
                          }
                          onDelete={deleteSkill}
                        />
                      ))}
                      {folder.skills.length === 0 && (
                        <EmptyLine>No skills.</EmptyLine>
                      )}
                    </SkillFolderNode>
                  ))}
                </SkillGroup>
              </div>
            </div>

            {/* Main pane — create form / markdown view / raw-text editor. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {mode.kind === "create" ? (
                <>
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
                          onChange={(e) =>
                            setMode({ ...mode, name: e.target.value })
                          }
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
                          onChange={(e) =>
                            setMode({ ...mode, body: e.target.value })
                          }
                          spellCheck={false}
                          className="min-h-64 resize-y font-mono text-xs leading-relaxed"
                          placeholder={`# ${mode.name.trim() || "my-skill"}\n\n## When to use\n\n…\n\n## Steps\n\n1. …`}
                        />
                      </Field>
                    </div>
                  </ScrollArea>
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
                      ) : isWritable(selected.kind) ? (
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
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
                  Select a skill to view, or create a new one.
                </div>
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
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

// A muted placeholder line inside a group/folder.
function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs text-muted-foreground">{children}</p>
}

// A top-level collapsible group (Global / Workspace / Custom). Expanded by
// default; the chevron rotates on open (the History-section pattern).
function SkillGroup({
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
            className="group/skillgroup flex w-full items-center gap-1"
          >
            <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]/skillgroup:rotate-90" />
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

// A second-level collapsible folder node (a repo or a custom folder), nested
// inside a group. Collapsed by default; its own chevron token rotates
// independently of the parent group's. Indented so the hierarchy reads.
function SkillFolderNode({
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
          className="group/skillfolder flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-sm hover:bg-sidebar-accent"
        >
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/skillfolder:rotate-90" />
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

// One clickable skill row: name + (clamped) description, with a hover delete for
// writable (user/custom) skills. `active` highlights the selected skill.
function SkillRow({
  skill,
  active,
  onSelect,
  onDelete,
}: {
  skill: CatalogSkill
  active: boolean
  onSelect: () => void
  onDelete: (s: CatalogSkill) => void
}) {
  return (
    <SidebarMenuItem className="group/skillrow relative">
      <SidebarMenuButton
        isActive={active}
        onClick={onSelect}
        className={cn("h-auto flex-col items-start gap-0.5 py-1.5 pr-8")}
      >
        <div className="w-full truncate font-medium">{skill.name}</div>
        <div className="line-clamp-2 w-full text-xs font-normal text-muted-foreground">
          {skill.description}
        </div>
      </SidebarMenuButton>
      {isWritable(skill.kind) && (
        <button
          type="button"
          aria-label={`Delete ${skill.name}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(skill)
          }}
          className="absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover/skillrow:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </SidebarMenuItem>
  )
}
