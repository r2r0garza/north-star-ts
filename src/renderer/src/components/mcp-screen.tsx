import { useCallback, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { ArrowLeft, FolderOpen, Plus, Trash2, XIcon } from "lucide-react"
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import type {
  McpServer,
  McpServerDef,
  McpFolder,
  McpTransport,
  McpTree,
} from "@/types"

// The MCP view — an in-panel destination (center region, beside the sidebar) for
// browsing, editing, creating, and deleting MCP servers. DEFINITIONS live in
// mcp.json files discovered from Global (user) / Workspace / Custom sources, so
// this mirrors the Agents view: a 3-tab browse grid, workspace grouped by repo,
// user+custom editable and workspace/github read-only. Per-server state (the
// enabled toggle + OAuth) is stored per-machine and edited inline on each card.

type McpTab = "global" | "workspace" | "custom"

// A flat, addressable server: its def+state plus the folder kind and a key unique
// across folders (source dir + name), since the same name can appear in several.
type CatalogServer = McpServer & { key: string; kind: McpFolder["kind"] }

function serverKey(sourcePath: string, name: string): string {
  return `${sourcePath} ${name}`
}

function isWritable(kind: McpFolder["kind"]): boolean {
  return kind === "user" || kind === "custom"
}

function matchesQuery(s: McpServer, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    s.name.toLowerCase().includes(q) ||
    (s.url ?? "").toLowerCase().includes(q) ||
    (s.command ?? "").toLowerCase().includes(q)
  )
}

// The editable definition draft (mirrors McpServerDef; state is edited separately
// via the enabled toggle / Authorize).
type Draft = {
  name: string
  transport: McpTransport
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  headers: Record<string, string>
}

function draftFromServer(s: McpServer): Draft {
  return {
    name: s.name,
    transport: s.transport,
    command: s.command ?? "",
    args: s.args,
    env: s.env,
    url: s.url ?? "",
    headers: s.headers,
  }
}

function draftToDef(d: Draft): McpServerDef {
  const stdio = d.transport === "stdio"
  return {
    name: d.name.trim(),
    transport: d.transport,
    command: stdio ? d.command.trim() || null : null,
    // Drop blank rows (an unfilled "Add argument" box) before persisting.
    args: stdio ? d.args.map((a) => a.trim()).filter(Boolean) : [],
    env: stdio ? d.env : {},
    url: stdio ? null : d.url.trim() || null,
    headers: stdio ? {} : d.headers,
  }
}

type Mode =
  | { kind: "view" }
  | { kind: "edit" }
  | { kind: "create"; filePath: string }

