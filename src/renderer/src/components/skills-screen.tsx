import { useCallback, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { ChevronRight, XIcon } from "lucide-react"
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
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Markdown } from "@/components/markdown"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import type { SkillFolder, SkillMetadata, SkillTree } from "@/types"

// The Skills view — a full-viewport takeover (same shell as SettingsScreen) for
// browsing and editing SKILL.md files. The left rail is a two-level tree: the
// top level is Global / Workspace / Custom; under Workspace and Custom, a second
// collapsible level lists each folder (every known repo, every custom folder),
// and under those, the folder's skills. Global is a single flat list. Loaded via
// skills.tree(), which enumerates ALL known workspaces, so the view is populated
// even with no active conversation.
//
// The main pane renders the selected skill's markdown with a View/Edit toggle.
// Editing round-trips the RAW file (frontmatter + body), not SkillMetadata.body
// (which has frontmatter stripped), so YAML stays intact.

// A flat, addressable skill: its metadata plus a key that uniquely identifies it
// across folders (source dir + name), since the same name can appear in several.
type CatalogSkill = SkillMetadata & { key: string }

function skillKey(sourcePath: string, name: string): string {
  return `${sourcePath} ${name}`
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
  const [editing, setEditing] = useState(false)
  // The raw SKILL.md text being edited (null until loaded / not editing).
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Flatten every folder's skills into one addressable list, so selection and the
  // dirty-guard don't care about the tree's shape.
  const allSkills = useMemo<CatalogSkill[]>(() => {
    if (!tree) return []
    const folders: SkillFolder[] = [
      ...tree.global,
      ...tree.workspaces.flatMap((w) => w.folders),
      ...tree.custom,
    ]
    return folders.flatMap((f) =>
      f.skills.map((s) => ({ ...s, key: skillKey(f.path, s.name) }))
    )
  }, [tree])

  const selected = useMemo(
    () => allSkills.find((s) => s.key === selectedKey) ?? null,
    [allSkills, selectedKey]
  )

  const loadTree = useCallback(() => {
    window.cowork.skills.tree().then(setTree)
  }, [])

  // (Re)load the tree whenever the view opens. Reset the transient edit state so a
  // reopen starts clean.
  useEffect(() => {
    if (!open) return
    setTree(null)
    setEditing(false)
    setDraft(null)
    loadTree()
  }, [open, loadTree])

  // Guard against acting on a skill that vanished from a refreshed tree.
  useEffect(() => {
    if (selectedKey && tree && !allSkills.some((s) => s.key === selectedKey)) {
      setSelectedKey(null)
      setEditing(false)
      setDraft(null)
    }
  }, [tree, allSkills, selectedKey])

  const dirty = editing && draft !== null

  // Switch the selected skill, prompting to discard unsaved edits first.
  function selectSkill(key: string) {
    if (key === selectedKey) return
    if (dirty && !window.confirm("Discard unsaved changes to this skill?")) {
      return
    }
    setSelectedKey(key)
    setEditing(false)
    setDraft(null)
  }

  // Enter edit mode: fetch the RAW file (frontmatter + body) into the textarea.
  async function startEditing() {
    if (!selected) return
    try {
      const raw = await window.cowork.skills.read(selected.path)
      setDraft(raw)
      setEditing(true)
    } catch (err) {
      toast.error(`Could not open skill for editing: ${err}`)
    }
  }

  function cancelEditing() {
    if (dirty && !window.confirm("Discard unsaved changes to this skill?")) {
      return
    }
    setEditing(false)
    setDraft(null)
  }

  async function save() {
    if (!selected || draft === null) return
    setSaving(true)
    try {
      await window.cowork.skills.write(selected.path, draft)
      // Refetch so the rendered body reflects the saved change, then drop back
      // to View mode.
      loadTree()
      setEditing(false)
      setDraft(null)
      toast.success("Skill saved")
    } catch (err) {
      toast.error(`Could not save skill: ${err}`)
    } finally {
      setSaving(false)
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
            {/* Left rail — Global (flat) + Workspace/Custom (nested folders). */}
            <div className="w-72 shrink-0 overflow-y-auto border-r py-2">
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
                      name={s.name}
                      description={s.description}
                      active={skillKey(f.path, s.name) === selectedKey}
                      onSelect={() => selectSkill(skillKey(f.path, s.name))}
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
                    f.skills.map((s) => ({ folderPath: f.path, skill: s }))
                  )
                  return (
                    <SkillFolderNode
                      key={ws.path}
                      label={ws.label}
                      count={wsSkills.length}
                    >
                      {wsSkills.map(({ folderPath, skill }) => (
                        <SkillRow
                          key={skillKey(folderPath, skill.name)}
                          name={skill.name}
                          description={skill.description}
                          active={
                            skillKey(folderPath, skill.name) === selectedKey
                          }
                          onSelect={() =>
                            selectSkill(skillKey(folderPath, skill.name))
                          }
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
                        name={s.name}
                        description={s.description}
                        active={skillKey(folder.path, s.name) === selectedKey}
                        onSelect={() =>
                          selectSkill(skillKey(folder.path, s.name))
                        }
                      />
                    ))}
                    {folder.skills.length === 0 && (
                      <EmptyLine>No skills.</EmptyLine>
                    )}
                  </SkillFolderNode>
                ))}
              </SkillGroup>
            </div>

            {/* Main pane — markdown view / editor for the selected skill. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {selected ? (
                <>
                  <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{selected.name}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {selected.path}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {editing ? (
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
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={startEditing}
                        >
                          Edit
                        </Button>
                      )}
                    </div>
                  </div>
                  {editing && draft !== null ? (
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
                  Select a skill to view.
                </div>
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
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

// One clickable skill row: name + (clamped) description. `active` highlights the
// currently-selected skill.
function SkillRow({
  name,
  description,
  active,
  onSelect,
}: {
  name: string
  description: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        onClick={onSelect}
        className={cn("h-auto flex-col items-start gap-0.5 py-1.5")}
      >
        <div className="w-full truncate font-medium">{name}</div>
        <div className="line-clamp-2 w-full text-xs font-normal text-muted-foreground">
          {description}
        </div>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
