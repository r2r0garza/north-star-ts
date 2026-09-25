import * as initiatives from "../db/repositories/initiatives"
import { PLAYBOOK_HOOKS } from "../db/repositories/playbooks"
import type { PlaybookHookName, PlaybookRun } from "../db/types"
import {
  assertInitiativeRunnable,
  playbookFor,
  type SliceRunner,
} from "./slice-runner"
import { renderHookObjective, renderIntentChain } from "./slice-objective"

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
