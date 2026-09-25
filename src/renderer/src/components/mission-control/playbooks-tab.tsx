import { useCallback, useEffect, useState } from "react"
import { BookOpen, Pencil, Plus, Trash2, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ProcessBuilder } from "@/components/process-screen"
import type {
  AccountWithModels,
  AgentSummary,
  PlaybookAltitude,
  PlaybookHookName,
  PlaybookWithHooks,
  ProcessDefinition,
} from "@/types"

// Playbooks (plan 106.3): Process definitions with an altitude, one per hook.
// The existing Process builder edits each hook's steps in place; phases bind
// to seats by role and one step can be marked as the slice's proof step.

const ALTITUDES: Array<{
  altitude: PlaybookAltitude
  label: string
  hooks: Array<{ hook: PlaybookHookName; label: string; note?: string }>
}> = [
  {
    altitude: "slice",
    label: "Slice",
    hooks: [{ hook: "run", label: "Run" }],
  },
  {
    altitude: "mission",
    label: "Mission",
    hooks: [
      { hook: "before_slices", label: "Before slices" },
      {
        hook: "after_each_slice",
        label: "After each slice",
        note: "Reserved for merges once worktrees land.",
      },
      { hook: "after_all_slices", label: "After all slices" },
    ],
  },
  {
    altitude: "initiative",
    label: "Initiative",
    hooks: [
      { hook: "plan", label: "Plan" },
      { hook: "between_missions", label: "Between missions" },
      { hook: "on_complete", label: "On complete" },
    ],
  },
]

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

export type PlaybookEditing = {
  playbook: PlaybookWithHooks
  hook: PlaybookHookName
  definition: ProcessDefinition
}

// Header copy for the hook editor; Mission Control renders it in its top
// header (with the back arrow) the same way it does for initiative detail.
export function playbookEditingHeader(editing: PlaybookEditing) {
  const altitude = ALTITUDES.find(
    (a) => a.altitude === editing.playbook.altitude
  )!
  const hookLabel =
    altitude.hooks.find((h) => h.hook === editing.hook)?.label ?? editing.hook
  return {
    title: `Playbook: ${editing.playbook.name}`,
    description: `${altitude.label} playbook - ${hookLabel} hook`,
  }
}

export function PlaybooksTab({
  editing,
  onEditingChange: setEditing,
}: {
  editing: PlaybookEditing | null
  onEditingChange: (editing: PlaybookEditing | null) => void
}) {
  const [playbooks, setPlaybooks] = useState<PlaybookWithHooks[] | null>(null)
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [providers, setProviders] = useState<AccountWithModels[]>([])
  const [definitions, setDefinitions] = useState<ProcessDefinition[]>([])

  const load = useCallback(async () => {
    const [next, defs] = await Promise.all([
      window.cowork.missionControl.playbooks.list(),
      window.cowork.db.processes.list(),
    ])
    setPlaybooks(next)
    setDefinitions(defs)
  }, [])

  useEffect(() => {
    void load()
    window.cowork.agents
      .list()
      .then(setAgents)
      .catch(() => setAgents([]))
    window.cowork.providers
      .listWithModels()
      .then(setProviders)
      .catch(() => setProviders([]))
  }, [load])

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action()
      await load()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const editHook = async (
    playbook: PlaybookWithHooks,
    hook: PlaybookHookName
  ) => {
    let current = playbook
    if (!current.hooks.some((h) => h.hook === hook))
      current = await window.cowork.missionControl.playbooks.createHookProcess(
        playbook.id,
        hook
      )
    const processId = current.hooks.find((h) => h.hook === hook)!.processId
    const processGraph = await window.cowork.db.processes.get(processId)
    if (!processGraph) throw new Error("The hook's process no longer exists.")
    await load()
    setEditing({ playbook: current, hook, definition: processGraph.definition })
  }

  if (editing) {
    return (
      <div className="flex h-full min-h-[36rem] flex-col">
        <p className="mb-3 text-xs text-muted-foreground">
          Bind each step to a seat role (builder, qa, lead…) so it runs in the
          rig's seats. On slice playbooks, mark the verifying step as the proof
          step.
        </p>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
          <ProcessBuilder
            key={editing.definition.id}
            // Read the definition from the reloaded list so saved changes
            // (e.g. the rework-routing switch) show up; the snapshot taken
            // when editing started would stay stale.
            definition={
              definitions.find((d) => d.id === editing.definition.id) ??
              editing.definition
            }
            agents={agents}
            providerModels={providers}
            definitions={definitions}
            onDefinitionChanged={() => void load()}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold">Playbooks</h2>
        <p className="text-sm text-muted-foreground">
          The steps a slice, mission, or initiative runs, bound to the rig's
          seats by role.
        </p>
      </div>
      {ALTITUDES.map((altitude) => {
        const items = (playbooks ?? []).filter(
          (p) => p.altitude === altitude.altitude
        )
        return (
          <section key={altitude.altitude} className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">
                {altitude.label} playbooks
              </h3>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void run(() =>
                    window.cowork.missionControl.playbooks.createDefault(
                      altitude.altitude
                    )
                  )
                }
              >
                <Plus className="size-4" /> Create from default
              </Button>
            </div>
            {playbooks && items.length === 0 && (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                <BookOpen className="mx-auto mb-2 size-6" />
                No {altitude.label.toLowerCase()} playbooks yet. Running one
                creates the default automatically.
              </div>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              {items.map((playbook) => (
                <Card key={playbook.id}>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      {playbook.name}
                      <Button
                        className="ml-auto"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${playbook.name}`}
                        onClick={() =>
                          void run(() =>
                            window.cowork.missionControl.playbooks.delete(
                              playbook.id
                            )
                          )
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {playbook.description && (
                      <p className="text-sm text-muted-foreground">
                        {playbook.description}
                      </p>
                    )}
                    {altitude.hooks.map(({ hook, label, note }) => {
                      const assigned = playbook.hooks.find(
                        (h) => h.hook === hook
                      )
                      const name = assigned
                        ? definitions.find((d) => d.id === assigned.processId)
                            ?.name
                        : null
                      return (
                        <div
                          key={hook}
                          className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                        >
                          <span className="font-medium">{label}</span>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {assigned
                              ? (name ?? "Process")
                              : (note ?? "Empty — skipped")}
                          </span>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              void editHook(playbook, hook).catch((error) =>
                                toast.error(errorMessage(error))
                              )
                            }
                          >
                            {assigned ? (
                              <>
                                <Pencil className="size-3" /> Edit steps
                              </>
                            ) : (
                              <>
                                <Plus className="size-3" /> Add steps
                              </>
                            )}
                          </Button>
                          {assigned && (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Clear the ${label} hook`}
                              onClick={() =>
                                void run(() =>
                                  window.cowork.missionControl.playbooks.removeHook(
                                    playbook.id,
                                    hook
                                  )
                                )
                              }
                            >
                              <XIcon className="size-3.5" />
                            </Button>
                          )}
                        </div>
                      )
                    })}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
