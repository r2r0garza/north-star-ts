import type {
  AppLaunch,
  Feature,
  GeneratedFilesRule,
  Milestone,
  UserStory,
} from "../db/types"
import { renderEnvironment, type WorktreeEnvironment } from "./worktree-env"
import { formatStory } from "../../shared/mission-control/story"
import { renderIntentChain } from "./intent-chain"
import { renderIntentRequirements } from "./intent-requirements"

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

// How the app starts, for planning and reviews. A provisional recipe was
// planned from the intent before the app existed: the work must make the app
// start exactly this way.
function renderAppLaunch(recipe: AppLaunch | null): string[] {
  if (!recipe?.services.length) return []
  const provisional = recipe.services.some((s) => s.provisional)
  return [
    "",
    "## How the app starts",
    provisional
      ? "Mission Control will start the app this way (planned from the intent; nothing is built yet). The first user story must build the app so it starts with exactly this recipe, taking its port as shown; its builder can change the recipe with `app_launch_save` only if the stack truly needs it."
      : "Mission Control starts the app this way for builders, QA, and the acceptance gates.",
    ...recipe.services.map(
      (s) =>
        `- ${s.label}: \`${s.command}\`${s.cwd ? ` in \`${s.cwd}\`` : ""}, port ${
          s.port === "auto"
            ? `from ${s.command.includes("{port") ? "the {port} placeholder" : `$${s.portEnv ?? "PORT"}`}`
            : s.port
        }, ready when ${"http" in s.ready ? `GET ${s.ready.http} answers` : `output matches /${s.ready.log}/`}${s.dependsOn?.length ? `, after ${s.dependsOn.join(", ")}` : ""}`
    ),
  ]
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
  // The workspace's app launch recipe: planning builds to it.
  appLaunch?: AppLaunch | null
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
    ...renderIntentRequirements(feature),
    ...renderAppLaunch(input.appLaunch ?? null),
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
        "If nothing in the workspace runs yet (a new project), make the first user story a walking skeleton: the smallest version of the app that starts the way “How the app starts” above says (or, with no recipe there, with one command that takes its port from the environment), and have every user story that needs the running app list it in `depends_on`. Give it a criterion that Mission Control can start the app from the workspace's app launch recipe. Mission Control builds that first story alone, so QA can test the others against a running app. " +
        "Before you submit, check coverage: go through every requirement from the intent, every item of the feature's definition of done, and each milestone's outcome and definition of done, and make sure some user story's acceptance criteria deliver and verify it. Carry the intent's specifics (exact labels, texts, and behaviours) into the criteria rather than summarizing them away. " +
        "When the intent lists requirements, pass `coverage` mapping each one (R1, R2, ...) to the story and criterion numbers that cover it; a plan that leaves one out, or exceeds the intent's plan limits, is refused. To stay inside a story limit, give a story more acceptance criteria rather than adding stories. " +
        "The user reviews and applies the proposal. Without the tool, write the plan in your final message."
    )
  else
    lines.push(
      "Check the plan against the requirements from the intent above: a requirement no acceptance criterion delivers and verifies is a gap to fix, ideally by adding criteria to a not-started story (`edit_user_story`) rather than a new story when the intent limits the story count. " +
        "If you have map tools, submit each recommended change with `propose_user_story` or `revise_plan` rather than only describing it; otherwise list them in your final message. " +
        "When you add a user story, set `depends_on` for what it needs and `blocks` for not-started stories that need it: stories already planned in later waves don't wait for a new story otherwise."
    )
  return lines.join("\n")
}

// The objective for the milestone's after_each_user_story hook when a user story's merge
// conflicts (plan 106.5, decision 6). The worktree already holds the merge in
// progress; the integrator resolves it and the proof step smoke-tests the
// merged result (plan 110.05) before anything commits.
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
    "- QA then smoke-tests the merged result: the app starts, the project's tests pass, and this user story's criteria still hold in the running app. The milestone's acceptance gate proves them fully once the wave merges.",
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

// The objective for a milestone's wave acceptance gate (plan 110.02): the
// batch of merged user stories, proven together on the integration head. The
// QA step's kickoff adds how the suite is written, run, and recorded.
export function renderGateObjective(input: {
  feature: Feature
  milestone: Milestone
  batch: UserStory[]
  round: number
  // Where the gate runs: a worktree at the integration head.
  workspace?: {
    integrationBranch: string
    environment?: WorktreeEnvironment | null
  } | null
}): string {
  const { feature, milestone } = input
  return [
    `<!-- mission-control gate objective v${USER_STORY_OBJECTIVE_VERSION} -->`,
    `# Acceptance gate, round ${input.round} — milestone ${milestone.key}`,
    "",
    `These user stories merged into the milestone's integration branch since its last acceptance gate. Prove every one of their acceptance criteria on the integrated product, together, before any user story that depends on them starts.`,
    "",
    "## The batch",
    ...input.batch.flatMap((story) => {
      const criteria = userStoryCriteria(story)
      return [
        "",
        `### ${story.key}: ${story.title}`,
        story.spec.goal.trim() || story.title,
        criteria.length
          ? criteria.map((c) => `- **${c.id}**: ${c.text}`).join("\n")
          : "(no acceptance criteria)",
      ]
    }),
    ...(input.workspace
      ? [
          "",
          "## Your workspace",
          `You are working in a git worktree at the head of the integration branch \`${input.workspace.integrationBranch}\` (detached). ` +
            "Do not commit, switch branches, merge, rebase, or push: when the gate ends, Mission Control commits the checks directory to the integration branch, and nothing else.",
          ...renderEnvironment(input.workspace.environment),
        ]
      : []),
    "",
    "## Why this milestone exists",
    renderIntentChain({ feature, milestone }),
  ].join("\n")
}