// ── text <-> args/record helpers (multi-line editing) ───────────────────────
function recordToText(rec: Record<string, string>): string {
  return Object.entries(rec)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")
}
function textToRecord(text: string): Record<string, string> {
  const rec: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t) continue
    const eq = t.indexOf("=")
    if (eq <= 0) continue
    rec[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return rec
}
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function McpScreen({ onClose }: { onClose: () => void }) {
  const [tree, setTree] = useState<McpTree | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: "view" })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<McpTab>("global")
  const [query, setQuery] = useState("")

  const loadTree = useCallback(() => {
    window.cowork.mcp.tree().then(setTree)
  }, [])

  useEffect(() => {
    loadTree()
  }, [loadTree])

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

  // Flatten every folder's servers into addressable catalog entries.
  const allServers = useMemo<CatalogServer[]>(() => {
    if (!tree) return []
    const out: CatalogServer[] = []
    const push = (folders: McpFolder[]) => {
      for (const f of folders) {
        for (const s of f.servers) {
          out.push({ ...s, key: serverKey(f.path, s.name), kind: f.kind })
        }
      }
    }
    push(tree.global)
    for (const ws of tree.workspaces) push(ws.folders)
    push(tree.custom)
    return out
  }, [tree])

  const selected = useMemo(
    () => allServers.find((s) => s.key === selectedKey) ?? null,
    [allServers, selectedKey]
  )

  // Writable target files (Global user file + each custom folder's mcp.json) for
  // the New-server location dropdown.
  const writableTargets = useMemo(() => {
    if (!tree) return [] as Array<{ path: string; label: string }>
    const targets: Array<{ path: string; label: string }> = []
    for (const f of tree.global)
      targets.push({ path: f.path, label: "Global (user)" })
    for (const f of tree.custom)
      targets.push({ path: f.path, label: `Custom · ${f.label}` })
    return targets
  }, [tree])

  function confirmDiscard(): boolean {
    if (mode.kind === "view") return true
    return window.confirm("Discard unsaved changes?")
  }

  function selectServer(key: string) {
    if (!confirmDiscard()) return
    setSelectedKey(key)
    setMode({ kind: "view" })
    setDraft(null)
  }

  function startEditing() {
    if (!selected) return
    setDraft(draftFromServer(selected))
    setMode({ kind: "edit" })
  }

  function startCreating() {
    if (!confirmDiscard()) return
    setSelectedKey(null)
    setDraft({
      name: "",
      transport: "stdio",
      command: "",
      args: [],
      env: {},
      url: "",
      headers: {},
    })
    setMode({ kind: "create", filePath: writableTargets[0]?.path ?? "" })
  }

  function cancelForm() {
    if (!confirmDiscard()) return
    setMode({ kind: "view" })
    setDraft(null)
  }

  async function save() {
    if (!draft || !selected) return
    setSaving(true)
    try {
      await window.cowork.mcp.saveServer(selected.path, draftToDef(draft))
      toast.success(`Saved ${draft.name}`)
      setMode({ kind: "view" })
      setDraft(null)
      loadTree()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save server.")
    } finally {
      setSaving(false)
    }
  }

  async function createServer() {
    if (!draft || mode.kind !== "create") return
    if (!NAME_RE.test(draft.name.trim())) {
      toast.error("Name must be lowercase letters, digits, and single hyphens.")
      return
    }
    setSaving(true)
    try {
      const filePath = `${mode.filePath}/mcp.json`
      const view = await window.cowork.mcp.saveServer(
        filePath,
        draftToDef(draft)
      )
      toast.success(`Created ${view.name}`)
      setMode({ kind: "view" })
      setDraft(null)
      loadTree()
      setSelectedKey(serverKey(mode.filePath, view.name))
      // Custom-folder targets live under the Custom tab; the user file is Global.
      const isCustom = tree?.custom.some((f) => f.path === mode.filePath)
      setActiveTab(isCustom ? "custom" : "global")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create server.")
    } finally {
      setSaving(false)
    }
  }

  async function deleteServer() {
    if (!selected || !isWritable(selected.kind)) return
    if (!window.confirm(`Delete MCP server "${selected.name}"?`)) return
    try {
      await window.cowork.mcp.deleteServer(selected.path, selected.name)
      toast.success(`Deleted ${selected.name}`)
      setSelectedKey(null)
      setMode({ kind: "view" })
      setDraft(null)
      loadTree()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to delete server.")
    }
  }

  const showForm = mode.kind === "edit" || mode.kind === "create"

  return (
    <div
      data-slot="mcp-screen"
      className="flex min-h-0 w-full flex-1 flex-col bg-background pt-11"
    >
      {/* Title row sits below the app's h-11 top drag bar (pt-11 on the root).
          Actions live in the tabs row below (mirrors the Agents/Skills views). */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close MCP servers"
          className="group/back flex items-center gap-2 rounded-md text-left"
        >
          <ArrowLeft className="size-4 text-muted-foreground transition-colors group-hover/back:text-foreground" />
          <h1 className="font-heading text-base font-medium">MCP Servers</h1>
        </button>
        <Button variant="ghost" size="icon-sm" onClick={onClose}>
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
      </div>

      {showForm && draft ? (
        <ServerForm
          draft={draft}
          onChange={setDraft}
          mode={mode}
          targets={writableTargets}
          onTargetChange={(filePath) => setMode({ kind: "create", filePath })}
          saving={saving}
          onCancel={cancelForm}
          onSave={mode.kind === "create" ? createServer : save}
        />
      ) : selected ? (
        <ServerView
          server={selected}
          onBack={() => setSelectedKey(null)}
          onEdit={isWritable(selected.kind) ? startEditing : undefined}
          onDelete={isWritable(selected.kind) ? deleteServer : undefined}
          onChanged={loadTree}
        />
      ) : (
        <ServerBrowser
          tree={tree}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          query={query}
          onQueryChange={setQuery}
          onSelect={selectServer}
          onToggle={async (name, enabled) => {
            await window.cowork.mcp.setEnabled(name, enabled)
            loadTree()
          }}
          onCreate={startCreating}
          canCreate={writableTargets.length > 0}
        />
      )}
    </div>
  )
}

