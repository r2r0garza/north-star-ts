import type { AgentDefinition } from "../agent/agents/types"
import { getDb } from "../db/connection"
import * as features from "../db/repositories/features"
import * as playbooks from "../db/repositories/playbooks"
import * as processes from "../db/repositories/processes"
import * as rigs from "../db/repositories/rigs"
import type {
  PlaybookWithHooks,
  ProcessRun,
  ProcessRuntimeConfig,
  SeatBinding,
  SeatBindingsSnapshot,
} from "../db/types"
import {
  formatSeatAddress,
  isRigKey,
} from "../../shared/mission-control/address"
import { collectSeatRoles, SeatResolutionError } from "./seat-resolver"

// Processes sunset (plan 106.9). A Process becomes a user story playbook by
// reference — the playbook's run hook points at the SAME definition, so edits
// stay in one place — and Quick run starts any definition as an ordinary
// Process run, binding its seat roles to agents the user picks.

// Use an existing Process as a user story playbook. The hook doesn't own the
// definition: deleting the playbook leaves the Process in place. Idempotent —
// a Process already imported returns its playbook.
export function importProcessAsPlaybook(processId: string): PlaybookWithHooks {
  const definition = processes.getProcessDefinition(processId)
  if (!definition) throw new Error(`Process definition not found: ${processId}`)
  const existing = playbooks
    .listPlaybooks()
    .find(
      (playbook) =>
        playbook.altitude === "user_story" &&
        playbook.hooks.some(
          (hook) => hook.hook === "run" && hook.processId === processId
        )
    )
  if (existing) return existing
  return getDb().transaction(() => {
    const playbook = playbooks.createPlaybook({
      name: definition.name,
      altitude: "user_story",
      description: definition.description ?? "Imported from Processes.",
    })
    return playbooks.setHook(playbook.id, "run", processId, {
      ownsProcess: false,
    })
  })()
}

// A seat role suggested from an agent's name: the common Mission Control roles
// when the name says so, else the name itself as a role key.
export function suggestRole(agentName: string): string {
  const name = agentName.toLowerCase()
  if (/\b(qa|test|tester|verif\w*|review\w*|validat\w*)\b/.test(name))
    return "qa"
  if (/\b(lead|plan\w*|architect\w*|orchestrat\w*|manager)\b/.test(name))
    return "lead"
  if (/\b(build\w*|dev\w*|implement\w*|engineer\w*|coder|coding)\b/.test(name))
    return "builder"
  return roleKey(name) || "builder"
}

// A valid seat role key (lowercase, single hyphens, ≤ 32 chars), or "".
export function roleKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "")
}

export interface PlaybookAgentRole {
  // The pool row's stored agent name (a ref id or a legacy name).
  agentName: string
  label: string
  suggestedRole: string
  phaseCount: number
}

// The distinct named agents in a definition's phase pools, each with a
// suggested seat role, for the "Convert agents to seat roles" wizard.
export function listAgentsForRoleConversion(
  processId: string,
  agents: AgentDefinition[]
): PlaybookAgentRole[] {
  const graph = processes.getProcessGraph(processId)
  if (!graph) throw new Error(`Process definition not found: ${processId}`)
  const byName = new Map<string, Set<string>>()
  for (const row of graph.agents) {
    if (!row.agentName) continue
    const phases = byName.get(row.agentName) ?? new Set<string>()
    phases.add(row.phaseId)
    byName.set(row.agentName, phases)
  }
  return [...byName].map(([agentName, phases]) => {
    const agent = findAgent(agents, agentName)
    const label = agent?.label || agent?.name || agentName
    return {
      agentName,
      label,
      suggestedRole: suggestRole(agent?.name ?? label),
      phaseCount: phases.size,
    }
  })
}

function findAgent(
  agents: AgentDefinition[],
  name: string
): AgentDefinition | undefined {
  if (name.startsWith("agentref:v1:"))
    return agents.find((agent) => agent.refId === name)
  return [...agents].reverse().find((agent) => agent.name === name)
}

// Rewrite the named-agent pool rows to seat roles (agent name → role). Rows for
// agents left out of the mapping keep their agent. Every row names exactly one
// of an agent or a role afterwards, as before. Returns the rig roles missing,
// when a rig is given, so the caller can warn.
export function convertAgentsToSeatRoles(input: {
  processId: string
  mapping: Record<string, string>
  rigId?: string | null
}): { converted: number; missingRoles: string[] } {
  const graph = processes.getProcessGraph(input.processId)
  if (!graph)
    throw new Error(`Process definition not found: ${input.processId}`)
  const mapping = new Map<string, string>()
  for (const [agentName, role] of Object.entries(input.mapping)) {
    const key = role.trim().toLowerCase()
    if (!key) continue
    if (!isRigKey(key))
      throw new Error(
        `Seat role "${role}" must use lowercase letters, numbers, and single hyphens, up to 32 characters.`
      )
    mapping.set(agentName, key)
  }
  let converted = 0
  getDb().transaction(() => {
    for (const row of graph.agents) {
      const role = row.agentName ? mapping.get(row.agentName) : undefined
      if (!role) continue
      processes.setPhaseAgentSeatRole(row.id, role)
      converted++
    }
  })()
  return {
    converted,
    missingRoles: input.rigId
      ? missingRigRoles(input.rigId, [...new Set(mapping.values())])
      : [],
  }
}

