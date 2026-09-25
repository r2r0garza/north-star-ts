import { useCallback, useEffect, useMemo, useState } from "react"
import {
  ArrowLeft,
  Copy,
  Download,
  Network,
  Plus,
  Trash2,
  Upload,
  Users,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
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
import { Textarea } from "@/components/ui/textarea"
import { Markdown } from "@/components/markdown"
import { InitiativesTab } from "@/components/mission-control/initiatives-tab"
import {
  PlaybooksTab,
  playbookEditingHeader,
  type PlaybookEditing,
} from "@/components/mission-control/playbooks-tab"
import type {
  AccountWithModels,
  AgentSummary,
  InitiativeGraph,
  ProcessRuntimeConfig,
  Rig,
  RigDecisionRight,
  RigGraph,
  RigPod,
  RigSeat,
} from "@/types"

const RIGHTS: Array<{ value: RigDecisionRight; label: string }> = [
  { value: "assign_slice", label: "Assign slice" },
  { value: "revise_plan", label: "Revise plan" },
  { value: "accept_proof", label: "Accept proof" },
  { value: "merge", label: "Merge" },
  { value: "escalate_to_user", label: "Escalate to user" },
  { value: "approve_followup", label: "Approve follow-up" },
]

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32)
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^(?:RigValidationError|SqliteError|Error):\s*/, "")
}