// ── Browse (3-tab card grid) ─────────────────────────────────────────────────
function ServerBrowser({
  tree,
  activeTab,
  onTabChange,
  query,
  onQueryChange,
  onSelect,
  onToggle,
  onCreate,
  canCreate,
}: {
  tree: McpTree | null
  activeTab: McpTab
  onTabChange: (t: McpTab) => void
  query: string
  onQueryChange: (q: string) => void
  onSelect: (key: string) => void
  onToggle: (name: string, enabled: boolean) => void
  onCreate: () => void
  canCreate: boolean
}) {
  if (!tree) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => onTabChange(v as McpTab)}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      {/* Tabs + the New-server action share one row (mirrors Agents/Skills).
          New server is disabled on Workspace — those configs are read-only. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2">
        <TabsList variant="line" className="gap-1">
          <TabsTrigger value="global">Global</TabsTrigger>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="custom">Custom</TabsTrigger>
        </TabsList>
        <Button
          size="sm"
          variant="outline"
          onClick={onCreate}
          disabled={activeTab === "workspace" || !canCreate}
        >
          <Plus className="size-4" />
          Add new server
        </Button>
      </div>

      {/* Full-width filter row below the tabs. */}
      <div className="shrink-0 border-b px-4 py-2">
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter servers…"
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          <TabsContent value="global">
            <FolderGrid
              folders={tree.global}
              query={query}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          </TabsContent>
          <TabsContent value="workspace">
            {tree.workspaces.length === 0 ? (
              <EmptyNote>No workspaces yet.</EmptyNote>
            ) : (
              tree.workspaces.map((ws) => (
                <div key={ws.path} className="mb-6">
                  <h3 className="mb-2 text-sm font-medium">{ws.label}</h3>
                  <FolderGrid
                    folders={ws.folders}
                    query={query}
                    onSelect={onSelect}
                    onToggle={onToggle}
                  />
                </div>
              ))
            )}
          </TabsContent>
          <TabsContent value="custom">
            {tree.custom.length === 0 ? (
              <EmptyNote>
                No custom folders. Add one in Settings → Capabilities.
              </EmptyNote>
            ) : (
              <FolderGrid
                folders={tree.custom}
                query={query}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            )}
          </TabsContent>
        </div>
      </ScrollArea>
    </Tabs>
  )
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

