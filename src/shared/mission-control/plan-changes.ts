// Structural plan changes (plan 106.6). The lead seat applies bounded changes
// to the active milestone through `revise_plan`; everything else — including
// every change outside a seat's rights or scope — travels as a proposal the
// user applies or rejects. Both paths share this one vocabulary, so what a
// proposal shows is exactly what applying it does.
//
// User stories and milestones are referenced by key, never by id: keys are what seats
// see in map_status and Comms anchors.

import { normalizeStory, type UserStoryNarrative } from "./story"

export interface UserStoryDraft {
  key?: string
  title: string
  story?: UserStoryNarrative | null
  goal?: string
  acceptance?: string[]
  outOfScope?: string[]
  touchHints?: string[]
  notes?: string
  pod?: string | null
  // Keys of user stories in the same milestone this one waits for.
  dependsOn?: string[]
  // Keys of existing, not-started user stories that must wait for this one
  // (add_user_story only: in a new milestone, `dependsOn` says it all).
  blocks?: string[]
  // Run after every other user story in the milestone, including later ones.
  runsLast?: boolean
}

export interface UserStoryEdit {
  title?: string
  story?: UserStoryNarrative | null
  goal?: string
  acceptance?: string[]
  outOfScope?: string[]
  touchHints?: string[]
  notes?: string
  pod?: string | null
  runsLast?: boolean
}

export interface MilestoneDraft {
  key?: string
  name: string
  outcome: string
  definitionOfDone?: string
  userStories?: UserStoryDraft[]
}

export type PlanChange =
  // `milestone` defaults to the change set's milestone (the active one).
  | { op: "add_user_story"; milestone?: string; userStory: UserStoryDraft }
  // Cancel a not-started user story and add N in its place: the new user stories inherit
  // its dependencies, and its dependents wait for all of them.
  | { op: "split_user_story"; userStory: string; into: UserStoryDraft[] }
  | { op: "add_dependency"; from: string; to: string }
  | { op: "remove_dependency"; from: string; to: string }
  // User story keys in their new order; unlisted user stories keep their relative order
  // after the listed ones.
  | { op: "reorder"; order: string[] }
  // Only a user story that has not started.
  | { op: "edit_user_story"; userStory: string; patch: UserStoryEdit }
  // Always proposals: seats never edit these directly.
  | { op: "add_milestone"; milestone: MilestoneDraft }
  | {
      op: "edit_milestone"
      milestone: string
      patch: { name?: string; outcome?: string; definitionOfDone?: string }
    }
  | {
      op: "edit_feature"
      patch: { intent?: string; definitionOfDone?: string }
    }

export type PlanChangeOp = PlanChange["op"]

// What `revise_plan` may apply inside the active milestone. Every other op (and
// any change naming another milestone) becomes a proposal, whatever the rights.
export const SEAT_APPLICABLE_OPS: ReadonlySet<PlanChangeOp> = new Set([
  "add_user_story",
  "split_user_story",
  "add_dependency",
  "remove_dependency",
  "reorder",
  "edit_user_story",
])

export const PLAN_CHANGE_OPS: readonly PlanChangeOp[] = [
  "add_user_story",
  "split_user_story",
  "add_dependency",
  "remove_dependency",
  "reorder",
  "edit_user_story",
  "add_milestone",
  "edit_milestone",
  "edit_feature",
]

export type ProposalKind = "user_story" | "plan" | "revise_plan"
export type ProposalStatus = "pending" | "applied" | "rejected"

