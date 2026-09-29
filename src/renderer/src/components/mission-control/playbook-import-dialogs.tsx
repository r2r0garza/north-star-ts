import { useEffect, useMemo, useState } from "react"
import { Workflow } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  PlaybookAgentRole,
  PlaybookWithHooks,
  ProcessDefinition,
  Rig,
} from "@/types"

// Processes sunset (plan 106.9): pick a Process to use as a user story
// playbook, and optionally rebind its named agents to seat roles.

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^\w*Error:\s*/, "")
}

export function UseProcessDialog({
  open,
  onOpenChange,
  definitions,
  playbooks,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  definitions: ProcessDefinition[]
  playbooks: PlaybookWithHooks[]
  onImported: (playbook: PlaybookWithHooks) => void
}) {
  const [query, setQuery] = useState("")
  useEffect(() => {
    if (open) setQuery("")
  }, [open])

  // Definitions a playbook owns are its steps, not Processes; one already used
  // as a user story playbook is left out too.
  const candidates = useMemo(() => {
    const taken = new Set<string>()
    for (const playbook of playbooks)
      for (const hook of playbook.hooks)
        if (hook.ownsProcess || playbook.altitude === "user_story")
          taken.add(hook.processId)
    const q = query.trim().toLowerCase()
    return definitions
      .filter((definition) => !taken.has(definition.id))
      .filter(
        (definition) =>
          !q ||
          definition.name.toLowerCase().includes(q) ||
          (definition.description ?? "").toLowerCase().includes(q)
      )
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      )
  }, [definitions, playbooks, query])

  async function choose(definition: ProcessDefinition) {
    try {
      const playbook =
        await window.cowork.missionControl.playbooks.importProcess(
          definition.id
        )
      onOpenChange(false)
      onImported(playbook)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Use a process as a playbook</DialogTitle>
          <DialogDescription>
            The playbook runs the same process, so edits stay in one place.
            Removing the playbook later keeps the process.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter processes…"
          autoFocus
        />
        <div className="max-h-80 divide-y overflow-y-auto rounded-md border">
          {candidates.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {definitions.length === 0
                ? "No processes yet."
                : "No processes left to use."}
            </p>
          ) : (
            candidates.map((definition) => (
              <button
                key={definition.id}
                type="button"
                onClick={() => void choose(definition)}
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/40"
              >
                <Workflow className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {definition.name}
                  </span>
                  {definition.description && (
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {definition.description}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

const NO_RIG = "none"

export function ConvertRolesDialog({
  processId,
  onOpenChange,
  onConverted,
}: {
  // Open while set.
  processId: string | null
  onOpenChange: (open: boolean) => void
  onConverted: () => void
}) {
  const [rows, setRows] = useState<PlaybookAgentRole[] | null>(null)
  const [roles, setRoles] = useState<Record<string, string>>({})
  const [rigs, setRigs] = useState<Rig[]>([])
  const [rigId, setRigId] = useState(NO_RIG)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!processId) return
    let cancelled = false
    setRows(null)
    setRigId(NO_RIG)
    setSaving(false)
    Promise.all([
      window.cowork.missionControl.playbooks.roleConversion(processId),
      window.cowork.missionControl.rigs.list(),
    ])
      .then(([agents, rigList]) => {
        if (cancelled) return
        setRows(agents)
        setRoles(
          Object.fromEntries(
            agents.map((agent) => [agent.agentName, agent.suggestedRole])
          )
        )
        setRigs(rigList)
      })
      .catch((error) => {
        if (!cancelled) toast.error(errorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [processId])

  async function convert() {
    if (!processId) return
    setSaving(true)
    try {
      const result = await window.cowork.missionControl.playbooks.convertRoles({
        processId,
        mapping: roles,
        rigId: rigId === NO_RIG ? null : rigId,
      })
      toast.success(
        `Converted ${result.converted} pool ${result.converted === 1 ? "entry" : "entries"} to seat roles`
      )
      if (result.missingRoles.length)
        toast.warning(
          `The rig has no seat for: ${result.missingRoles.join(", ")}. Add those roles before running it in a feature.`
        )
      onOpenChange(false)
      onConverted()
    } catch (error) {
      toast.error(errorMessage(error))
      setSaving(false)
    }
  }

  return (
    <Dialog open={processId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Convert agents to seat roles</DialogTitle>
          <DialogDescription>
            Each step then runs in whichever rig seat holds the role. Leave a
            role blank to keep that agent. This changes the process itself, so
            run it with Quick run afterwards, which binds roles to agents.
          </DialogDescription>
        </DialogHeader>
        {rows === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No steps name an agent, so there's nothing to convert.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              {rows.map((row) => (
                <div key={row.agentName} className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{row.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.phaseCount} {row.phaseCount === 1 ? "step" : "steps"}
                    </p>
                  </div>
                  <Input
                    className="w-40 font-mono text-xs"
                    aria-label={`Seat role for ${row.label}`}
                    value={roles[row.agentName] ?? ""}
                    placeholder="Keep agent"
                    onChange={(event) =>
                      setRoles((current) => ({
                        ...current,
                        [row.agentName]: event.target.value,
                      }))
                    }
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Check against a rig</Label>
              <Select value={rigId} onValueChange={setRigId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_RIG}>Don't check</SelectItem>
                  {rigs.map((rig) => (
                    <SelectItem key={rig.id} value={rig.id}>
                      {rig.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void convert()}
            disabled={saving || !rows?.length}
          >
            {saving ? "Converting…" : "Convert"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
