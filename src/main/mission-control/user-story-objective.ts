import type {
  Feature,
  GeneratedFilesRule,
  Milestone,
  UserStory,
} from "../db/types"
import { renderEnvironment, type WorktreeEnvironment } from "./worktree-env"
import { formatStory } from "../../shared/mission-control/story"
import { renderIntentChain } from "./intent-chain"

// The user story objective IS the spec (plan 106.3, decision 5): a rendered,
// versioned block rather than a paraphrase. Acceptance criteria get stable ids
// (AC-1, AC-2, ...) derived from their order, which record_proof validates
// against. The id scheme is part of the versioned format. v2 adds the optional
// Story section.
export const USER_STORY_OBJECTIVE_VERSION = 2

export interface UserStoryCriterion {
  id: string
  text: string
}

export function userStoryCriteria(userStory: UserStory): UserStoryCriterion[] {
  return userStory.spec.acceptance.map((text, index) => ({
    id: `AC-${index + 1}`,
    text,
  }))
}

function list(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "(none)"
}

// The Refocus intent chain moved to intent-chain.ts (plan 106.7).
export { renderIntentChain } from "./intent-chain"

// Where an isolated user story builds (plan 106.5): its own worktree and branch.
export interface UserStoryWorkspaceNote {
  branch: string
  integrationBranch: string
  environment?: WorktreeEnvironment | null
}

function renderWorkspaceNote(note: UserStoryWorkspaceNote): string[] {
  return [
    "",
    "## Your workspace",
    `You are working in an isolated git worktree on branch \`${note.branch}\`, created from the milestone's integration branch \`${note.integrationBranch}\`. ` +
      "Other user stories build in their own worktrees at the same time, so stay inside this user story's scope. " +
      "Committing is optional: when the proof is accepted, Mission Control commits anything left uncommitted and merges this branch through the milestone's merge queue. " +
      "Do not switch branches, rebase, merge other branches, or push.",
    ...renderEnvironment(note.environment),
  ]
}

export function renderUserStoryObjective(input: {
  feature: Feature
  milestone: Milestone
  userStory: UserStory
  workspace?: UserStoryWorkspaceNote | null
  // Why this attempt was started, from the seat that retried it (106.6).
  attemptNote?: { attempt: number; by: string; text: string } | null
}): string {
  const { feature, milestone, userStory } = input
  const criteria = userStoryCriteria(userStory)
  return [
    `<!-- mission-control user story objective v${USER_STORY_OBJECTIVE_VERSION} -->`,
    `# User story ${userStory.key}: ${userStory.title}`,
    ...(userStory.spec.story
      ? ["", "## Story", formatStory(userStory.spec.story)]
      : []),
    "",
    "## Goal",
    userStory.spec.goal.trim() || userStory.title,
    "",
    "## Acceptance criteria",
    criteria.length
      ? criteria.map((c) => `- **${c.id}**: ${c.text}`).join("\n")
      : "(none — the user story cannot be proven until criteria are added)",
    "",
    "## Out of scope",
    list(userStory.spec.outOfScope),
    "",
    "## Touch hints",
    list(userStory.spec.touchHints),
    ...(userStory.spec.notes.trim()
      ? ["", "## Notes", userStory.spec.notes.trim()]
      : []),
    ...(input.attemptNote
      ? [
          "",
          `## Note for attempt ${input.attemptNote.attempt} (from ${input.attemptNote.by})`,
          input.attemptNote.text.trim(),
        ]
      : []),
    ...(input.workspace ? renderWorkspaceNote(input.workspace) : []),
    "",
    "## Why this user story exists",
    renderIntentChain({ feature, milestone, userStory }),
  ].join("\n")
}

