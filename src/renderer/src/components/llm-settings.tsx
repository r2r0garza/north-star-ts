import { useCallback, useEffect, useState } from "react"
import { TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { ChevronDown, Plus, Search, Star, Trash2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type {
  AccountView,
  LlmSettings,
  ModelEntry,
  ModelOrigin,
  Provider,
} from "@/types"

// Provider catalog for the picker. `enabled` ones are wired; the rest show as
// "coming soon" and are disabled. In the main process, Portkey routes through the
// Portkey SDK; OpenAI + OpenAI-compatible route through the OpenAI SDK (which sends
// Authorization: Bearer on every request). Native OpenAI needs no base URL; the
// others do — see `requiresBaseUrl`.
const PROVIDERS: Array<{ value: Provider; label: string; enabled: boolean }> = [
  { value: "portkey", label: "Portkey", enabled: true },
  { value: "openai_compatible", label: "OpenAI-compatible", enabled: true },
  { value: "openai", label: "OpenAI", enabled: true },
  { value: "anthropic", label: "Anthropic", enabled: false },
  { value: "google", label: "Google", enabled: false },
  { value: "azure_openai", label: "Azure OpenAI", enabled: false },
]

// Native OpenAI can omit a base URL (the SDK defaults to api.openai.com); every
// other wired provider is a gateway that requires one.
function requiresBaseUrl(provider: Provider): boolean {
  return provider !== "openai"
}

function providerLabel(provider: Provider): string {
  return PROVIDERS.find((p) => p.value === provider)?.label ?? provider
}

const ORIGIN_LABEL: Record<ModelOrigin, string> = {
  manual: "manual",
  gateway: "gateway",
  seeded: "seeded",
}

// A model's display name: the custom label if set, else the raw id.
function modelLabel(m: ModelEntry): string {
  return m.modelName && m.modelName.trim() ? m.modelName : m.modelId
}

// Shared state for the Providers + Models tabs: the configured accounts, the
// active selection, and secure-storage availability. Lifted here so both tabs
// (and the composer, via its own hook) stay in sync after a write.
export function useLlmSettings(open: boolean) {
  const [accounts, setAccounts] = useState<AccountView[] | null>(null)
  const [active, setActive] = useState<LlmSettings | null>(null)
  const [secureOk, setSecureOk] = useState(true)

  const reload = useCallback(async () => {
    const [list, sel, secure] = await Promise.all([
      window.cowork.providers.list(),
      window.cowork.providers.getDefault(),
      window.cowork.providers.secureStorageAvailable(),
    ])
    setAccounts(list)
    setActive(sel)
    setSecureOk(secure)
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void reload().catch(() => {})
    return () => {
      cancelled = true
      void cancelled
    }
  }, [open, reload])

  return { accounts, active, secureOk, setActive, reload }
}

type LlmState = ReturnType<typeof useLlmSettings>

// A section that grows/scrolls inside the sheet. The tab itself is the flex
// child; this scrolls its overflow so long provider/model lists stay reachable.
const TAB_SCROLL =
  "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-2 pr-1"

// ── Providers tab ────────────────────────────────────────────────────────────

export function ProvidersTab({ state }: { state: LlmState }) {
  const { accounts, active, secureOk, reload, setActive } = state
  const [adding, setAdding] = useState(false)
  // Which account cards are expanded. Saved accounts default collapsed; a card is
  // opened explicitly (toggle) or when freshly created (so its key can be set).
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  if (accounts == null) {
    return (
      <TabsContent value="providers" className="py-6">
        <Spinner />
      </TabsContent>
    )
  }

  return (
    <TabsContent value="providers" className={TAB_SCROLL}>
      {!secureOk && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Secure key storage (OS keychain) is unavailable on this machine, so
          API keys can't be saved. Keys are never stored in plaintext.
        </p>
      )}

      {accounts.length === 0 && !adding ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No providers configured</EmptyTitle>
            <EmptyDescription>
              Add a provider and API key to start a conversation.
            </EmptyDescription>
          </EmptyHeader>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add provider
          </Button>
        </Empty>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor="active-account">Default provider</FieldLabel>
            <Select
              value={active?.activeAccountId ?? ""}
              onValueChange={async (id) => {
                // Switching account clears the default model until one is picked.
                const next = { activeAccountId: id, activeModelId: null }
                setActive(next)
                await window.cowork.providers.setDefault(next)
              }}
            >
              <SelectTrigger id="active-account">
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id} disabled={!a.enabled}>
                    {a.displayName}
                    {!a.enabled ? " — off" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              The provider and model new conversations start with — pick its
              default model in the Models tab. Each conversation can switch
              model from the composer.
            </FieldDescription>
          </Field>

          <div className="flex flex-col gap-2">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                secureOk={secureOk}
                open={expanded.has(account.id)}
                onToggle={() => toggle(account.id)}
                onChange={reload}
              />
            ))}
          </div>

          {adding ? (
            <NewAccountForm
              onDone={() => setAdding(false)}
              onSaved={async (id) => {
                // Open the new account so the user can immediately set its key.
                setExpanded((prev) => new Set(prev).add(id))
                await reload()
              }}
            />
          ) : (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Add provider
            </Button>
          )}
        </>
      )}
    </TabsContent>
  )
}

