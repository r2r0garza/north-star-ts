import { getDb } from "../db/connection"
import * as playbooks from "../db/repositories/playbooks"
import * as processes from "../db/repositories/processes"
import type {
  PhaseContextScope,
  PlaybookAltitude,
  PlaybookHookName,
  PlaybookWithHooks,
} from "../db/types"

// Default playbooks shipped with Mission Control (plan 106.3). Created on
// demand and ordinary afterwards: the user edits their steps in the Process
// builder like any other definition. A phase's name is its instruction to the
// worker (the kickoff says "carry out the <name> phase"), so the names are
// written as imperatives.

interface DefaultStep {
  key: string
  name: string
  role: string
  validator?: boolean
  proofStep?: boolean
  // How long the step's conversation lives (plan 106.4). Builder and QA steps
  // share one session per user story run, so a user story's spec, build, and mail stay in
  // one context without piling up across user stories; the lead keeps a long-lived
  // session because it holds the plan.
  contextScope: PhaseContextScope
}

interface DefaultPlaybook {
  name: string
  description: string
  // Route cross-phase flag_for_rework autonomously instead of raising a
  // confirmation card (the Process builder's "Autonomous rework routing").
  autonomousRework?: boolean
  hooks: Partial<Record<PlaybookHookName, DefaultStep[]>>
}

export const DEFAULT_PLAYBOOKS: Record<PlaybookAltitude, DefaultPlaybook> = {
  user_story: {
    name: "Spec → Build → Test",
    description:
      "Refine the user story spec against the codebase, build it, then have QA verify each criterion in the running app and record an evidence-backed proof. The milestone's acceptance gate writes and runs the Playwright suite once the wave merges.",
    autonomousRework: true,
    hooks: {
      run: [
        {
          key: "spec",
          name: "Refine the user story spec against the codebase (read and plan; do not edit files)",
          role: "builder",
          contextScope: "user_story",
        },
        {
          key: "build",
          name: "Build the user story to its acceptance criteria",
          role: "builder",
          contextScope: "user_story",
        },
        {
          // Plan 110.04: QA proves the story by exploring the running app in
          // its worktree, with saved evidence. The wave gate (the milestone's
          // after_each_wave) writes and runs the Playwright suite.
          key: "test",
          name: "Start the app, verify each acceptance criterion by exercising it in the running app, and record the proof with evidence",
          role: "qa",
          // No validator: this step already verifies every criterion and the
          // proof tool gates it (independent verifier, frozen proof). A
          // validator re-ran the same verification in the same qa seat.
          proofStep: true,
          contextScope: "user_story",
        },
      ],
    },
  },
  milestone: {
    name: "Plan → Review",
    description:
      "Before user stories run, the lead reviews the user story set against the milestone outcome. When a user story's merge conflicts, the integrator (or the lead) resolves it and QA re-verifies the user story. After each wave merges, QA proves the merged user stories together on the integration branch. After all user stories, the lead writes the milestone summary.",
    hooks: {
      before_user_stories: [
        {
          key: "review-plan",
          name: "Review the milestone's user stories against its outcome and report gaps as proposals (do not edit the plan)",
          role: "lead",
          contextScope: "feature",
        },
      ],
      // Runs only when a user story's merge into the integration branch conflicts
      // (plan 106.5). A rig without an integrator seat falls back to its lead.
      after_each_user_story: [
        {
          key: "resolve",
          name: "Resolve the merge conflict in this worktree so both sides keep their intent (do not commit, abort, or switch branches)",
          role: "integrator",
          contextScope: "user_story",
        },
        {
          key: "reverify",
          name: "Re-verify the merged result against each acceptance criterion and record the proof",
          role: "qa",
          // No validator, for the same reason as the user story test step.
          proofStep: true,
          contextScope: "user_story",
        },
      ],
      // The wave acceptance gate (plan 110): runs once the milestone is
      // quiescent with merged user stories; they're done when it passes.
      after_each_wave: [
        {
          key: "accept",
          name: "Write and run the acceptance suite for the merged stories against the integrated app, triage every failure, and record the gate result",
          role: "qa",
          proofStep: true,
          contextScope: "user_story",
        },
      ],
      after_all_user_stories: [
        {
          key: "summary",
          name: "Write the milestone summary from the user story proofs as your final message",
          role: "lead",
          contextScope: "feature",
        },
      ],
    },
  },
  feature: {
    name: "Plan → Release",
    description:
      "The lead drafts milestones and user stories as a proposal document, and between milestones writes release notes and checks the next milestone.",
    hooks: {
      plan: [
        {
          key: "plan",
          name: "Draft the feature's milestones and user stories as a proposal document (do not edit the plan)",
          role: "lead",
          contextScope: "feature",
        },
      ],
      between_milestones: [
        {
          key: "release",
          name: "Write release notes for the finished milestone and check the next milestone is still right, as your final message",
          role: "lead",
          contextScope: "feature",
        },
      ],
    },
  },
}