// One line per change, for proposal diffs, revision reasons, and tool results.
export function describePlanChange(change: PlanChange): string {
  const deps = (draft: UserStoryDraft) =>
    [
      draft.dependsOn?.length ? ` (after ${draft.dependsOn.join(", ")})` : "",
      draft.blocks?.length ? ` (before ${draft.blocks.join(", ")})` : "",
      draft.runsLast ? " (runs last)" : "",
    ].join("")
  switch (change.op) {
    case "add_user_story":
      return `+ user story ${change.userStory.key ?? change.userStory.title}${change.milestone ? ` in ${change.milestone}` : ""}: ${change.userStory.title}${deps(change.userStory)}`
    case "split_user_story":
      return `± split ${change.userStory} into ${change.into.map((d) => d.key ?? d.title).join(", ")}`
    case "add_dependency":
      return `+ ${change.to} waits for ${change.from}`
    case "remove_dependency":
      return `− ${change.to} no longer waits for ${change.from}`
    case "reorder":
      return `↕ order: ${change.order.join(", ")}`
    case "edit_user_story":
      return `~ user story ${change.userStory}: ${Object.keys(change.patch).join(", ") || "no fields"}`
    case "add_milestone":
      return `+ milestone ${change.milestone.key ?? change.milestone.name}: ${change.milestone.name} (${change.milestone.userStories?.length ?? 0} user stories)`
    case "edit_milestone":
      return `~ milestone ${change.milestone}: ${Object.keys(change.patch).join(", ") || "no fields"}`
    case "edit_feature":
      return `~ feature: ${Object.keys(change.patch).join(", ") || "no fields"}`
  }
}

// ── parsing model-supplied changes ──────────────────────────────────────────

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function strings(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return undefined
  return value
    .filter((v): v is string => typeof v === "string" && !!v.trim())
    .map((v) => v.trim())
}

export function parseUserStoryDraft(value: unknown): UserStoryDraft | string {
  if (!value || typeof value !== "object")
    return "A user story must be an object."
  const v = value as Record<string, unknown>
  const title = str(v.title)
  if (!title) return "Every user story needs a `title`."
  return {
    ...(str(v.key) ? { key: str(v.key) } : {}),
    title,
    ...(normalizeStory(v.story) ? { story: normalizeStory(v.story) } : {}),
    ...(typeof v.goal === "string" ? { goal: v.goal } : {}),
    ...(strings(v.acceptance) ? { acceptance: strings(v.acceptance) } : {}),
    ...(strings(v.out_of_scope ?? v.outOfScope)
      ? { outOfScope: strings(v.out_of_scope ?? v.outOfScope) }
      : {}),
    ...(strings(v.touch_hints ?? v.touchHints)
      ? { touchHints: strings(v.touch_hints ?? v.touchHints) }
      : {}),
    ...(typeof v.notes === "string" ? { notes: v.notes } : {}),
    ...(str(v.pod) ? { pod: str(v.pod) } : {}),
    ...(strings(v.depends_on ?? v.dependsOn)
      ? { dependsOn: strings(v.depends_on ?? v.dependsOn) }
      : {}),
    ...(strings(v.blocks)?.length ? { blocks: strings(v.blocks) } : {}),
    ...((v.runs_last ?? v.runsLast) === true ? { runsLast: true } : {}),
  }
}

function parseUserStoryEdit(value: unknown): UserStoryEdit | string {
  if (!value || typeof value !== "object") return "`patch` must be an object."
  const v = value as Record<string, unknown>
  const patch: UserStoryEdit = {}
  if (str(v.title)) patch.title = str(v.title)
  if (v.story !== undefined) patch.story = normalizeStory(v.story)
  if (typeof v.goal === "string") patch.goal = v.goal
  if (strings(v.acceptance)) patch.acceptance = strings(v.acceptance)
  if (strings(v.out_of_scope ?? v.outOfScope))
    patch.outOfScope = strings(v.out_of_scope ?? v.outOfScope)
  if (strings(v.touch_hints ?? v.touchHints))
    patch.touchHints = strings(v.touch_hints ?? v.touchHints)
  if (typeof v.notes === "string") patch.notes = v.notes
  if (v.pod === null || str(v.pod)) patch.pod = str(v.pod) ?? null
  const runsLast = v.runs_last ?? v.runsLast
  if (typeof runsLast === "boolean") patch.runsLast = runsLast
  if (!Object.keys(patch).length) return "`patch` changes nothing."
  return patch
}

