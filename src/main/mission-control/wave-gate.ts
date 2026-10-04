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
import {
  isWaveGateReport,
  storyPassed,
  summarizeGateReport,
} from "./gate-record"
import { renderGateObjective, renderIntentChain } from "./user-story-objective"
import type { UserStoryRunner } from "./user-story-runner"

// The wave acceptance gate (plan 110). When a milestone's playbook has an
// after_each_wave hook, a user story whose merge lands is `merged`, not
// `done`; only `done` satisfies a dependency, so the gate is a barrier. Once
// the milestone is quiescent (nothing running, proving, or merging) the
// Navigator opens a gate whose batch is exactly the merged stories.
//
// 110.02: the gate runs the hook in a worktree at the integration head. Its
// QA step writes and runs the acceptance suite and records the gate
// (record_gate); when the run settles, the integration service commits the
// suite to the integration branch and concludeWaveGate() finishes the gate:
// batch stories whose criteria all passed become done.

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

// Milestones whose gate is being opened (its worktree prepared): a second
// start fails fast instead of preparing another.
const opening = new Set<string>()

export async function startWaveGate(
  runner: UserStoryRunner,
  input: { feature: Feature; milestone: Milestone }
): Promise<PlaybookRun> {
  const { feature, milestone } = input
  const playbook = milestonePlaybook(milestone)
  if (!hasWaveGate(milestone)) return passWithoutGate(feature, milestone)
  if (opening.has(milestone.id))
    throw new Error(
      `The acceptance gate for ${milestone.key} is already starting.`
    )
  const refusal = waveGateRefusal(milestone)
  if (refusal) throw new Error(refusal)
  const batch = gateBatch(milestone.id)
  const batchKey = (stories: UserStory[]) =>
    stories
      .map((s) => s.id)
      .sort()
      .join(",")
  const round = (waveGates.listWaveGates(milestone.id).at(-1)?.round ?? 0) + 1
  const integration = runner.integration
  opening.add(milestone.id)
  try {
    return await runner.launch({
      feature,
      milestoneId: milestone.id,
      userStory: null,
      playbook,
      hook: "after_each_wave",
      podKey: feature.defaultPodKey,
      objective: (isolated) =>
        renderGateObjective({
          feature,
          milestone,
          batch,
          round,
          workspace: isolated?.integrationBranch
            ? {
                integrationBranch: isolated.integrationBranch,
                environment: isolated.environment ?? null,
              }
            : null,
        }),
      intentChain: renderIntentChain({ feature, milestone }),
      title: `Milestone ${milestone.key}: acceptance gate (round ${round})`,
      isolate: integration
        ? () => integration.prepareGateRun({ feature, milestone })
        : undefined,
      // Under the launch's write lock: still no gate open, and the batch is
      // the one the objective names.
      recheck: () => {
        const again = waveGateRefusal(milestone)
        if (again) throw new Error(again)
        if (batchKey(gateBatch(milestone.id)) !== batchKey(batch))
          throw new Error(
            `The user stories awaiting ${milestone.key}'s acceptance gate changed while it was starting. Start it again.`
          )
      },
      onLaunch: (run) => {
        waveGates.createWaveGate({
          milestoneId: milestone.id,
          storyIds: batch.map((story) => story.id),
          playbookRunId: run.id,
        })
      },
    })
  } finally {
    opening.delete(milestone.id)
  }
}

// A playbook that dropped its gate while stories were merged: open and pass
// the gate at once, so they're done as they would have been without one.
function passWithoutGate(feature: Feature, milestone: Milestone): PlaybookRun {
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
    passThrough(gate, batch)
    return playbooks.getPlaybookRun(run.id)!
  })()
}

function passThrough(gate: WaveGate, batch: UserStory[]): void {
  passWaveGate(gate.id, {
    passThrough: true,
    reason: "The milestone playbook has no gate hook.",
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

// The gate's run completed (plan 110.02): finish the gate from QA's record.
// It passes when every criterion it triaged passed (or had its check
// corrected); either way, batch stories whose criteria all passed become
// done, and the rest stay merged. `suite` is what committing the checks
// directory to the integration branch came to. Idempotent: a gate that
// isn't running is left alone.
export function concludeWaveGate(
  playbookRunId: string,
  suite: { commit: string | null; note?: string }
): WaveGate | null {
  return getDb().transaction(() => {
    const gate = waveGates.getWaveGateByRun(playbookRunId)
    if (!gate || gate.status !== "running") return null
    const recorded = isWaveGateReport(gate.report) ? gate.report : null
    if (!recorded) {
      const reason =
        "The gate step finished without recording a result with record_gate."
      const finished = waveGates.finishWaveGate(gate.id, "failed", {
        report: { reason, ...(suite.note ? { commitNote: suite.note } : {}) },
        checksCommit: suite.commit,
      })
      playbooks.finishPlaybookRun(playbookRunId, "failed", reason)
      return finished
    }
    const byStory = new Map(recorded.stories.map((s) => [s.userStoryId, s]))
    const done: UserStory[] = []
    const held: string[] = []
    for (const id of gate.storyIds) {
      const story = features.getUserStory(id)
      if (!story) continue
      const entry = byStory.get(id)
      // A story without criteria has nothing to triage.
      const passed = entry ? storyPassed(entry) : !story.spec.acceptance.length
      if (passed) done.push(story)
      else held.push(story.key)
    }
    const failedEarlier = recorded.stories
      .filter((s) => !s.batch && !storyPassed(s))
      .map((s) => s.key)
    const passed = !held.length && !failedEarlier.length
    const summary = summarizeGateReport(recorded)
    const reason = passed
      ? null
      : `Acceptance gate round ${gate.round} failed: ${[
          held.length ? `${held.join(", ")} didn't pass` : "",
          failedEarlier.length
            ? `${failedEarlier.join(", ")} (passed earlier) regressed`
            : "",
        ]
          .filter(Boolean)
          .join("; ")}. ${summary}.`
    const finished = waveGates.finishWaveGate(
      gate.id,
      passed ? "passed" : "failed",
      {
        report: {
          ...recorded,
          outcome: passed ? "passed" : "failed",
          ...(reason ? { reason } : {}),
          ...(suite.note ? { commitNote: suite.note } : {}),
        },
        checksCommit: suite.commit,
      }
    )
    if (!finished) return null
    for (const story of done)
      if (story.status === "merged")
        features.setUserStoryExecution(
          story.id,
          { status: "done" },
          `Passed the acceptance gate (round ${gate.round})`
        )
    playbooks.finishPlaybookRun(
      playbookRunId,
      passed ? "completed" : "failed",
      passed
        ? `Acceptance gate round ${gate.round} passed: ${summary}.`
        : reason
    )
    return finished
  })()
}