// One configured account, collapsible. The header shows name + provider + a
// key/no-key hint; the body (base URL, key, delete) is hidden when collapsed.
function AccountCard({
  account,
  secureOk,
  open,
  onToggle,
  onChange,
}: {
  account: AccountView
  secureOk: boolean
  open: boolean
  onToggle: () => void
  onChange: () => Promise<void>
}) {
  const [baseUrl, setBaseUrl] = useState(account.baseUrl ?? "")
  const [keyInput, setKeyInput] = useState("")
  const [editingKey, setEditingKey] = useState(!account.hasKey)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function saveBaseUrl() {
    if (baseUrl === (account.baseUrl ?? "")) return
    await window.cowork.providers.update(account.id, {
      baseUrl: baseUrl || null,
    })
    await onChange()
  }

  async function saveKey() {
    if (!keyInput.trim()) return
    setBusy(true)
    setError(null)
    const res = await window.cowork.providers.setKey(
      account.id,
      keyInput.trim()
    )
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? "Failed to store key.")
      return
    }
    setKeyInput("")
    setEditingKey(false)
    await onChange()
  }

  async function clearKey() {
    await window.cowork.providers.clearKey(account.id)
    setEditingKey(true)
    await onChange()
  }

  async function setEnabled(enabled: boolean) {
    await window.cowork.providers.update(account.id, { enabled })
    await onChange()
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={onToggle}
      className="rounded-lg border border-border"
    >
      <div className="flex items-center justify-between p-3">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90"
            )}
          />
          <span className="truncate text-sm font-medium">
            {account.displayName}
          </span>
          <Badge variant="secondary">{providerLabel(account.provider)}</Badge>
          {!account.enabled && (
            <Badge variant="outline" className="shrink-0">
              off
            </Badge>
          )}
          {!account.hasKey && (
            <Badge variant="destructive" className="shrink-0">
              no key
            </Badge>
          )}
        </CollapsibleTrigger>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={account.enabled}
            size="sm"
            aria-label={`${account.enabled ? "Disable" : "Enable"} provider`}
            title={`${account.enabled ? "Disable" : "Enable"} provider`}
            onClick={(e) => e.stopPropagation()}
            onCheckedChange={(checked) => void setEnabled(checked)}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            title="Delete provider"
            onClick={async () => {
              await window.cowork.providers.delete(account.id)
              await onChange()
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <CollapsibleContent className="flex flex-col gap-3 px-3 pb-3">
        <Field>
          <FieldLabel htmlFor={`base-${account.id}`}>Base URL</FieldLabel>
          <Input
            id={`base-${account.id}`}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={saveBaseUrl}
            placeholder="https://gateway.example.com/v1"
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={`key-${account.id}`}>API key</FieldLabel>
          {editingKey ? (
            <div className="flex items-center gap-2">
              <Input
                id={`key-${account.id}`}
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="Paste API key"
                disabled={!secureOk}
                autoComplete="off"
              />
              <Button
                size="sm"
                onClick={saveKey}
                disabled={!secureOk || busy || !keyInput.trim()}
              >
                {busy ? <Spinner /> : "Save"}
              </Button>
              {account.hasKey && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => setEditingKey(false)}
                >
                  <X className="size-4" />
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">
                {account.maskedKey ?? "•••• set"}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditingKey(true)}
              >
                Replace
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={clearKey}
              >
                Clear
              </Button>
            </div>
          )}
          {error && (
            <FieldDescription className="text-destructive">
              {error}
            </FieldDescription>
          )}
        </Field>
      </CollapsibleContent>
    </Collapsible>
  )
}