function buildHookProcess(
  playbook: PlaybookWithHooks,
  hook: PlaybookHookName,
  steps: DefaultStep[]
): string {
  const definition = processes.createProcessDefinition({
    name: `${playbook.name} · ${hook.replace(/_/g, " ")}`,
    description: `Playbook step group for the ${hook} hook.`,
  })
  if (DEFAULT_PLAYBOOKS[playbook.altitude].autonomousRework)
    processes.updateProcessDefinition(definition.id, {
      requireFlagApproval: false,
    })
  let previous: string | null = null
  steps.forEach((step, position) => {
    const phase = processes.createPhase({
      processId: definition.id,
      key: step.key,
      name: step.name,
      validator: step.validator ?? false,
      validatorMaxIterations: step.validator ? 2 : 0,
      proofStep: step.proofStep ?? false,
      contextScope: step.contextScope,
      position,
    })
    processes.createPhaseAgent({
      phaseId: phase.id,
      seatRole: step.role,
      position: 0,
    })
    if (previous)
      processes.createEdge({
        processId: definition.id,
        fromPhaseId: previous,
        toPhaseId: phase.id,
      })
    previous = phase.id
  })
  return definition.id
}

// Create the default playbook for an altitude. Always creates a new copy, so a
// user who edited theirs can start again from the default.
export function createDefaultPlaybook(
  altitude: PlaybookAltitude
): PlaybookWithHooks {
  const template = DEFAULT_PLAYBOOKS[altitude]
  return getDb().transaction(() => {
    const playbook = playbooks.createPlaybook({
      name: template.name,
      altitude,
      description: template.description,
    })
    for (const [hook, steps] of Object.entries(template.hooks) as Array<
      [PlaybookHookName, DefaultStep[]]
    >) {
      playbooks.setHook(
        playbook.id,
        hook,
        buildHookProcess(playbook, hook, steps)
      )
    }
    return playbooks.getPlaybook(playbook.id)!
  })()
}

// The playbook to use for an altitude when the container names none: the first
// existing playbook at that altitude, else a freshly created default.
export function ensureDefaultPlaybook(
  altitude: PlaybookAltitude
): PlaybookWithHooks {
  return (
    playbooks.listPlaybooks().find((p) => p.altitude === altitude) ??
    createDefaultPlaybook(altitude)
  )
}

// ── Reset to default (plan 109.02) ──────────────────────────────────────────

// A step as compared between a playbook and the shipped template.
export interface PlaybookStepSummary {
  key: string
  name: string
  role: string | null
  proofStep: boolean
  validator: boolean
  contextScope: PhaseContextScope
}

export type PlaybookStepChange =
  | { change: "added"; step: PlaybookStepSummary }
  | { change: "removed"; step: PlaybookStepSummary }
  | {
      change: "changed"
      step: PlaybookStepSummary
      from: PlaybookStepSummary
      fields: Array<keyof PlaybookStepSummary>
    }
  | { change: "unchanged"; step: PlaybookStepSummary }

export interface PlaybookDefaultDiff {
  playbookId: string
  name: { current: string; template: string }
  hooks: Array<{ hook: PlaybookHookName; steps: PlaybookStepChange[] }>
  // False when the playbook already matches the template.
  differs: boolean
}

function templateSteps(step: DefaultStep): PlaybookStepSummary {
  return {
    key: step.key,
    name: step.name,
    role: step.role,
    proofStep: step.proofStep ?? false,
    validator: step.validator ?? false,
    contextScope: step.contextScope,
  }
}

