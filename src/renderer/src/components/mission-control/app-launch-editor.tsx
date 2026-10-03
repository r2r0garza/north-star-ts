import { useEffect, useMemo, useState } from "react"
import { Plus, Sparkles, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { AppLaunch, AppService, Workspace } from "@/types"
import {
  DEFAULT_PORT_ENV,
  DEFAULT_READY_TIMEOUT_MS,
  validateAppLaunch,
} from "../../../../shared/mission-control/app-launch"

// How Mission Control seats start the app to test it (plan 109.03). Each
// service is one command with a port ("auto" gives every worktree its own),
// a readiness check, and the services it needs first. Builder and QA seats
// start it with app_start; it's stopped when their step ends. Stored on the
// workspace, so it applies to every feature in it.

interface Draft {
  id: string
  key: string
  label: string
  command: string
  cwd: string
  portMode: "auto" | "none" | "fixed"
  portNumber: string
  portEnv: string
  env: string
  readyKind: "http" | "log"
  ready: string
  timeoutSeconds: string
  dependsOn: string
  source: AppService["source"]
  findingKey?: string
}

let nextId = 0
const draftId = () => `service-${++nextId}`

function toDraft(service: AppService): Draft {
  return {
    id: draftId(),
    key: service.key,
    label: service.label,
    command: service.command,
    cwd: service.cwd,
    portMode:
      service.port === "auto" || service.port === "none"
        ? service.port
        : "fixed",
    portNumber: typeof service.port === "number" ? String(service.port) : "",
    portEnv: service.portEnv ?? "",
    env: Object.entries(service.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(", "),
    readyKind: "log" in service.ready ? "log" : "http",
    ready: "log" in service.ready ? service.ready.log : service.ready.http,
    timeoutSeconds: service.readyTimeoutMs
      ? String(Math.round(service.readyTimeoutMs / 1000))
      : "",
    dependsOn: (service.dependsOn ?? []).join(", "),
    source: service.source,
    findingKey: service.findingKey,
  }
}

const list = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

// The raw service the validator reads (and normalizes).
function fromDraft(draft: Draft): Record<string, unknown> {
  const env: Record<string, string> = {}
  for (const pair of list(draft.env)) {
    const at = pair.indexOf("=")
    env[at < 0 ? pair : pair.slice(0, at).trim()] =
      at < 0 ? "" : pair.slice(at + 1).trim()
  }
  const timeout = Number(draft.timeoutSeconds)
  return {
    key: draft.key.trim() || undefined,
    label: draft.label,
    command: draft.command,
    cwd: draft.cwd,
    port:
      draft.portMode === "fixed" ? Number(draft.portNumber) : draft.portMode,
    portEnv: draft.portEnv.trim() || undefined,
    env,
    ready:
      draft.readyKind === "log"
        ? { log: draft.ready }
        : { http: draft.ready.trim() || "/" },
    readyTimeoutMs:
      draft.timeoutSeconds.trim() && Number.isFinite(timeout)
        ? timeout * 1000
        : undefined,
    dependsOn: list(draft.dependsOn),
    source: draft.source,
    findingKey: draft.findingKey,
  }
}

export function AppLaunchEditor({
  workspace,
  onSaved,
}: {
  workspace: Workspace
  onSaved: (workspace: Workspace) => void
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    workspace.appLaunch.services.map(toDraft)
  )
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setDrafts(workspace.appLaunch.services.map(toDraft))
  }, [workspace])
  const validation = useMemo(
    () =>
      validateAppLaunch({
        // A blank row being filled in isn't a service yet.
        services: drafts
          .filter((d) => d.command.trim() || d.label.trim())
          .map(fromDraft),
      }),
    [drafts]
  )
  const dirty =
    JSON.stringify(validation.recipe) !== JSON.stringify(workspace.appLaunch) ||
    !validation.ok
  const update = (index: number, patch: Partial<Draft>) =>
    setDrafts((current) =>
      current.map((draft, i) =>
        i === index
          ? {
              ...draft,
              ...patch,
              // Editing a suggested service makes it the user's.
              source: patch.label !== undefined ? draft.source : "user",
            }
          : draft
      )
    )
  const save = async (recipe: AppLaunch) => {
    setSaving(true)
    try {
      onSaved(
        await window.cowork.db.workspaces.update(workspace.id, {
          appLaunch: recipe,
        })
      )
      toast.success("App launch saved")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <div className="text-xs text-muted-foreground">App launch</div>
        <p className="text-xs text-muted-foreground">
          How builder and QA seats start the app to test it. Each service is one
          command, run in its directory. With port <b>auto</b>, every worktree
          gets its own free port, passed in <code>PORT</code> (or the variable
          you name) and as <code>{"{port}"}</code> in the command and
          environment; <code>{"{port:api}"}</code> is another service's port. A
          service is ready when an HTTP path answers or a log line matches.
          Everything a step starts is stopped when it ends. Leave this empty for
          projects with nothing to run.
        </p>
      </div>
      <ol className="space-y-2">
        {drafts.map((draft, index) => {
          const n = index + 1
          return (
            <li key={draft.id} className="space-y-2 rounded-md border p-2">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="h-8 w-40 text-xs"
                  placeholder="Label, e.g. Web app"
                  aria-label={`Service ${n} label`}
                  value={draft.label}
                  onChange={(e) => update(index, { label: e.target.value })}
                />
                <Input
                  className="h-8 w-28 font-mono text-xs"
                  placeholder="key"
                  aria-label={`Service ${n} key`}
                  value={draft.key}
                  onChange={(e) => update(index, { key: e.target.value })}
                />
                <Input
                  className="h-8 min-w-48 flex-1 font-mono text-xs"
                  placeholder="Command, e.g. pnpm dev --port {port}"
                  aria-label={`Service ${n} command`}
                  value={draft.command}
                  onChange={(e) => update(index, { command: e.target.value })}
                />
                <Input
                  className="h-8 w-28 font-mono text-xs"
                  placeholder="Directory"
                  aria-label={`Service ${n} directory`}
                  value={draft.cwd}
                  onChange={(e) => update(index, { cwd: e.target.value })}
                />
                {draft.source === "analysis" && (
                  <Badge
                    variant="secondary"
                    className="gap-1"
                    title="Added from a workspace setup finding"
                  >
                    <Sparkles className="size-3" /> Suggested
                  </Badge>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="ml-auto text-muted-foreground hover:text-destructive"
                  aria-label={`Remove service ${n}`}
                  onClick={() =>
                    setDrafts((current) =>
                      current.filter((_, i) => i !== index)
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">Port</span>
                <NativeSelect
                  size="sm"
                  aria-label={`Service ${n} port`}
                  value={draft.portMode}
                  onChange={(e) =>
                    update(index, {
                      portMode: e.target.value as Draft["portMode"],
                      ...(e.target.value === "none"
                        ? { readyKind: "log" as const }
                        : {}),
                    })
                  }
                >
                  <NativeSelectOption value="auto">auto</NativeSelectOption>
                  <NativeSelectOption value="fixed">fixed</NativeSelectOption>
                  <NativeSelectOption value="none">none</NativeSelectOption>
                </NativeSelect>
                {draft.portMode === "fixed" && (
                  <Input
                    className="h-7 w-20 font-mono text-xs"
                    inputMode="numeric"
                    placeholder="3000"
                    aria-label={`Service ${n} port number`}
                    value={draft.portNumber}
                    onChange={(e) =>
                      update(index, { portNumber: e.target.value })
                    }
                  />
                )}
                {draft.portMode !== "none" && (
                  <Input
                    className="h-7 w-24 font-mono text-xs"
                    placeholder={DEFAULT_PORT_ENV}
                    aria-label={`Service ${n} port variable`}
                    value={draft.portEnv}
                    onChange={(e) => update(index, { portEnv: e.target.value })}
                  />
                )}
                <span className="ml-2 text-muted-foreground">Ready when</span>
                <NativeSelect
                  size="sm"
                  aria-label={`Service ${n} readiness`}
                  value={draft.readyKind}
                  onChange={(e) =>
                    update(index, {
                      readyKind: e.target.value as Draft["readyKind"],
                    })
                  }
                >
                  <NativeSelectOption
                    value="http"
                    disabled={draft.portMode === "none"}
                  >
                    HTTP path answers
                  </NativeSelectOption>
                  <NativeSelectOption value="log">
                    output matches
                  </NativeSelectOption>
                </NativeSelect>
                <Input
                  className="h-7 w-40 font-mono text-xs"
                  placeholder={
                    draft.readyKind === "http" ? "/" : "ready in \\d+"
                  }
                  aria-label={`Service ${n} readiness ${draft.readyKind === "http" ? "path" : "pattern"}`}
                  value={draft.ready}
                  onChange={(e) => update(index, { ready: e.target.value })}
                />
                <Input
                  className="h-7 w-20 font-mono text-xs"
                  inputMode="numeric"
                  placeholder={String(DEFAULT_READY_TIMEOUT_MS / 1000)}
                  aria-label={`Service ${n} readiness timeout in seconds`}
                  title="Seconds to wait for readiness"
                  value={draft.timeoutSeconds}
                  onChange={(e) =>
                    update(index, { timeoutSeconds: e.target.value })
                  }
                />
                <span className="text-muted-foreground">s</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Input
                  className="h-7 w-44 font-mono text-xs"
                  placeholder="Starts after: api, db"
                  aria-label={`Service ${n} depends on`}
                  value={draft.dependsOn}
                  onChange={(e) => update(index, { dependsOn: e.target.value })}
                />
                <Input
                  className="h-7 min-w-48 flex-1 font-mono text-xs"
                  placeholder="Environment: API_URL=http://localhost:{port:api}"
                  aria-label={`Service ${n} environment`}
                  value={draft.env}
                  onChange={(e) => update(index, { env: e.target.value })}
                />
              </div>
            </li>
          )
        })}
      </ol>
      {!validation.ok && drafts.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive">
          {validation.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            setDrafts((current) => [
              ...current,
              {
                id: draftId(),
                key: "",
                label: "",
                command: "",
                cwd: "",
                portMode: "auto",
                portNumber: "",
                portEnv: "",
                env: "",
                readyKind: "http",
                ready: "/",
                timeoutSeconds: "",
                dependsOn: "",
                source: "user",
              },
            ])
          }
        >
          <Plus className="size-4" /> Add service
        </Button>
        {dirty && (
          <Button
            size="sm"
            disabled={saving || !validation.ok}
            onClick={() => validation.ok && void save(validation.recipe)}
          >
            Save
          </Button>
        )}
      </div>
    </div>
  )
}
