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
  // share one session per slice run, so a slice's spec, build, and mail stay in
  // one context without piling up across slices; the lead keeps a long-lived
  // session because it holds the plan.
  contextScope: PhaseContextScope
}

interface DefaultPlaybook {
  name: string
  description: string
  hooks: Partial<Record<PlaybookHookName, DefaultStep[]>>
}

export const DEFAULT_PLAYBOOKS: Record<PlaybookAltitude, DefaultPlaybook> = {
  slice: {
    name: "Spec → Build → Test",
    description:
      "Refine the slice spec against the codebase, build it, then verify every acceptance criterion and record the proof.",
    hooks: {
      run: [
        {
          key: "spec",
          name: "Refine the slice spec against the codebase (read and plan; do not edit files)",
          role: "builder",
          contextScope: "slice",
        },
        {
          key: "build",
          name: "Build the slice to its acceptance criteria",
          role: "builder",
          contextScope: "slice",
        },
        {
          key: "test",
          name: "Test the build against each acceptance criterion and record the proof",
          role: "qa",
          validator: true,
          proofStep: true,
          contextScope: "slice",
        },
      ],
    },
  },
  mission: {
    name: "Plan → Review",
    description:
      "Before slices run, the lead reviews the slice set against the mission outcome. After all slices, the lead writes the mission summary.",
    hooks: {
      before_slices: [
        {
          key: "review-plan",
          name: "Review the mission's slices against its outcome and report gaps as proposals (do not edit the plan)",
          role: "lead",
          contextScope: "initiative",
        },
      ],
      after_all_slices: [
        {
          key: "summary",
          name: "Write the mission summary from the slice proofs as your final message",
          role: "lead",
          contextScope: "initiative",
        },
      ],
    },
  },
  initiative: {
    name: "Plan → Release",
    description:
      "The lead drafts missions and slices as a proposal document, and between missions writes release notes and checks the next mission.",
    hooks: {
      plan: [
        {
          key: "plan",
          name: "Draft the initiative's missions and slices as a proposal document (do not edit the plan)",
          role: "lead",
          contextScope: "initiative",
        },
      ],
      between_missions: [
        {
          key: "release",
          name: "Write release notes for the finished mission and check the next mission is still right, as your final message",
          role: "lead",
          contextScope: "initiative",
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
