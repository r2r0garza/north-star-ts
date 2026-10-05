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
  hooks: Partial<Record<PlaybookHookName, DefaultStep[]>>
}

export const DEFAULT_PLAYBOOKS: Record<PlaybookAltitude, DefaultPlaybook> = {
  user_story: {
    name: "Spec → Build → Test",
    description:
      "Refine the user story spec against the codebase, build it, then verify every acceptance criterion and record the proof.",
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
          key: "test",
          name: "Test the build against each acceptance criterion and record the proof",
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
      "Before user stories run, the lead reviews the user story set against the milestone outcome. When a user story's merge conflicts, the integrator (or the lead) resolves it and QA re-verifies the user story. After all user stories, the lead writes the milestone summary.",
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
