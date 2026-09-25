import * as initiatives from "../db/repositories/initiatives"
import { PLAYBOOK_HOOKS } from "../db/repositories/playbooks"
import type { PlaybookHookName, PlaybookRun } from "../db/types"
import {
  assertInitiativeRunnable,
  playbookFor,
  type SliceRunner,
} from "./slice-runner"
import {
  renderConflictObjective,
  renderHookObjective,
  renderIntentChain,
} from "./slice-objective"
import type { ResolutionLaunchInput } from "./integration"

// Mission and initiative hooks (plan 106.3, decision 4). Each hook is its own
// small Process run whose objective is composed from its container. They are
// manually triggered here; 106.6 automates them.

export async function startHookRun(
  runner: SliceRunner,
  input: {
    initiativeId: string
    missionId?: string | null
    hook: PlaybookHookName
  }
): Promise<PlaybookRun> {
  const initiative = initiatives.getInitiative(input.initiativeId)
  if (!initiative) throw new Error(`Initiative not found: ${input.initiativeId}`)
  assertInitiativeRunnable(initiative)
  const missions = initiatives.listMissions(initiative.id)
  const slices = missions.flatMap((m) => initiatives.listSlices(m.id))

  if (input.hook === "after_each_slice")
    throw new Error(
      "The after each slice hook runs by itself when a slice's merge conflicts; it can't be started by hand."
    )
  const missionHook = PLAYBOOK_HOOKS.mission.includes(input.hook)
  if (!missionHook && !PLAYBOOK_HOOKS.initiative.includes(input.hook))
    throw new Error(`'${input.hook}' is not a mission or initiative hook.`)
  const mission = input.missionId
    ? (missions.find((m) => m.id === input.missionId) ?? null)
    : null
  if (input.missionId && !mission)
    throw new Error(`Mission not found in this initiative: ${input.missionId}`)
  if (missionHook && !mission)
    throw new Error(`The ${input.hook.replace(/_/g, " ")} hook runs on a mission.`)
  if (input.hook === "between_missions" && !mission)
    throw new Error("Choose the finished mission to run the between-missions hook on.")

  const playbook = missionHook
    ? playbookFor("mission", mission!.playbookId)
    : playbookFor("initiative", initiative.playbookId)
  const nextMission =
    input.hook === "between_missions" && mission
      ? (missions.find((m) => m.position > mission.position) ?? null)
      : null
  const label = input.hook.replace(/_/g, " ")

  return runner.launch({
    initiative,
    missionId: mission?.id ?? null,
    slice: null,
    playbook,
    hook: input.hook,
    podKey: initiative.defaultPodKey,
    objective: renderHookObjective({
      hook: input.hook,
      initiative,
      missions,
      slices,
      mission: missionHook ? mission : null,
      nextMission,
    }),
    intentChain: renderIntentChain({ initiative, mission }),
    title: mission
      ? `Mission ${mission.key}: ${label}`
      : `Initiative ${initiative.key}: ${label}`,
  })
}

// A slice's merge conflicted (plan 106.5, decision 6): run the mission
// playbook's after_each_slice hook in the prepared resolution worktree. The
// integrator role falls back to the lead; the hook's proof step re-verifies
// the slice's own acceptance criteria before anything is committed. Throws
// when there is nothing to run, and the integration service escalates.
export async function startConflictResolution(
  runner: SliceRunner,
  input: ResolutionLaunchInput
): Promise<PlaybookRun> {
  const { initiative, mission, slice } = input
  if (initiative.status !== "active")
    throw new Error("The initiative isn't active, so no seat can resolve the conflict.")
  const playbook = playbookFor("mission", mission.playbookId)
  if (!playbook.hooks.some((hook) => hook.hook === "after_each_slice"))
    throw new Error(
      `The "${playbook.name}" mission playbook has no after each slice hook to resolve conflicts. Add one in Playbooks, or resolve the conflict yourself.`
    )
  return runner.launch({
    initiative,
    missionId: mission.id,
    slice,
    playbook,
    hook: "after_each_slice",
    podKey: slice.podKey ?? initiative.defaultPodKey,
    objective: renderConflictObjective({
      initiative,
      mission,
      slice,
      integrationBranch: mission.integrationBranch ?? "",
      sliceBranch: slice.branch ?? "",
      files: input.files,
    }),
    intentChain: renderIntentChain({ initiative, mission, slice }),
    title: `Slice ${slice.key}: resolve merge conflict`,
    roleFallbacks: { integrator: "lead" },
    isolated: {
      workspacePath: input.workspacePath,
      worktreePath: input.worktreePath,
    },
    onLaunch: (run) => input.onLaunch(run),
  })
}