export function parseMilestoneDraft(value: unknown): MilestoneDraft | string {
  if (!value || typeof value !== "object")
    return "A milestone must be an object."
  const v = value as Record<string, unknown>
  const name = str(v.name)
  if (!name) return "Every milestone needs a `name`."
  const userStories: UserStoryDraft[] = []
  const drafts = v.user_stories ?? v.userStories
  if (drafts !== undefined) {
    if (!Array.isArray(drafts))
      return "A milestone's `user_stories` must be a list."
    for (const item of drafts) {
      const draft = parseUserStoryDraft(item)
      if (typeof draft === "string") return `Milestone ${name}: ${draft}`
      userStories.push(draft)
    }
  }
  return {
    ...(str(v.key) ? { key: str(v.key) } : {}),
    name,
    outcome: typeof v.outcome === "string" ? v.outcome : "",
    ...(typeof (v.definition_of_done ?? v.definitionOfDone) === "string"
      ? {
          definitionOfDone: (v.definition_of_done ??
            v.definitionOfDone) as string,
        }
      : {}),
    userStories,
  }
}

// Validate one change's shape (not its effect on the plan).
export function parsePlanChange(value: unknown): PlanChange | string {
  if (!value || typeof value !== "object")
    return "Each change must be an object."
  const v = value as Record<string, unknown>
  const op = v.op
  switch (op) {
    case "add_user_story": {
      const userStory = parseUserStoryDraft(v.user_story ?? v.userStory)
      if (typeof userStory === "string") return userStory
      return {
        op,
        ...(str(v.milestone) ? { milestone: str(v.milestone) } : {}),
        userStory,
      }
    }
    case "split_user_story": {
      const userStory = str(v.user_story ?? v.userStory)
      if (!userStory)
        return "split_user_story needs the `user_story` key to split."
      if (!Array.isArray(v.into) || v.into.length < 2)
        return "split_user_story needs `into`: at least two user stories."
      const into: UserStoryDraft[] = []
      for (const item of v.into) {
        const draft = parseUserStoryDraft(item)
        if (typeof draft === "string") return draft
        into.push(draft)
      }
      return { op, userStory, into }
    }
    case "add_dependency":
    case "remove_dependency": {
      const from = str(v.from)
      const to = str(v.to)
      if (!from || !to)
        return `${op} needs \`from\` and \`to\` user story keys.`
      return { op, from, to }
    }
    case "reorder": {
      const order = strings(v.order)
      if (!order?.length)
        return "reorder needs `order`: user story keys in their new order."
      return { op, order }
    }
    case "edit_user_story": {
      const userStory = str(v.user_story ?? v.userStory)
      if (!userStory) return "edit_user_story needs the `user_story` key."
      const patch = parseUserStoryEdit(v.patch)
      if (typeof patch === "string") return patch
      return { op, userStory, patch }
    }
    case "add_milestone": {
      const milestone = parseMilestoneDraft(v.milestone)
      if (typeof milestone === "string") return milestone
      return { op, milestone }
    }
    case "edit_milestone": {
      const milestone = str(v.milestone)
      const p = (v.patch ?? {}) as Record<string, unknown>
      if (!milestone) return "edit_milestone needs the `milestone` key."
      const patch: {
        name?: string
        outcome?: string
        definitionOfDone?: string
      } = {}
      if (str(p.name)) patch.name = str(p.name)
      if (typeof p.outcome === "string") patch.outcome = p.outcome
      const dod = p.definition_of_done ?? p.definitionOfDone
      if (typeof dod === "string") patch.definitionOfDone = dod
      if (!Object.keys(patch).length) return "`patch` changes nothing."
      return { op, milestone, patch }
    }
    case "edit_feature": {
      const p = (v.patch ?? {}) as Record<string, unknown>
      const patch: { intent?: string; definitionOfDone?: string } = {}
      if (typeof p.intent === "string") patch.intent = p.intent
      const dod = p.definition_of_done ?? p.definitionOfDone
      if (typeof dod === "string") patch.definitionOfDone = dod
      if (!Object.keys(patch).length) return "`patch` changes nothing."
      return { op, patch }
    }
    default:
      return `Unknown op "${String(op)}". Use one of: ${PLAN_CHANGE_OPS.join(", ")}.`
  }
}