// A hook's steps in run order (the defaults are a chain; position breaks
// ties for anything the user rewired).
function currentSteps(processId: string): PlaybookStepSummary[] {
  const graph = processes.getProcessGraph(processId)
  if (!graph) return []
  return [...graph.phases]
    .sort((a, b) => a.position - b.position)
    .map((phase) => ({
      key: phase.key,
      name: phase.name,
      role:
        graph.agents.find((agent) => agent.phaseId === phase.id)?.seatRole ??
        null,
      proofStep: !!phase.proofStep,
      validator: phase.validator,
      contextScope: phase.contextScope ?? "step",
    }))
}

const COMPARED: Array<keyof PlaybookStepSummary> = [
  "name",
  "role",
  "proofStep",
  "validator",
  "contextScope",
]

export function diffSteps(
  current: PlaybookStepSummary[],
  template: PlaybookStepSummary[]
): PlaybookStepChange[] {
  const byKey = new Map(current.map((step) => [step.key, step]))
  const changes: PlaybookStepChange[] = template.map((step) => {
    const from = byKey.get(step.key)
    if (!from) return { change: "added", step }
    const fields = COMPARED.filter((field) => from[field] !== step[field])
    return fields.length
      ? { change: "changed", step, from, fields }
      : { change: "unchanged", step }
  })
  const templateKeys = new Set(template.map((step) => step.key))
  for (const step of current)
    if (!templateKeys.has(step.key)) changes.push({ change: "removed", step })
  return changes
}

// How a playbook differs from the shipped template for its altitude, hook by
// hook, so the user sees what Reset to default would change.
export function diffPlaybookWithDefault(
  playbookId: string
): PlaybookDefaultDiff {
  const playbook = playbooks.getPlaybook(playbookId)
  if (!playbook) throw new Error(`Playbook not found: ${playbookId}`)
  const template = DEFAULT_PLAYBOOKS[playbook.altitude]
  const hookNames = new Set<PlaybookHookName>([
    ...(Object.keys(template.hooks) as PlaybookHookName[]),
    ...playbook.hooks.map((hook) => hook.hook),
  ])
  const hooks = [...hookNames].map((hook) => {
    const attached = playbook.hooks.find((h) => h.hook === hook)
    return {
      hook,
      steps: diffSteps(
        attached ? currentSteps(attached.processId) : [],
        (template.hooks[hook] ?? []).map(templateSteps)
      ),
    }
  })
  return {
    playbookId,
    name: { current: playbook.name, template: template.name },
    hooks,
    differs:
      playbook.name !== template.name ||
      hooks.some((h) => h.steps.some((step) => step.change !== "unchanged")),
  }
}

// Replace a playbook's steps with the shipped template's, in place: the same
// playbook id, so the features, milestones, and user stories pinned to it keep
// it. Each hook gets a fresh step group; the old one is deleted when no other
// playbook uses it and no run history references it.
export function resetPlaybookToDefault(playbookId: string): PlaybookWithHooks {
  const playbook = playbooks.getPlaybook(playbookId)
  if (!playbook) throw new Error(`Playbook not found: ${playbookId}`)
  const template = DEFAULT_PLAYBOOKS[playbook.altitude]
  const replaced = getDb().transaction(() => {
    playbooks.updatePlaybook(playbook.id, {
      name: template.name,
      description: template.description,
    })
    const renamed = playbooks.getPlaybook(playbook.id)!
    for (const hook of playbook.hooks)
      if (!(hook.hook in template.hooks))
        playbooks.removeHook(playbook.id, hook.hook)
    for (const [hook, steps] of Object.entries(template.hooks) as Array<
      [PlaybookHookName, DefaultStep[]]
    >)
      playbooks.setHook(
        playbook.id,
        hook,
        buildHookProcess(renamed, hook, steps)
      )
    return playbook.hooks.filter((hook) => hook.ownsProcess)
  })()
  for (const hook of replaced) {
    if (playbooks.listPlaybookProcessIds().includes(hook.processId)) continue
    try {
      processes.deleteProcessDefinition(hook.processId)
    } catch {
      // Run history still references its phases: keep it as an ordinary
      // Process rather than lose that history.
    }
  }
  return playbooks.getPlaybook(playbook.id)!
}