function RuntimeSelect({
  providers,
  value,
  onChange,
}: {
  providers: AccountWithModels[]
  value: ProcessRuntimeConfig | null
  onChange: (value: ProcessRuntimeConfig | null) => void
}) {
  const selected = value?.worker
  const current =
    selected?.accountId && selected.modelId
      ? `${selected.accountId}::${selected.modelId}`
      : "inherit"
  return (
    <Select
      value={current}
      onValueChange={(next) => {
        if (next === "inherit") return onChange(null)
        const [accountId, modelId] = next.split("::")
        const provider = providers.find(
          (entry) => entry.account.id === accountId
        )?.account.provider
        onChange({ worker: { accountId, modelId, provider } })
      }}
    >
      <SelectTrigger>
        <SelectValue placeholder="Inherit" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="inherit">Inherit</SelectItem>
        {providers.flatMap((entry) =>
          entry.models.map((model) => (
            <SelectItem
              key={`${entry.account.id}::${model.modelId}`}
              value={`${entry.account.id}::${model.modelId}`}
            >
              {entry.account.displayName} / {model.modelName || model.modelId}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  )
}

function CultureEditor({
  label,
  value,
  onSave,
}: {
  label: string
  value: string
  onSave: (value: string) => Promise<void>
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <div className="grid gap-3 rounded-lg border p-4 lg:grid-cols-2">
      <div className="space-y-2">
        <Label>{label}</Label>
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={7}
          maxLength={32768}
          placeholder="Markdown guidance for this team…"
        />
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{draft.length.toLocaleString()} / 32,768</span>
          <Button
            size="sm"
            disabled={draft === value}
            onClick={() => void onSave(draft)}
          >
            Save culture
          </Button>
        </div>
      </div>
      <div className="min-h-36 rounded-md bg-muted/40 p-3">
        {draft.trim() ? (
          <Markdown content={draft} preserveSoftBreaks />
        ) : (
          <span className="text-sm text-muted-foreground">Preview</span>
        )}
      </div>
    </div>
  )
}

function SeatDialog({
  open,
  pod,
  seat,
  agents,
  providers,
  onOpenChange,
  onSaved,
}: {
  open: boolean
  pod: RigPod
  seat: RigSeat | null
  agents: AgentSummary[]
  providers: AccountWithModels[]
  onOpenChange: (open: boolean) => void
  onSaved: () => Promise<void>
}) {
  const [key, setKey] = useState("")
  const [role, setRole] = useState("")
  const [charter, setCharter] = useState("")
  const [agentRefId, setAgentRefId] = useState("vacant")
  const [runtimeConfig, setRuntimeConfig] =
    useState<ProcessRuntimeConfig | null>(null)
  const [rights, setRights] = useState<RigDecisionRight[]>([])
  const [skills, setSkills] = useState("")
  const [tools, setTools] = useState("")
  const [mcpServers, setMcpServers] = useState("")
  useEffect(() => {
    if (!open) return
    setKey(seat?.key ?? "")
    setRole(seat?.role ?? "")
    setCharter(seat?.charter ?? "")
    setAgentRefId(seat?.agentRefId ?? "vacant")
    setRuntimeConfig(seat?.runtimeConfig ?? null)
    setRights(seat?.decisionRights ?? [])
    setSkills(seat?.skills?.join(", ") ?? "")
    setTools(seat?.tools?.join(", ") ?? "")
    setMcpServers(seat?.mcpServers?.join(", ") ?? "")
  }, [open, seat])
  const save = async () => {
    const selectedAgent = agents.find((agent) => agent.refId === agentRefId)
    const input = {
      key: slug(key),
      role: slug(role),
      charter,
      agentRefId: selectedAgent?.refId ?? null,
      agentLabel: selectedAgent?.label ?? null,
      decisionRights: rights,
      runtimeConfig,
      skills: skills.trim()
        ? skills
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : null,
      tools: tools.trim()
        ? tools
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : null,
      mcpServers: mcpServers.trim()
        ? mcpServers
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : null,
    }
    if (seat) await window.cowork.missionControl.seats.update(seat.id, input)
    else
      await window.cowork.missionControl.seats.create({
        ...input,
        podId: pod.id,
      })
    onOpenChange(false)
    await onSaved()
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{seat ? "Edit seat" : "Add seat"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Seat key</Label>
              <Input
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder="builder"
              />
            </div>
            <div className="space-y-1">
              <Label>Role</Label>
              <Input
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="builder"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Agent</Label>
            <Select value={agentRefId} onValueChange={setAgentRefId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vacant">Vacant</SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.refId} value={agent.refId}>
                    {agent.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Charter</Label>
            <Textarea
              value={charter}
              onChange={(event) => setCharter(event.target.value)}
              rows={5}
              placeholder="What this seat owns, and what it does not own."
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>Skills</Label>
              <Input
                value={skills}
                onChange={(event) => setSkills(event.target.value)}
                placeholder="inherit (blank)"
              />
            </div>
            <div className="space-y-1">
              <Label>Tools</Label>
              <Input
                value={tools}
                onChange={(event) => setTools(event.target.value)}
                placeholder="inherit (blank)"
              />
            </div>
            <div className="space-y-1">
              <Label>MCP servers</Label>
              <Input
                value={mcpServers}
                onChange={(event) => setMcpServers(event.target.value)}
                placeholder="inherit (blank)"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Comma-separated narrowing. Blank inherits the agent definition.
          </p>
          <div className="space-y-2">
            <Label>Decision rights</Label>
            <div className="flex flex-wrap gap-2">
              {RIGHTS.map((right) => (
                <Button
                  key={right.value}
                  type="button"
                  size="sm"
                  variant={
                    rights.includes(right.value) ? "secondary" : "outline"
                  }
                  onClick={() =>
                    setRights((current) =>
                      current.includes(right.value)
                        ? current.filter((value) => value !== right.value)
                        : [...current, right.value]
                    )
                  }
                >
                  {right.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label>Worker runtime</Label>
            <RuntimeSelect
              providers={providers}
              value={runtimeConfig}
              onChange={setRuntimeConfig}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!slug(key) || !slug(role)}
            onClick={() =>
              void save().catch((error) => toast.error(errorMessage(error)))
            }
          >
            Save seat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RigDetail({
  graph,
  agents,
  providers,
  onBack,
  onRefresh,
}: {
  graph: RigGraph & {
    diagnostics: Array<{
      severity: "warning" | "error"
      code: string
      message: string
      entityId?: string
    }>
  }
  agents: AgentSummary[]
  providers: AccountWithModels[]
  onBack: () => void
  onRefresh: () => Promise<void>
}) {
  const [editingSeat, setEditingSeat] = useState<{
    pod: RigPod
    seat: RigSeat | null
  } | null>(null)
  const [rigName, setRigName] = useState(graph.rig.name)
  const [rigDescription, setRigDescription] = useState(
    graph.rig.description ?? ""
  )
  const [newPodOpen, setNewPodOpen] = useState(false)
  const [podName, setPodName] = useState("")
  const [oversightFrom, setOversightFrom] = useState("")
  const [oversightTo, setOversightTo] = useState("")
  const seatsByPod = useMemo(() => {
    const map = new Map<string, RigSeat[]>()
    for (const seat of graph.seats)
      map.set(seat.podId, [...(map.get(seat.podId) ?? []), seat])
    return map
  }, [graph.seats])
  const podById = new Map(graph.pods.map((pod) => [pod.id, pod]))
  const agentByRef = new Map(agents.map((agent) => [agent.refId, agent]))
  const addOversight = async () => {
    if (!oversightFrom || !oversightTo) return
    await window.cowork.missionControl.oversight.set(graph.rig.id, [
      ...graph.oversight.map((edge) => ({
        overseerPodId: edge.overseerPodId,
        overseenPodId: edge.overseenPodId,
      })),
      { overseerPodId: oversightFrom, overseenPodId: oversightTo },
    ])
    setOversightFrom("")
    setOversightTo("")
    await onRefresh()
  }
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background pt-11">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold">{graph.rig.name}</h1>
          <p className="text-sm text-muted-foreground">
            {graph.rig.description || "Reusable team topology"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void window.cowork.missionControl.rigs.export(graph.rig.id)
          }
        >
          {" "}
          <Download className="size-4" /> Save as template
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void window.cowork.missionControl.rigs
              .duplicate(graph.rig.id)
              .then(onRefresh)
          }
        >
          {" "}
          <Copy className="size-4" /> Duplicate
        </Button>
      </header>
      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        {graph.diagnostics.map((diagnostic) => (
          <div
            key={`${diagnostic.code}:${diagnostic.entityId ?? "rig"}`}
            className={
              diagnostic.severity === "error"
                ? "rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
                : "rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
            }
          >
            {diagnostic.message}
          </div>
        ))}
        <section className="grid gap-3 rounded-lg border p-4 md:grid-cols-[1fr_2fr_auto]">
          <div className="space-y-1">
            <Label>Rig name</Label>
            <Input
              value={rigName}
              onChange={(event) => setRigName(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Input
              value={rigDescription}
              onChange={(event) => setRigDescription(event.target.value)}
            />
          </div>
          <Button
            className="self-end"
            size="sm"
            disabled={
              !rigName.trim() ||
              (rigName === graph.rig.name &&
                rigDescription === (graph.rig.description ?? ""))
            }
            onClick={() =>
              void window.cowork.missionControl.rigs
                .update(graph.rig.id, {
                  name: rigName.trim(),
                  description: rigDescription.trim() || null,
                })
                .then(onRefresh)
            }
          >
            Save details
          </Button>
        </section>
        <CultureEditor
          label="Rig culture"
          value={graph.rig.cultureMd}
          onSave={async (cultureMd) => {
            await window.cowork.missionControl.rigs.update(graph.rig.id, {
              cultureMd,
            })
            await onRefresh()
          }}
        />
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-semibold">Pods and seats</h2>
              <p className="text-sm text-muted-foreground">
                Stable seats keep their addresses when agents change.
              </p>
            </div>
            <Button size="sm" onClick={() => setNewPodOpen(true)}>
              <Plus className="size-4" /> Add pod
            </Button>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            {graph.pods.map((pod) => {
              const seats = seatsByPod.get(pod.id) ?? []
              return (
                <Card key={pod.id}>
                  <CardHeader className="flex-row items-start justify-between">
                    <div>
                      <CardTitle>{pod.name}</CardTitle>
                      <code className="text-xs text-muted-foreground">
                        @{pod.key}
                      </code>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        void window.cowork.missionControl.pods
                          .delete(pod.id)
                          .then(onRefresh)
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {seats.map((seat) => {
                      const agent = seat.agentRefId
                        ? agentByRef.get(seat.agentRefId)
                        : null
                      const status = !seat.agentRefId
                        ? "Vacant"
                        : agent
                          ? agent.label
                          : `Unresolved: ${seat.agentLabel || "agent"}`
                      return (
                        <button
                          key={seat.id}
                          className="flex w-full flex-col gap-2 rounded-md border p-3 text-left hover:bg-muted/50"
                          onClick={() => setEditingSeat({ pod, seat })}
                        >
                          <div className="flex w-full items-center gap-2">
                            <code className="font-medium">
                              {seat.key}@{pod.key}
                            </code>
                            <Badge variant="outline">{seat.role}</Badge>
                            {pod.leadSeatId === seat.id && <Badge>Lead</Badge>}
                            <span className="ml-auto truncate text-xs text-muted-foreground">
                              {status}
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {seat.runtimeConfig?.worker ? (
                              <Badge variant="secondary">
                                Runtime override
                              </Badge>
                            ) : (
                              <Badge variant="outline">Inherit runtime</Badge>
                            )}
                            {seat.decisionRights.map((right) => (
                              <Badge key={right} variant="secondary">
                                {right.replaceAll("_", " ")}
                              </Badge>
                            ))}
                          </div>
                        </button>
                      )
                    })}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => setEditingSeat({ pod, seat: null })}
                    >
                      <Plus className="size-4" /> Add seat
                    </Button>
                    {seats.length > 0 && (
                      <div className="space-y-1">
                        <Label>Lead seat</Label>
                        <Select
                          value={pod.leadSeatId ?? "none"}
                          onValueChange={(leadSeatId) =>
                            void window.cowork.missionControl.pods
                              .update(pod.id, {
                                leadSeatId:
                                  leadSeatId === "none" ? null : leadSeatId,
                              })
                              .then(onRefresh)
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="No lead" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No lead</SelectItem>
                            {seats.map((seat) => (
                              <SelectItem key={seat.id} value={seat.id}>
                                {seat.key}@{pod.key}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <CultureEditor
                      label={`${pod.name} culture`}
                      value={pod.cultureMd}
                      onSave={async (cultureMd) => {
                        await window.cowork.missionControl.pods.update(pod.id, {
                          cultureMd,
                        })
                        await onRefresh()
                      }}
                    />
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </section>
        <section className="space-y-3">
          <div>
            <h2 className="font-semibold">Oversight</h2>
            <p className="text-sm text-muted-foreground">
              Directed responsibility between pods. Cycles are rejected.
            </p>
          </div>
          <div className="space-y-2">
            {graph.oversight.map((edge) => (
              <div
                key={edge.id}
                className="flex items-center rounded-md border px-3 py-2 text-sm"
              >
                <span>{podById.get(edge.overseerPodId)?.name}</span>
                <span className="mx-2 text-muted-foreground">oversees</span>
                <span>{podById.get(edge.overseenPodId)?.name}</span>
                <Button
                  className="ml-auto"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() =>
                    void window.cowork.missionControl.oversight
                      .set(
                        graph.rig.id,
                        graph.oversight
                          .filter((item) => item.id !== edge.id)
                          .map((item) => ({
                            overseerPodId: item.overseerPodId,
                            overseenPodId: item.overseenPodId,
                          }))
                      )
                      .then(onRefresh)
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
          {graph.pods.length > 1 && (
            <div className="flex gap-2">
              <Select value={oversightFrom} onValueChange={setOversightFrom}>
                <SelectTrigger>
                  <SelectValue placeholder="Overseer pod" />
                </SelectTrigger>
                <SelectContent>
                  {graph.pods.map((pod) => (
                    <SelectItem key={pod.id} value={pod.id}>
                      {pod.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={oversightTo} onValueChange={setOversightTo}>
                <SelectTrigger>
                  <SelectValue placeholder="Overseen pod" />
                </SelectTrigger>
                <SelectContent>
                  {graph.pods.map((pod) => (
                    <SelectItem key={pod.id} value={pod.id}>
                      {pod.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                onClick={() =>
                  void addOversight().catch((error) =>
                    toast.error(errorMessage(error))
                  )
                }
              >
                Add edge
              </Button>
            </div>
          )}
        </section>
      </div>
      {editingSeat && (
        <SeatDialog
          open
          pod={editingSeat.pod}
          seat={editingSeat.seat}
          agents={agents}
          providers={providers}
          onOpenChange={(open) => !open && setEditingSeat(null)}
          onSaved={onRefresh}
        />
      )}
      <Dialog open={newPodOpen} onOpenChange={setNewPodOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add pod</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Pod name</Label>
            <Input
              value={podName}
              onChange={(event) => setPodName(event.target.value)}
              placeholder="Implementation"
            />
            <p className="text-xs text-muted-foreground">
              Address domain: @{slug(podName) || "pod-key"}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewPodOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!slug(podName)}
              onClick={() =>
                void window.cowork.missionControl.pods
                  .create({
                    rigId: graph.rig.id,
                    key: slug(podName),
                    name: podName.trim(),
                  })
                  .then(async () => {
                    setNewPodOpen(false)
                    setPodName("")
                    await onRefresh()
                  })
                  .catch((error) => toast.error(errorMessage(error)))
              }
            >
              Add pod
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function MissionControlScreen({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"initiatives" | "rigs" | "playbooks">(
    "initiatives"
  )
  const [rigs, setRigs] = useState<Rig[]>([])
  const [initiativeGraph, setInitiativeGraph] =
    useState<InitiativeGraph | null>(null)
  const [playbookEditing, setPlaybookEditing] =
    useState<PlaybookEditing | null>(null)
  const [missionId, setMissionId] = useState<string | null>(null)
  const [sliceId, setSliceId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [graph, setGraph] = useState<
    | (RigGraph & {
        diagnostics: Array<{
          severity: "warning" | "error"
          code: string
          message: string
          entityId?: string
        }>
      })
    | null
  >(null)
  const [agents, setAgents] = useState<AgentSummary[]>([])
  const [providers, setProviders] = useState<AccountWithModels[]>([])
  const load = useCallback(async () => {
    const [nextRigs, nextAgents, nextProviders] = await Promise.all([
      window.cowork.missionControl.rigs.list(),
      window.cowork.agents.list(),
      window.cowork.providers.listWithModels(),
    ])
    setRigs(nextRigs)
    setAgents(nextAgents)
    setProviders(nextProviders)
  }, [])
  const deleteRig = async (rig: Rig) => {
    const using = (
      await window.cowork.missionControl.initiatives.list()
    ).filter((initiative) => initiative.rigId === rig.id)
    const quoted = (items: typeof using) =>
      items.map((item) => `“${item.name}”`).join(", ")
    // The repository refuses this too; checking first skips a pointless
    // confirmation.
    const running = using.filter((item) =>
      ["active", "paused"].includes(item.status)
    )
    if (running.length) {
      toast.error(
        `“${rig.name}” is in use by ${quoted(running)}. Finish or cancel ${running.length === 1 ? "that initiative" : "those initiatives"} before deleting the rig.`
      )
      return
    }
    const drafts = using.filter((item) => item.status === "draft")
    const lines = [
      `Delete rig “${rig.name}” with all its pods and seats? This cannot be undone.`,
    ]
    if (drafts.length)
      lines.push(
        `${quoted(drafts)} will no longer have a rig and will need a new one before starting.`
      )
    if (!window.confirm(lines.join("\n\n"))) return
    await window.cowork.missionControl.rigs.delete(rig.id)
    await load()
  }
  const refreshGraph = useCallback(async () => {
    if (!selectedId) return
    const next = await window.cowork.missionControl.rigs.get(selectedId)
    setGraph(next)
    await load()
  }, [load, selectedId])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (selectedId) void refreshGraph()
    else setGraph(null)
  }, [selectedId, refreshGraph])
  useEffect(() => {
    setMissionId(null)
    setSliceId(null)
  }, [initiativeGraph?.initiative.id])

  const mission =
    initiativeGraph?.missions.find((item) => item.id === missionId) ?? null
  const slice =
    initiativeGraph?.slices.find((item) => item.id === sliceId) ?? null
  const sliceMission = slice
    ? (initiativeGraph?.missions.find((item) => item.id === slice.missionId) ??
      null)
    : null
  const initiativeName = initiativeGraph?.initiative.name
  const initiativeTitle = slice
    ? `Slice: ${slice.title}`
    : mission
      ? `Mission: ${mission.name}`
      : initiativeGraph
        ? `Initiative: ${initiativeName}`
        : null
  const initiativeDescription = slice
    ? `Initiative: ${initiativeName}${sliceMission ? ` - Mission: ${sliceMission.name}` : ""}`
    : mission
      ? `Initiative: ${initiativeName}`
      : initiativeGraph?.initiative.intent

  const playbookHeader =
    tab === "playbooks" && playbookEditing
      ? playbookEditingHeader(playbookEditing)
      : null
  const headerTitle =
    playbookHeader?.title ?? (tab === "initiatives" ? initiativeTitle : null)
  const headerDescription =
    playbookHeader?.description ??
    (tab === "initiatives" ? initiativeDescription : null)
  const inDetail = playbookHeader
    ? true
    : tab === "initiatives" && !!initiativeGraph

  const backFromInitiativeDetail = () => {
    if (sliceId) {
      setMissionId(slice?.missionId ?? missionId)
      setSliceId(null)
      return
    }
    if (missionId) {
      setMissionId(null)
      return
    }
    setInitiativeGraph(null)
  }

  const createStarter = async (kind: "solo" | "orchestrated") => {
    const rig = await window.cowork.missionControl.rigs.create({
      name: kind === "solo" ? "Solo builder" : "Orchestrated",
      description:
        kind === "solo"
          ? "A focused delivery pod with builder and QA seats."
          : "Orchestration oversees implementation.",
    })
    if (kind === "solo") {
      const pod = await window.cowork.missionControl.pods.create({
        rigId: rig.id,
        key: "delivery",
        name: "Delivery",
      })
      await window.cowork.missionControl.seats.create({
        podId: pod.id,
        key: "builder",
        role: "builder",
      })
      await window.cowork.missionControl.seats.create({
        podId: pod.id,
        key: "qa",
        role: "qa",
      })
    } else {
      const leadPod = await window.cowork.missionControl.pods.create({
        rigId: rig.id,
        key: "orchestration",
        name: "Orchestration",
      })
      const implementation = await window.cowork.missionControl.pods.create({
        rigId: rig.id,
        key: "implementation",
        name: "Implementation",
      })
      const lead = await window.cowork.missionControl.seats.create({
        podId: leadPod.id,
        key: "lead",
        role: "lead",
        decisionRights: ["assign_slice", "escalate_to_user"],
      })
      await window.cowork.missionControl.pods.update(leadPod.id, {
        leadSeatId: lead.id,
      })
      await window.cowork.missionControl.seats.create({
        podId: implementation.id,
        key: "builder",
        role: "builder",
      })
      await window.cowork.missionControl.seats.create({
        podId: implementation.id,
        key: "qa",
        role: "qa",
      })
      await window.cowork.missionControl.oversight.set(rig.id, [
        { overseerPodId: leadPod.id, overseenPodId: implementation.id },
      ])
    }
    await load()
    setSelectedId(rig.id)
  }

  if (graph)
    return (
      <RigDetail
        graph={graph}
        agents={agents}
        providers={providers}
        onBack={() => setSelectedId(null)}
        onRefresh={refreshGraph}
      />
    )
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background pt-11">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() =>
            playbookHeader
              ? setPlaybookEditing(null)
              : inDetail
                ? backFromInitiativeDetail()
                : onClose()
          }
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">
            {headerTitle || "Mission Control"}
          </h1>
          <p className="truncate text-sm text-muted-foreground">
            {headerDescription ||
              "Map durable work and define the teams that will drive it."}
          </p>
        </div>
      </header>
      {!inDetail && (
        <div className="flex gap-5 border-b px-6">
          <button
            className={`py-3 text-sm font-medium ${tab === "initiatives" ? "border-b-2 border-primary" : "text-muted-foreground"}`}
            onClick={() => setTab("initiatives")}
          >
            Initiatives
          </button>
          <button
            className={`py-3 text-sm font-medium ${tab === "rigs" ? "border-b-2 border-primary" : "text-muted-foreground"}`}
            onClick={() => setTab("rigs")}
          >
            Rigs
          </button>
          <button
            className={`py-3 text-sm font-medium ${tab === "playbooks" ? "border-b-2 border-primary" : "text-muted-foreground"}`}
            onClick={() => setTab("playbooks")}
          >
            Playbooks
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "initiatives" ? (
          <InitiativesTab
            rigs={rigs}
            graph={initiativeGraph}
            missionId={missionId}
            sliceId={sliceId}
            onGraphChange={setInitiativeGraph}
            onMissionChange={setMissionId}
            onSliceChange={setSliceId}
          />
        ) : tab === "playbooks" ? (
          <PlaybooksTab
            editing={playbookEditing}
            onEditingChange={setPlaybookEditing}
          />
        ) : (
          <>
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="font-semibold">Rigs</h2>
                <p className="text-sm text-muted-foreground">
                  Pods organize stable seats; agents can be swapped without
                  changing addresses.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void window.cowork.missionControl.rigs
                      .import()
                      .then(async (result) => {
                        if (!result.canceled && result.rigId) {
                          await load()
                          setSelectedId(result.rigId)
                          result.warnings?.forEach((warning) =>
                            toast.warning(warning)
                          )
                        }
                      })
                  }
                >
                  <Upload className="size-4" /> Import
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    void window.cowork.missionControl.rigs
                      .create({ name: "Untitled rig" })
                      .then(async (rig) => {
                        await load()
                        setSelectedId(rig.id)
                      })
                  }
                >
                  <Plus className="size-4" /> New rig
                </Button>
              </div>
            </div>
            {rigs.length === 0 ? (
              <div className="grid place-items-center rounded-xl border border-dashed py-16 text-center">
                <Network className="mb-3 size-9 text-muted-foreground" />
                <h3 className="font-medium">Build your first rig</h3>
                <p className="mt-1 mb-5 max-w-md text-sm text-muted-foreground">
                  Start from a useful topology, then assign agents, charters,
                  runtime, and decision rights.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => void createStarter("solo")}
                  >
                    <Users className="size-4" /> Solo builder
                  </Button>
                  <Button onClick={() => void createStarter("orchestrated")}>
                    <Network className="size-4" /> Orchestrated
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {rigs.map((rig) => (
                  <Card
                    key={rig.id}
                    className="cursor-pointer hover:bg-muted/30"
                    onClick={() => setSelectedId(rig.id)}
                  >
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Network className="size-4" />
                        {rig.name}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="line-clamp-2 text-sm text-muted-foreground">
                        {rig.description || "Reusable team topology"}
                      </p>
                      <div className="mt-4 flex justify-end">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={(event) => {
                            event.stopPropagation()
                            void deleteRig(rig).catch((error) =>
                              toast.error(errorMessage(error))
                            )
                          }}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