// Inline form to add a new provider account. Reports the created account id so
// the caller can expand its card for immediate key entry.
function NewAccountForm({
  onDone,
  onSaved,
}: {
  onDone: () => void
  onSaved: (id: string) => Promise<void>
}) {
  const [provider, setProvider] = useState<Provider>("portkey")
  const [displayName, setDisplayName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")

  const needsBaseUrl = requiresBaseUrl(provider)
  const canSave = !needsBaseUrl || baseUrl.trim().length > 0

  async function save() {
    if (!canSave) return
    const name = displayName.trim() || providerLabel(provider)
    const account = await window.cowork.providers.create({
      provider,
      displayName: name,
      baseUrl: baseUrl.trim() || null,
    })
    await onSaved(account.id)
    onDone()
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border p-3">
      <Field>
        <FieldLabel htmlFor="new-provider">Provider</FieldLabel>
        <Select
          value={provider}
          onValueChange={(v) => setProvider(v as Provider)}
        >
          <SelectTrigger id="new-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p.value} value={p.value} disabled={!p.enabled}>
                {p.label}
                {!p.enabled ? " — coming soon" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor="new-name">Display name</FieldLabel>
        <Input
          id="new-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g. Work Portkey"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="new-base">
          Base URL{needsBaseUrl ? "" : " (optional)"}
        </FieldLabel>
        <Input
          id="new-base"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={
            needsBaseUrl
              ? "https://gateway.example.com/v1"
              : "Leave blank for api.openai.com"
          }
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={!canSave}>
          Add
        </Button>
      </div>
    </div>
  )
}

// ── Models tab ───────────────────────────────────────────────────────────────

// Lists EVERY configured account, each a collapsible section with its own model
// list, gateway import, and add-model form — so models are managed per provider
// (no ambiguity about which provider a manually-added model belongs to). The
// active account's section defaults open; others default collapsed.
export function ModelsTab({ state }: { state: LlmState }) {
  const { accounts, active, setActive } = state
  const [expanded, setExpanded] = useState<Set<string> | null>(null)

  // Seed expansion once accounts load: active account open, rest collapsed.
  useEffect(() => {
    if (accounts == null || expanded != null) return
    setExpanded(
      new Set(active?.activeAccountId ? [active.activeAccountId] : [])
    )
  }, [accounts, active, expanded])

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  if (accounts == null) {
    return (
      <TabsContent value="models" className="py-6">
        <Spinner />
      </TabsContent>
    )
  }

  if (accounts.length === 0) {
    return (
      <TabsContent value="models" className="py-2">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No providers configured</EmptyTitle>
            <EmptyDescription>
              Add a provider in the Providers tab first.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </TabsContent>
    )
  }

  return (
    <TabsContent value="models" className={TAB_SCROLL}>
      {accounts.map((account) => (
        <AccountModelsSection
          key={account.id}
          account={account}
          active={active}
          open={expanded?.has(account.id) ?? false}
          onToggle={() => toggle(account.id)}
          onSelectActive={async (modelId) => {
            // In Settings, picking a model sets the DEFAULT for new conversations.
            const next = { activeAccountId: account.id, activeModelId: modelId }
            setActive(next)
            await window.cowork.providers.setDefault(next)
          }}
          onModelsCleared={async () => {
            if (active?.activeAccountId !== account.id) return
            const next = { activeAccountId: account.id, activeModelId: null }
            setActive(next)
          }}
        />
      ))}
    </TabsContent>
  )
}

// One provider's models: collapsible, with its own import + add-model controls.
function AccountModelsSection({
  account,
  active,
  open,
  onToggle,
  onSelectActive,
  onModelsCleared,
}: {
  account: AccountView
  active: LlmSettings | null
  open: boolean
  onToggle: () => void
  onSelectActive: (modelId: string) => Promise<void>
  onModelsCleared: () => Promise<void>
}) {
  const [models, setModels] = useState<ModelEntry[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [newId, setNewId] = useState("")
  const [newName, setNewName] = useState("")

  const loadModels = useCallback(async () => {
    setModels(await window.cowork.models.list(account.id))
  }, [account.id])

  // Load this account's models lazily — only once its section is first expanded.
  useEffect(() => {
    if (open && models == null) void loadModels()
  }, [open, models, loadModels])

  async function addModel() {
    if (!newId.trim()) return
    await window.cowork.models.add({
      accountId: account.id,
      modelId: newId.trim(),
      modelName: newName.trim() || null,
      origin: "manual",
    })
    setNewId("")
    setNewName("")
    await loadModels()
  }

  async function runImport() {
    setImporting(true)
    setImportError(null)
    const res = await window.cowork.models.importFromGateway(account.id)
    setImporting(false)
    if (!res.ok) {
      setImportError(res.error ?? "Import failed.")
      return
    }
    await loadModels()
  }

  async function deleteAllModels() {
    if (!models || models.length === 0) return
    const ok = window.confirm(
      `Delete all ${models.length} ${models.length === 1 ? "model" : "models"} from ${account.displayName}?`
    )
    if (!ok) return
    await window.cowork.models.deleteForAccount(account.id)
    await onModelsCleared()
    await loadModels()
  }

  const isActiveAccount = active?.activeAccountId === account.id
  const count = models?.length ?? 0
  const normalizedQuery = query.trim().toLowerCase()
  const visibleModels = models
    ? normalizedQuery
      ? models.filter((m) => {
          const label = modelLabel(m).toLowerCase()
          return (
            label.includes(normalizedQuery) ||
            m.modelId.toLowerCase().includes(normalizedQuery)
          )
        })
      : models
    : null

  return (
    <Collapsible
      open={open}
      onOpenChange={onToggle}
      className="rounded-lg border border-border"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 p-3 text-left">
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90"
          )}
        />
        <span className="truncate text-sm font-medium">
          {account.displayName}
        </span>
        <Badge variant="secondary">{providerLabel(account.provider)}</Badge>
        {models && (
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {count} {count === 1 ? "model" : "models"}
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent className="flex flex-col gap-3 px-3 pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative sm:max-w-72 sm:flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models"
              className="h-8 pl-8"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={deleteAllModels}
              disabled={!models || models.length === 0}
            >
              <Trash2 className="size-4" /> Delete all
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={runImport}
              disabled={importing}
            >
              {importing ? <Spinner /> : "Import from gateway"}
            </Button>
          </div>
        </div>
        {importError && (
          <p className="text-xs text-destructive">{importError}</p>
        )}

        {visibleModels && visibleModels.length > 0 ? (
          <div className="flex flex-col gap-2">
            {visibleModels.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                isActive={
                  isActiveAccount && active?.activeModelId === m.modelId
                }
                onSelect={() => onSelectActive(m.modelId)}
                onChange={loadModels}
              />
            ))}
          </div>
        ) : models && models.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            No models match that search.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No models yet. Add one below or import from the gateway.
          </p>
        )}

        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
          <FieldLabel htmlFor={`new-model-${account.id}`}>
            Add a model
          </FieldLabel>
          <Input
            id={`new-model-${account.id}`}
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="Model id (e.g. @provider/model-name)"
          />
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Custom display name (optional)"
          />
          <Button
            size="sm"
            className="self-end"
            onClick={addModel}
            disabled={!newId.trim()}
          >
            <Plus className="size-4" /> Add
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ModelRow({
  model,
  isActive,
  onSelect,
  onChange,
}: {
  model: ModelEntry
  isActive: boolean
  onSelect: () => void
  onChange: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(model.modelName ?? "")

  async function saveName() {
    await window.cowork.models.update(model.id, {
      modelName: name.trim() || null,
    })
    setEditing(false)
    await onChange()
  }

  async function toggleFavorite() {
    await window.cowork.models.update(model.id, {
      favorite: !model.favorite,
    })
    await onChange()
  }

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-lg border p-2.5",
        isActive ? "border-ring bg-accent/40" : "border-border"
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {editing ? (
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === "Enter" && saveName()}
            placeholder={model.modelId}
            autoFocus
            className="h-7"
          />
        ) : (
          <button
            type="button"
            className="text-left text-sm font-medium hover:underline"
            // Native tooltip shows the full id on hover; the lines below show it
            // in full too (no truncation), so it's readable without hovering.
            title={`${modelLabel(model)} — click to set as default model`}
            onClick={onSelect}
          >
            {/* Custom name (if any) on its own line; otherwise the id is the label. */}
            {model.modelName && model.modelName.trim() ? (
              model.modelName
            ) : (
              <span className="font-mono break-all">{model.modelId}</span>
            )}
          </button>
        )}
        {/* When a custom name is set, still show the raw id beneath it, in full. */}
        {(model.modelName?.trim() || editing) && (
          <span className="font-mono text-xs break-all text-muted-foreground">
            {model.modelId}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {isActive && <Badge>default</Badge>}
        <Badge variant="outline">{ORIGIN_LABEL[model.origin]}</Badge>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "size-7 text-muted-foreground",
            model.favorite && "text-amber-500 hover:text-amber-500"
          )}
          title={model.favorite ? "Remove favorite" : "Favorite model"}
          onClick={toggleFavorite}
        >
          <Star className={cn("size-4", model.favorite && "fill-current")} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          title="Rename"
          onClick={() => setEditing((v) => !v)}
        >
          <span className="text-xs">✎</span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-destructive"
          title="Remove model"
          onClick={async () => {
            await window.cowork.models.delete(model.id)
            await onChange()
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  )
}
