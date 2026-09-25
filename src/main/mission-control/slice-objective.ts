import type { Initiative, Mission, WorkSlice } from "../db/types"

// The slice objective IS the spec (plan 106.3, decision 5): a rendered,
// versioned block rather than a paraphrase. Acceptance criteria get stable ids
// (AC-1, AC-2, ...) derived from their order, which record_proof validates
// against. The id scheme is part of the versioned format.
export const SLICE_OBJECTIVE_VERSION = 1

export interface SliceCriterion {
  id: string
  text: string
}

export function sliceCriteria(slice: WorkSlice): SliceCriterion[] {
  return slice.spec.acceptance.map((text, index) => ({
    id: `AC-${index + 1}`,
    text,
  }))
}

function list(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "(none)"
}

// The static Refocus intent chain (dynamic reminders arrive in 106.7): why this
// work exists, from the initiative down to the unit being executed.
export function renderIntentChain(input: {
  initiative: Initiative
  mission?: Mission | null
  slice?: WorkSlice | null
}): string {
  const { initiative, mission, slice } = input
  const lines = [
    `Initiative "${initiative.name}": ${initiative.intent.trim() || "(no intent stated)"}`,
  ]
  if (initiative.definitionOfDone.trim())
    lines.push(`  Done when: ${initiative.definitionOfDone.trim()}`)
  if (mission) {
    lines.push(
      `Mission "${mission.name}": ${mission.outcome.trim() || "(no outcome stated)"}`
    )
    if (mission.definitionOfDone.trim())
      lines.push(`  Done when: ${mission.definitionOfDone.trim()}`)
  }
  if (slice)
    lines.push(`Slice "${slice.title}": ${slice.spec.goal.trim() || slice.title}`)
  return lines.join("\n")
}

// Where an isolated slice builds (plan 106.5): its own worktree and branch.
export interface SliceWorkspaceNote {
  branch: string
  integrationBranch: string
}

function renderWorkspaceNote(note: SliceWorkspaceNote): string[] {
  return [
    "",
    "## Your workspace",
    `You are working in an isolated git worktree on branch \`${note.branch}\`, created from the mission's integration branch \`${note.integrationBranch}\`. ` +
      "Other slices build in their own worktrees at the same time, so stay inside this slice's scope. " +
      "Committing is optional: when the proof is accepted, Mission Control commits anything left uncommitted and merges this branch through the mission's merge queue. " +
      "Do not switch branches, rebase, merge other branches, or push.",
  ]
}

export function renderSliceObjective(input: {
  initiative: Initiative
  mission: Mission
  slice: WorkSlice
  workspace?: SliceWorkspaceNote | null
}): string {
  const { initiative, mission, slice } = input
  const criteria = sliceCriteria(slice)
  return [
    `<!-- mission-control slice objective v${SLICE_OBJECTIVE_VERSION} -->`,
    `# Slice ${slice.key}: ${slice.title}`,
    "",
    "## Goal",
    slice.spec.goal.trim() || slice.title,
    "",
    "## Acceptance criteria",
    criteria.length
      ? criteria.map((c) => `- **${c.id}**: ${c.text}`).join("\n")
      : "(none — the slice cannot be proven until criteria are added)",
    "",
    "## Out of scope",
    list(slice.spec.outOfScope),
    "",
    "## Touch hints",
    list(slice.spec.touchHints),
    ...(slice.spec.notes.trim() ? ["", "## Notes", slice.spec.notes.trim()] : []),
    ...(input.workspace ? renderWorkspaceNote(input.workspace) : []),
    "",
    "## Why this slice exists",
    renderIntentChain({ initiative, mission, slice }),
  ].join("\n")
}

// The objective for a mission/initiative hook run (decision 4): composed from
// the container so each hook sees exactly what it is deciding about.
export function renderHookObjective(input: {
  hook: string
  initiative: Initiative
  missions: Mission[]
  slices: WorkSlice[]
  mission?: Mission | null
  nextMission?: Mission | null
}): string {
  const { hook, initiative, missions, slices, mission, nextMission } = input
  const sliceLines = (missionId: string) =>
    slices
      .filter((s) => s.missionId === missionId)
      .map((s) => {
        const proof = s.proof as { verdict?: string } | null
        return `- ${s.key} (${s.status}${proof?.verdict ? `, proof ${proof.verdict}` : ""}): ${s.title}${
          s.spec.acceptance.length
            ? `\n  Criteria: ${s.spec.acceptance.join("; ")}`
            : ""
        }`
      })
      .join("\n") || "(no slices)"
  const lines = [
    `# ${hook.replace(/_/g, " ")} — ${mission ? `mission ${mission.key}` : `initiative ${initiative.key}`}`,
    "",
    "## Why this work exists",
    renderIntentChain({ initiative, mission }),
  ]
  if (mission) {
    lines.push("", `## Slices in mission ${mission.key}`, sliceLines(mission.id))
  } else {
    lines.push("", "## Missions")
    for (const m of missions)
      lines.push(
        `### ${m.key} (${m.status}): ${m.name}`,
        m.outcome.trim() || "(no outcome stated)",
        sliceLines(m.id)
      )
  }
  if (nextMission)
    lines.push(
      "",
      `## Next mission: ${nextMission.key}`,
      nextMission.outcome.trim() || "(no outcome stated)"
    )
  lines.push(
    "",
    "## Your output",
    "Your final message is the deliverable: Mission Control keeps it as this hook's result for the user to read later. " +
      "Put the complete write-up there. Do not write it to files, and do not ask whether to save or expand it — nobody can answer during the run. " +
      "Recommend plan changes as proposals in that message; do not edit the initiative's plan or the workspace yourself."
  )
  return lines.join("\n")
}

// The objective for the mission's after_each_slice hook when a slice's merge
// conflicts (plan 106.5, decision 6). The worktree already holds the merge in
// progress; the integrator resolves it and the proof step re-verifies the
// slice against its original acceptance criteria before anything commits.
export function renderConflictObjective(input: {
  initiative: Initiative
  mission: Mission
  slice: WorkSlice
  integrationBranch: string
  sliceBranch: string
  files: string[]
}): string {
  const { initiative, mission, slice } = input
  const criteria = sliceCriteria(slice)
  return [
    `<!-- mission-control conflict objective v${SLICE_OBJECTIVE_VERSION} -->`,
    `# Resolve the merge of slice ${slice.key}: ${slice.title}`,
    "",
    `Merging \`${input.sliceBranch}\` into the mission's integration branch \`${input.integrationBranch}\` conflicted. ` +
      "This worktree is at the integration head with that merge in progress and the conflict markers in place.",
    "",
    "## Conflicted files",
    list(input.files),
    "",
    "## What to do",
    "- Resolve every conflict so both sides keep their intent: the work already on the integration branch (other slices) and this slice's goal.",
    "- Remove every conflict marker. Run the project's checks if it has them.",
    "- Do not commit, abort the merge, switch branches, rebase, or push. Mission Control commits the merge after the proof is accepted.",
    "- The proof step then re-verifies this slice against its acceptance criteria on the merged result.",
    "",
    "## Slice goal",
    slice.spec.goal.trim() || slice.title,
    "",
    "## Acceptance criteria",
    criteria.length
      ? criteria.map((c) => `- **${c.id}**: ${c.text}`).join("\n")
      : "(none)",
    "",
    "## Out of scope",
    list(slice.spec.outOfScope),
    "",
    "## Why this slice exists",
    renderIntentChain({ initiative, mission, slice }),
  ].join("\n")
}
