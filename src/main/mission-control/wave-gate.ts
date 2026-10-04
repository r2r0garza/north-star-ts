import { getDb } from "../db/connection"
import * as features from "../db/repositories/features"
import * as playbooks from "../db/repositories/playbooks"
import * as waveGates from "../db/repositories/wave-gates"
import type {
  Feature,
  Milestone,
  PlaybookRun,
  PlaybookWithHooks,
  UserStory,
  WaveGate,
} from "../db/types"
import { ensureDefaultPlaybook } from "./playbook-defaults"

// The wave acceptance gate (plan 110). When a milestone's playbook has an
// after_each_wave hook, a user story whose merge lands is `merged`, not
// `done`; only `done` satisfies a dependency, so the gate is a barrier. Once
// the milestone is quiescent (nothing running, proving, or merging) the
// Navigator opens a gate whose batch is exactly the merged stories, and a
// passing gate makes them done.
//
// 110.01 ships the plumbing: the gate step is a pass-through that passes its
// batch without running the hook's steps. 110.02 replaces passThrough() with
// QA writing and running the acceptance suite against the integration head.

const IN_FLIGHT = new Set<UserStory["status"]>([
  "running",
  "proving",
  "integrating",
])

// The milestone's playbook, resolved as the runner does (a pinned milestone
// playbook, else the default). Kept here so the integration service can ask
// without importing the runner.
function milestonePlaybook(milestone: Milestone): PlaybookWithHooks {
  const pinned = milestone.playbookId
    ? playbooks.getPlaybook(milestone.playbookId)
    : null
  return pinned?.altitude === "milestone"
    ? pinned
    : ensureDefaultPlaybook("milestone")
}

export function hasWaveGate(milestone: Milestone): boolean {
  return milestonePlaybook(milestone).hooks.some(
    (hook) => hook.hook === "after_each_wave"
  )
}

// The milestone's user stories awaiting a gate.
export function gateBatch(milestoneId: string): UserStory[] {
  return features
    .listUserStories(milestoneId)
    .filter((story) => story.status === "merged")
}

// Why a gate can't open on the milestone now, or null.
export function waveGateRefusal(milestone: Milestone): string | null {
  const open = waveGates
    .listWaveGates(milestone.id)
    .find((gate) => gate.status === "running")
  if (open)
    return `The acceptance gate for ${milestone.key} (round ${open.round}) is already running.`
  const stories = features.listUserStories(milestone.id)
  if (!stories.some((story) => story.status === "merged"))
    return `No user story in ${milestone.key} is merged and awaiting its acceptance gate.`
  const busy = stories.filter((story) => IN_FLIGHT.has(story.status))
  if (busy.length)
    return `Wait for ${busy.map((s) => `${s.key} (${s.status})`).join(", ")} to finish: the gate runs once nothing in ${milestone.key} is running or merging.`
  return null
}

export function startWaveGate(input: {
  feature: Feature
  milestone: Milestone
}): PlaybookRun {
  const { feature, milestone } = input
  const playbook = milestonePlaybook(milestone)
  return getDb().transaction(() => {
    // Checked under the write lock, so two callers can't open the same gate.
    const refusal = waveGateRefusal(milestone)
    if (refusal) throw new Error(refusal)
    const batch = gateBatch(milestone.id)
    const run = playbooks.createPlaybookRun({
      playbookId: playbook.id,
      hook: "after_each_wave",
      featureId: feature.id,
      milestoneId: milestone.id,
    })
    const gate = waveGates.createWaveGate({
      milestoneId: milestone.id,
      storyIds: batch.map((story) => story.id),
      playbookRunId: run.id,
    })
    passThrough(gate, batch, hasWaveGate(milestone))
    return playbooks.getPlaybookRun(run.id)!
  })()
}

// 110.01: pass the batch without running the hook's steps. A playbook that
// dropped its gate while stories were merged passes them the same way: they
// are done as they would have been without one.
function passThrough(gate: WaveGate, batch: UserStory[], hook: boolean): void {
  passWaveGate(gate.id, {
    passThrough: true,
    ...(hook ? {} : { reason: "The milestone playbook has no gate hook." }),
    stories: batch.map((story) => ({ id: story.id, key: story.key })),
  })
}

// A gate passed: its batch stories become done, the gate and its run finish.
export function passWaveGate(gateId: string, report: unknown): WaveGate | null {
  return getDb().transaction(() => {
    const gate = waveGates.finishWaveGate(gateId, "passed", { report })
    if (!gate) return null
    for (const id of gate.storyIds) {
      const story = features.getUserStory(id)
      if (story?.status === "merged")
        features.setUserStoryExecution(
          story.id,
          { status: "done" },
          `Passed the acceptance gate (round ${gate.round})`
        )
    }
    if (gate.playbookRunId)
      playbooks.finishPlaybookRun(
        gate.playbookRunId,
        "completed",
        `Acceptance gate round ${gate.round} passed: ${gate.storyIds.length} user ${gate.storyIds.length === 1 ? "story" : "stories"} done.`
      )
    return gate
  })()
}

// The gate's run ended without a result (failed, cancelled, or the app
// stopped): the gate failed and its batch stays merged.
export function failWaveGateForRun(
  playbookRunId: string,
  reason: string
): void {
  const gate = waveGates.getWaveGateByRun(playbookRunId)
  if (!gate) return
  waveGates.finishWaveGate(gate.id, "failed", { report: { reason } })
}