function FolderGrid({
  folders,
  query,
  onSelect,
  onToggle,
}: {
  folders: McpFolder[]
  query: string
  onSelect: (key: string) => void
  onToggle: (name: string, enabled: boolean) => void
}) {
  const servers = folders.flatMap((f) =>
    f.servers
      .filter((s) => matchesQuery(s, query))
      .map((s) => ({ ...s, kind: f.kind, folderPath: f.path }))
  )
  if (servers.length === 0) return <EmptyNote>No servers here yet.</EmptyNote>
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {servers.map((s) => (
        <Card
          key={serverKey(s.folderPath, s.name)}
          className="cursor-pointer transition-colors hover:border-primary/50"
          onClick={() => onSelect(serverKey(s.folderPath, s.name))}
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="truncate">{s.name}</span>
              <Badge variant="secondary">{s.transport}</Badge>
              {s.transport === "http" && s.hasOauth && (
                <Badge variant="outline">authorized</Badge>
              )}
            </CardTitle>
            <CardDescription className="truncate">
              {s.transport === "stdio" ? s.command : s.url}
            </CardDescription>
            <CardAction>
              {/* Quick enable/disable without opening the server. Stop click +
                  pointer events from bubbling to the card's onSelect. */}
              <span
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <Switch
                  checked={s.enabled}
                  onCheckedChange={(checked) => onToggle(s.name, checked)}
                  aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.name}`}
                />
              </span>
            </CardAction>
          </CardHeader>
        </Card>
      ))}
    </div>
  )
}

// ── Read-only detail (with inline state controls) ────────────────────────────
function ServerView({
  server,
  onBack,
  onEdit,
  onDelete,
  onChanged,
}: {
  server: McpServer & { kind: McpFolder["kind"] }
  onBack: () => void
  onEdit?: () => void
  onDelete?: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<null | "test" | "auth">(null)
  const [status, setStatus] = useState<string | null>(null)

  async function test() {
    setBusy("test")
    setStatus("Connecting…")
    const res = await window.cowork.mcp.test(server.name)
    setBusy(null)
    setStatus(
      res.ok
        ? `Connected — ${res.toolCount ?? 0} tool(s).`
        : `Failed: ${res.error ?? "unknown error"}`
    )
  }

  async function authorize() {
    setBusy("auth")
    setStatus("Opening your browser to sign in…")
    const res = await window.cowork.mcp.authorize(server.name)
    setBusy(null)
    setStatus(res.ok ? "Authorized." : `Authorization failed: ${res.error}`)
    onChanged()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Detail header with back-to-list (the top title-row back arrow closes the
          whole view; this returns to the server grid). */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label="Back to servers"
          >
            <ArrowLeft />
          </Button>
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate font-medium">
              {server.name}
              <Badge variant="secondary">{server.transport}</Badge>
            </p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {server.path}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onEdit && (
            <Button variant="outline" size="sm" onClick={onEdit}>
              Edit
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.cowork.mcp.reveal(server.path)}
          >
            <FolderOpen className="size-4" /> Reveal
          </Button>
          {onDelete && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-destructive"
              onClick={onDelete}
              aria-label="Delete server"
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="max-w-2xl space-y-5 px-6 py-5">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <Label className="text-sm">Enabled</Label>
              <p className="text-xs text-muted-foreground">
                Off keeps the definition but withholds its tools from agents.
              </p>
            </div>
            <Switch
              checked={server.enabled}
              onCheckedChange={async (checked) => {
                await window.cowork.mcp.setEnabled(server.name, checked)
                onChanged()
              }}
            />
          </div>

          <div className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1.5 text-sm">
            {server.transport === "stdio" ? (
              <>
                <ViewRow label="Command" value={server.command ?? "—"} />
                <ViewRow label="Args" value={server.args.join(" ") || "—"} />
                <ViewRow
                  label="Env"
                  value={Object.keys(server.env).join(", ") || "—"}
                />
              </>
            ) : (
              <>
                <ViewRow label="URL" value={server.url ?? "—"} />
                <ViewRow
                  label="Headers"
                  value={Object.keys(server.headers).join(", ") || "—"}
                />
              </>
            )}
            <ViewRow label="Source" value={server.path} />
          </div>

          {server.transport === "http" && (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={authorize}
              >
                {server.hasOauth ? "Re-authorize" : "Authorize (OAuth)"}
              </Button>
              {server.hasOauth && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={busy !== null}
                  onClick={async () => {
                    await window.cowork.mcp.clearOauth(server.name)
                    onChanged()
                  }}
                >
                  Clear tokens
                </Button>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={test}
              disabled={busy !== null}
            >
              Test connection
            </Button>
            {status && (
              <span className="text-xs text-muted-foreground">{status}</span>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}

function ViewRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono text-xs break-words">{value}</div>
    </>
  )
}

// ── Structured create/edit form ──────────────────────────────────────────────
function ServerForm({
  draft,
  onChange,
  mode,
  targets,
  onTargetChange,
  saving,
  onCancel,
  onSave,
}: {
  draft: Draft
  onChange: (d: Draft) => void
  mode: Mode
  targets: Array<{ path: string; label: string }>
  onTargetChange: (filePath: string) => void
  saving: boolean
  onCancel: () => void
  onSave: () => void
}) {
  const creating = mode.kind === "create"
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="max-w-2xl space-y-5 px-6 py-5">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-medium">
            {creating ? "New MCP server" : draft.name}
          </h2>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" onClick={onSave} disabled={saving || !draft.name}>
              {saving ? "Saving…" : creating ? "Create" : "Save"}
            </Button>
          </div>
        </div>

        {creating && (
          <>
            <FormField label="Name">
              <Input
                value={draft.name}
                onChange={(e) => onChange({ ...draft, name: e.target.value })}
                placeholder="atlassian"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, digits, single hyphens. Its tools appear to
                agents as{" "}
                <code className="font-mono">
                  mcp__{draft.name.trim() || "<name>"}__tool
                </code>
                .
              </p>
            </FormField>
            <FormField label="Location">
              <Select
                value={mode.kind === "create" ? mode.filePath : ""}
                onValueChange={onTargetChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Choose a location" />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((t) => (
                    <SelectItem key={t.path} value={t.path}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </>
        )}

        <FormField label="Transport">
          <Select
            value={draft.transport}
            onValueChange={(v) =>
              onChange({ ...draft, transport: v as McpTransport })
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">STDIO (local process)</SelectItem>
              <SelectItem value="http">Streamable HTTP</SelectItem>
            </SelectContent>
          </Select>
        </FormField>

        {draft.transport === "stdio" ? (
          <>
            <FormField label="Command">
              <Input
                value={draft.command}
                onChange={(e) =>
                  onChange({ ...draft, command: e.target.value })
                }
                placeholder="npx"
              />
            </FormField>
            <FormField label="Arguments">
              <div className="flex flex-col gap-2">
                {draft.args.map((arg, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={arg}
                      onChange={(e) => {
                        const next = [...draft.args]
                        next[i] = e.target.value
                        onChange({ ...draft, args: next })
                      }}
                      placeholder={
                        i === 0 ? "-y" : "@modelcontextprotocol/server-…"
                      }
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove argument ${i + 1}`}
                      onClick={() =>
                        onChange({
                          ...draft,
                          args: draft.args.filter((_, j) => j !== i),
                        })
                      }
                    >
                      <XIcon className="size-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    onChange({ ...draft, args: [...draft.args, ""] })
                  }
                >
                  <Plus className="size-4" /> Add argument
                </Button>
              </div>
            </FormField>
            <FormField label="Environment (KEY=value, one per line)">
              <Textarea
                value={recordToText(draft.env)}
                onChange={(e) =>
                  onChange({ ...draft, env: textToRecord(e.target.value) })
                }
                rows={2}
                className="font-mono text-xs"
                placeholder="API_TOKEN=..."
              />
            </FormField>
          </>
        ) : (
          <>
            <FormField label="Server URL">
              <Input
                value={draft.url}
                onChange={(e) => onChange({ ...draft, url: e.target.value })}
                placeholder="https://mcp.example.com/mcp"
              />
            </FormField>
            <FormField label="Headers (KEY=value, one per line)">
              <Textarea
                value={recordToText(draft.headers)}
                onChange={(e) =>
                  onChange({ ...draft, headers: textToRecord(e.target.value) })
                }
                rows={2}
                className="font-mono text-xs"
                placeholder="X-Custom-Header=value"
              />
            </FormField>
            <p className="text-xs text-muted-foreground">
              For servers that need OAuth (e.g. Atlassian), save first, then use
              Authorize on the server's detail view.
            </p>
          </>
        )}
      </div>
    </ScrollArea>
  )
}

function FormField({
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
