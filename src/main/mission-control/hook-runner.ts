import * as features from "../db/repositories/features"
import { PLAYBOOK_HOOKS } from "../db/repositories/playbooks"
import type { PlaybookHookName, PlaybookRun } from "../db/types"
import {
  assertFeatureRunnable,
  playbookFor,
  type UserStoryRunner,
} from "./user-story-runner"
import {
  renderConflictObjective,
  renderHookObjective,
  renderIntentChain,
} from "./user-story-objective"
import type { ResolutionLaunchInput } from "./integration"

// Milestone and feature hooks (plan 106.3, decision 4). Each hook is its own
// small Process run whose objective is composed from its container. They are
// manually triggered here; 106.6 automates them.

export async function startHookRun(
  runner: UserStoryRunner,
  input: {
    featureId: string
    milestoneId?: string | null
    hook: PlaybookHookName
  }
): Promise<PlaybookRun> {
  const feature = features.getFeature(input.featureId)
  if (!feature) throw new Error(`Feature not found: ${input.featureId}`)
  assertFeatureRunnable(feature)
  const milestones = features.listMilestones(feature.id)
  const userStories = milestones.flatMap((m) => features.listUserStories(m.id))

  if (input.hook === "after_each_user_story")
    throw new Error(
      "The after each user story hook runs by itself when a user story's merge conflicts; it can't be started by hand."
    )
  const milestoneHook = PLAYBOOK_HOOKS.milestone.includes(input.hook)
  if (!milestoneHook && !PLAYBOOK_HOOKS.feature.includes(input.hook))
    throw new Error(`'${input.hook}' is not a milestone or feature hook.`)
  const milestone = input.milestoneId
    ? (milestones.find((m) => m.id === input.milestoneId) ?? null)
    : null
  if (input.milestoneId && !milestone)
    throw new Error(`Milestone not found in this feature: ${input.milestoneId}`)
  if (milestoneHook && !milestone)
    throw new Error(`The ${input.hook.replace(/_/g, " ")} hook runs on a milestone.`)
  if (input.hook === "between_milestones" && !milestone)
    throw new Error("Choose the finished milestone to run the between-milestones hook on.")

  const playbook = milestoneHook
    ? playbookFor("milestone", milestone!.playbookId)
    : playbookFor("feature", feature.playbookId)
  const nextMilestone =
    input.hook === "between_milestones" && milestone
      ? (milestones.find((m) => m.position > milestone.position) ?? null)
      : null
  const label = input.hook.replace(/_/g, " ")

  return runner.launch({
    feature,
    milestoneId: milestone?.id ?? null,
    userStory: null,
    playbook,
    hook: input.hook,
    podKey: feature.defaultPodKey,
    objective: renderHookObjective({
      hook: input.hook,
      feature,
      milestones,
      userStories,
      milestone: milestoneHook ? milestone : null,
      nextMilestone,
    }),
    intentChain: renderIntentChain({ feature, milestone }),
    title: milestone
      ? `Milestone ${milestone.key}: ${label}`
      : `Feature ${feature.key}: ${label}`,
  })
}

// A user story's merge conflicted (plan 106.5, decision 6): run the milestone
// playbook's after_each_user_story hook in the prepared resolution worktree. The
// integrator role falls back to the lead; the hook's proof step re-verifies
// the user story's own acceptance criteria before anything is committed. Throws
// when there is nothing to run, and the integration service escalates.
export async function startConflictResolution(
  runner: UserStoryRunner,
  input: ResolutionLaunchInput
): Promise<PlaybookRun> {
  const { feature, milestone, userStory } = input
  if (feature.status !== "active")
    throw new Error("The feature isn't active, so no seat can resolve the conflict.")
  const playbook = playbookFor("milestone", milestone.playbookId)
  if (!playbook.hooks.some((hook) => hook.hook === "after_each_user_story"))
    throw new Error(
      `The "${playbook.name}" milestone playbook has no after each user story hook to resolve conflicts. Add one in Playbooks, or resolve the conflict yourself.`
    )
  return runner.launch({
    feature,
    milestoneId: milestone.id,
    userStory,
    playbook,
    hook: "after_each_user_story",
    podKey: userStory.podKey ?? feature.defaultPodKey,
    objective: renderConflictObjective({
      feature,
      milestone,
      userStory,
      integrationBranch: milestone.integrationBranch ?? "",
      userStoryBranch: userStory.branch ?? "",
      files: input.files,
    }),
    intentChain: renderIntentChain({ feature, milestone, userStory }),
    title: `User story ${userStory.key}: resolve merge conflict`,
    roleFallbacks: { integrator: "lead" },
    isolated: {
      workspacePath: input.workspacePath,
      worktreePath: input.worktreePath,
    },
    onLaunch: (run) => input.onLaunch(run),
  })
}