// The objective for a milestone/feature hook run (decision 4): composed from
// the container so each hook sees exactly what it is deciding about.
export function renderHookObjective(input: {
  hook: string
  feature: Feature
  milestones: Milestone[]
  userStories: UserStory[]
  milestone?: Milestone | null
  nextMilestone?: Milestone | null
  // Pending follow-ups for the milestone review, rendered (plan 106.7).
  followups?: string | null
}): string {
  const { hook, feature, milestones, userStories, milestone, nextMilestone } =
    input
  const userStoryLines = (milestoneId: string) =>
    userStories
      .filter((s) => s.milestoneId === milestoneId)
      .map((s) => {
        const proof = s.proof as { verdict?: string } | null
        return `- ${s.key} (${s.status}${proof?.verdict ? `, proof ${proof.verdict}` : ""}): ${s.title}${
          s.spec.acceptance.length
            ? `\n  Criteria: ${s.spec.acceptance.join("; ")}`
            : ""
        }`
      })
      .join("\n") || "(no user stories)"
  const lines = [
    `# ${hook.replace(/_/g, " ")} — ${milestone ? `milestone ${milestone.key}` : `feature ${feature.key}`}`,
    "",
    "## Why this work exists",
    renderIntentChain({ feature, milestone }),
  ]
  if (milestone) {
    lines.push(
      "",
      `## User stories in milestone ${milestone.key}`,
      userStoryLines(milestone.id)
    )
  } else {
    lines.push("", "## Milestones")
    for (const m of milestones)
      lines.push(
        `### ${m.key} (${m.status}): ${m.name}`,
        m.outcome.trim() || "(no outcome stated)",
        userStoryLines(m.id)
      )
  }
  if (input.followups) lines.push("", input.followups)
  if (nextMilestone)
    lines.push(
      "",
      `## Next milestone: ${nextMilestone.key}`,
      nextMilestone.outcome.trim() || "(no outcome stated)"
    )
  lines.push(
    "",
    "## Your output",
    "Your final message is the deliverable: Mission Control keeps it as this hook's result for the user to read later. " +
      "Put the complete write-up there. Do not write it to files, and do not ask whether to save or expand it — nobody can answer during the run. " +
      "Do not edit the feature's plan or the workspace yourself."
  )
  // Plan changes travel as structured proposals the user applies (106.6);
  // seats without map tools fall back to describing them in the message.
  if (hook === "plan")
    lines.push(
      "",
      "## Submit the plan",
      "If you have the `propose_plan` tool, submit the whole plan with ONE call: every milestone in order, each with its outcome, definition of done, and user stories. " +
        "Give every user story a short key, a goal, concrete acceptance criteria (each one checkable), touch hints for the files it will change, and `depends_on` keys for user stories it must wait for. " +
        "Keep user stories small enough to build and prove in one sitting, and keep independent user stories independent so they run in parallel. " +
        "Mark a user story that must come after all the others (an integration proof, docs) `runs_last` instead of listing every other story in its `depends_on`. " +
        "Before you submit, check coverage: go through every item of the feature's definition of done and each milestone's outcome and definition of done, and make sure some user story's acceptance criteria deliver and verify it. Add a user story for anything uncovered; the milestone's planning review otherwise finds it after you. " +
        "The user reviews and applies the proposal. Without the tool, write the plan in your final message."
    )
  else
    lines.push(
      "If you have map tools, submit each recommended change with `propose_user_story` or `revise_plan` rather than only describing it; otherwise list them in your final message. " +
        "When you add a user story, set `depends_on` for what it needs and `blocks` for not-started stories that need it: stories already planned in later waves don't wait for a new story otherwise."
    )
  return lines.join("\n")
}

// The objective for the milestone's after_each_user_story hook when a user story's merge
// conflicts (plan 106.5, decision 6). The worktree already holds the merge in
// progress; the integrator resolves it and the proof step re-verifies the
// user story against its original acceptance criteria before anything commits.
export function renderConflictObjective(input: {
  feature: Feature
  milestone: Milestone
  userStory: UserStory
  integrationBranch: string
  userStoryBranch: string
  files: string[]
  // The workspace's generated files: rebuilt by their command, never merged.
  generatedFiles?: GeneratedFilesRule[]
  environment?: WorktreeEnvironment | null
}): string {
  const { feature, milestone, userStory } = input
  const criteria = userStoryCriteria(userStory)
  const generated = input.generatedFiles ?? []
  return [
    `<!-- mission-control conflict objective v${USER_STORY_OBJECTIVE_VERSION} -->`,
    `# Resolve the merge of user story ${userStory.key}: ${userStory.title}`,
    "",
    `Merging \`${input.userStoryBranch}\` into the milestone's integration branch \`${input.integrationBranch}\` conflicted. ` +
      "This worktree is at the integration head with that merge in progress and the conflict markers in place.",
    "",
    "## Conflicted files",
    list(input.files),
    "",
    "## What to do",
    "- Resolve every conflict so both sides keep their intent: the work already on the integration branch (other user stories) and this user story's goal.",
    "- Remove every conflict marker. Run the project's checks if it has them.",
    "- Do not commit, abort the merge, switch branches, rebase, or push. Mission Control commits the merge after the proof is accepted.",
    "- The proof step then re-verifies this user story against its acceptance criteria on the merged result.",
    ...renderEnvironment(input.environment),
    ...(generated.length
      ? [
          "",
          "## Generated files",
          "This workspace generates these files; don't merge them by hand. Resolve the other conflicts first, then take either side of these (`git checkout --ours -- <file>`) and rebuild them by running the command from the workspace root:",
          ...generated.map(
            (rule) =>
              `- ${rule.paths.map((p) => `\`${p}\``).join(", ")}: \`${rule.command}\``
          ),
        ]
      : []),
    "",
    "## User story goal",
    userStory.spec.goal.trim() || userStory.title,
    "",
    "## Acceptance criteria",
    criteria.length
      ? criteria.map((c) => `- **${c.id}**: ${c.text}`).join("\n")
      : "(none)",
    "",
    "## Out of scope",
    list(userStory.spec.outOfScope),
    "",
    "## Why this user story exists",
    renderIntentChain({ feature, milestone, userStory }),
  ].join("\n")
}