// The roles a rig has no seat for.
export function missingRigRoles(rigId: string, roles: string[]): string[] {
  const graph = rigs.getRigGraph(rigId)
  if (!graph) throw new Error(`Rig not found: ${rigId}`)
  const present = new Set(graph.seats.map((seat) => seat.role))
  return roles.filter((role) => !present.has(role)).sort()
}

// Every seat role a definition (and its sub-processes) needs bound to run.
export function quickRunRoles(processId: string): string[] {
  const graph = processes.getProcessGraph(processId)
  if (!graph) throw new Error(`Process definition not found: ${processId}`)
  return collectSeatRoles(graph, (id) => processes.getProcessGraph(id))
}

const SOLO_POD = "solo"

// The ad-hoc "solo" binding a Quick run freezes onto its run: one seat per
// role in a single pod, each bound to the agent the user picked. Same shape a
// rig resolves to, so role-bound phases run exactly as they do in a user story.
export function buildSoloBindings(input: {
  roles: string[]
  roleAgents: Record<string, string>
  agents: AgentDefinition[]
}): SeatBindingsSnapshot {
  const snapshot: SeatBindingsSnapshot = {
    version: 1,
    rigName: "Quick run",
    rigCulture: "",
    podKey: SOLO_POD,
    roles: {},
    seats: {},
    intentChain: "",
  }
  const problems: string[] = []
  for (const role of input.roles) {
    const refId = input.roleAgents[role]
    if (!refId) {
      problems.push(`Pick an agent for the ${role} role.`)
      continue
    }
    const agent = findAgent(input.agents, refId)
    if (!agent) {
      problems.push(`The agent picked for ${role} is no longer available.`)
      continue
    }
    const address = formatSeatAddress(roleKey(role) || "seat", SOLO_POD)
    const seat: SeatBinding = {
      address,
      role,
      seatId: `quick-run:${role}`,
      podKey: SOLO_POD,
      podName: "Quick run",
      agentName: agent.refId,
      agentLabel: agent.label || agent.name,
      charter: "",
      podMission: "",
      podCulture: "",
      decisionRights: [],
      skills: null,
      tools: null,
      mcpServers: null,
      runtime: null,
    }
    snapshot.roles[role] = [address]
    snapshot.seats[address] = seat
  }
  if (problems.length) throw new SeatResolutionError(problems)
  return snapshot
}

// Run a definition against an objective with no feature: an ordinary Process
// run (visible in the Process monitor and Mission Control's history), with
// its seat roles bound solo when it has any.
export async function startQuickRun(
  deps: {
    loadAgents: (workspace: string) => Promise<AgentDefinition[]>
    startRun: (input: {
      processId: string
      sourceConversationId: string | null
      objective: string
      workspacePath?: string | null
      runtimeConfig?: ProcessRuntimeConfig | null
      seatBindings?: SeatBindingsSnapshot | null
    }) => Promise<ProcessRun>
  },
  input: {
    processId: string
    objective: string
    workspacePath: string
    runtimeConfig?: ProcessRuntimeConfig | null
    roleAgents?: Record<string, string>
  }
): Promise<ProcessRun> {
  const workspacePath = input.workspacePath.trim()
  if (!workspacePath) throw new Error("Choose a working directory.")
  const roles = quickRunRoles(input.processId)
  const seatBindings = roles.length
    ? buildSoloBindings({
        roles,
        roleAgents: input.roleAgents ?? {},
        agents: await deps.loadAgents(workspacePath),
      })
    : null
  return deps.startRun({
    processId: input.processId,
    sourceConversationId: null,
    objective: input.objective,
    workspacePath,
    runtimeConfig: input.runtimeConfig ?? null,
    seatBindings,
  })
}

export interface ProcessRunHistoryEntry {
  run: ProcessRun
  processName: string | null
  // Set for a run Mission Control started, so the history links back to it.
  featureName: string | null
  userStoryTitle: string | null
}

// Top-level Process runs, newest first — legacy runs, Quick runs, and Mission
// Control hook runs alike — for Mission Control's Playbooks → History.
export function listProcessRunHistory(limit = 200): ProcessRunHistoryEntry[] {
  const names = new Map(
    processes
      .listProcessDefinitions()
      .map((definition) => [definition.id, definition.name])
  )
  return processes
    .listProcessRuns()
    .filter((run) => !run.parentPhaseRunId)
    .slice(0, limit)
    .map((run) => {
      const link = run.missionControl
      return {
        run,
        processName: run.processId ? (names.get(run.processId) ?? null) : null,
        featureName: link
          ? (features.getFeature(link.featureId)?.name ?? null)
          : null,
        userStoryTitle: link?.userStoryId
          ? (features.getUserStory(link.userStoryId)?.title ?? null)
          : null,
      }
    })
}
