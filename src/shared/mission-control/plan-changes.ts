// Structural plan changes (plan 106.6). The lead seat applies bounded changes
// to the active mission through `revise_plan`; everything else — including
// every change outside a seat's rights or scope — travels as a proposal the
// user applies or rejects. Both paths share this one vocabulary, so what a
// proposal shows is exactly what applying it does.
//
// Slices and missions are referenced by key, never by id: keys are what seats
// see in map_status and Comms anchors.

export interface SliceDraft {
  key?: string
  title: string
  goal?: string
  acceptance?: string[]
  outOfScope?: string[]
  touchHints?: string[]
  notes?: string
  pod?: string | null
  // Keys of slices in the same mission this one waits for.
  dependsOn?: string[]
}

export interface SliceEdit {
  title?: string
  goal?: string
  acceptance?: string[]
  outOfScope?: string[]
  touchHints?: string[]
  notes?: string
  pod?: string | null
}

export interface MissionDraft {
  key?: string
  name: string
  outcome: string
  definitionOfDone?: string
  slices?: SliceDraft[]
}

export type PlanChange =
  // `mission` defaults to the change set's mission (the active one).
  | { op: "add_slice"; mission?: string; slice: SliceDraft }
  // Cancel a not-started slice and add N in its place: the new slices inherit
  // its dependencies, and its dependents wait for all of them.
  | { op: "split_slice"; slice: string; into: SliceDraft[] }
  | { op: "add_dependency"; from: string; to: string }
  | { op: "remove_dependency"; from: string; to: string }
  // Slice keys in their new order; unlisted slices keep their relative order
  // after the listed ones.
  | { op: "reorder"; order: string[] }
  // Only a slice that has not started.
  | { op: "edit_slice"; slice: string; patch: SliceEdit }
  // Always proposals: seats never edit these directly.
  | { op: "add_mission"; mission: MissionDraft }
  | {
      op: "edit_mission"
      mission: string
      patch: { name?: string; outcome?: string; definitionOfDone?: string }
    }
  | {
      op: "edit_initiative"
      patch: { intent?: string; definitionOfDone?: string }
    }

export type PlanChangeOp = PlanChange["op"]

// What `revise_plan` may apply inside the active mission. Every other op (and
// any change naming another mission) becomes a proposal, whatever the rights.
export const SEAT_APPLICABLE_OPS: ReadonlySet<PlanChangeOp> = new Set([
  "add_slice",
  "split_slice",
  "add_dependency",
  "remove_dependency",
  "reorder",
  "edit_slice",
])

export const PLAN_CHANGE_OPS: readonly PlanChangeOp[] = [
  "add_slice",
  "split_slice",
  "add_dependency",
  "remove_dependency",
  "reorder",
  "edit_slice",
  "add_mission",
  "edit_mission",
  "edit_initiative",
]

export type ProposalKind = "slice" | "plan" | "revise_plan"
export type ProposalStatus = "pending" | "applied" | "rejected"

// One line per change, for proposal diffs, revision reasons, and tool results.
export function describePlanChange(change: PlanChange): string {
  const deps = (draft: SliceDraft) =>
    draft.dependsOn?.length ? ` (after ${draft.dependsOn.join(", ")})` : ""
  switch (change.op) {
    case "add_slice":
      return `+ user story ${change.slice.key ?? change.slice.title}${change.mission ? ` in ${change.mission}` : ""}: ${change.slice.title}${deps(change.slice)}`
    case "split_slice":
      return `± split ${change.slice} into ${change.into.map((d) => d.key ?? d.title).join(", ")}`
    case "add_dependency":
      return `+ ${change.to} waits for ${change.from}`
    case "remove_dependency":
      return `− ${change.to} no longer waits for ${change.from}`
    case "reorder":
      return `↕ order: ${change.order.join(", ")}`
    case "edit_slice":
      return `~ user story ${change.slice}: ${Object.keys(change.patch).join(", ") || "no fields"}`
    case "add_mission":
      return `+ milestone ${change.mission.key ?? change.mission.name}: ${change.mission.name} (${change.mission.slices?.length ?? 0} user stories)`
    case "edit_mission":
      return `~ milestone ${change.mission}: ${Object.keys(change.patch).join(", ") || "no fields"}`
    case "edit_initiative":
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
  return value.filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => v.trim())
}

export function parseSliceDraft(value: unknown): SliceDraft | string {
  if (!value || typeof value !== "object") return "A slice must be an object."
  const v = value as Record<string, unknown>
  const title = str(v.title)
  if (!title) return "Every slice needs a `title`."
  return {
    ...(str(v.key) ? { key: str(v.key) } : {}),
    title,
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
  }
}

function parseSliceEdit(value: unknown): SliceEdit | string {
  if (!value || typeof value !== "object") return "`patch` must be an object."
  const v = value as Record<string, unknown>
  const patch: SliceEdit = {}
  if (str(v.title)) patch.title = str(v.title)
  if (typeof v.goal === "string") patch.goal = v.goal
  if (strings(v.acceptance)) patch.acceptance = strings(v.acceptance)
  if (strings(v.out_of_scope ?? v.outOfScope))
    patch.outOfScope = strings(v.out_of_scope ?? v.outOfScope)
  if (strings(v.touch_hints ?? v.touchHints))
    patch.touchHints = strings(v.touch_hints ?? v.touchHints)
  if (typeof v.notes === "string") patch.notes = v.notes
  if (v.pod === null || str(v.pod)) patch.pod = str(v.pod) ?? null
  if (!Object.keys(patch).length) return "`patch` changes nothing."
  return patch
}

export function parseMissionDraft(value: unknown): MissionDraft | string {
  if (!value || typeof value !== "object") return "A mission must be an object."
  const v = value as Record<string, unknown>
  const name = str(v.name)
  if (!name) return "Every mission needs a `name`."
  const slices: SliceDraft[] = []
  if (v.slices !== undefined) {
    if (!Array.isArray(v.slices)) return "A mission's `slices` must be a list."
    for (const item of v.slices) {
      const draft = parseSliceDraft(item)
      if (typeof draft === "string") return `Mission ${name}: ${draft}`
      slices.push(draft)
    }
  }
  return {
    ...(str(v.key) ? { key: str(v.key) } : {}),
    name,
    outcome: typeof v.outcome === "string" ? v.outcome : "",
    ...(typeof (v.definition_of_done ?? v.definitionOfDone) === "string"
      ? { definitionOfDone: (v.definition_of_done ?? v.definitionOfDone) as string }
      : {}),
    slices,
  }
}

// Validate one change's shape (not its effect on the plan).
export function parsePlanChange(value: unknown): PlanChange | string {
  if (!value || typeof value !== "object") return "Each change must be an object."
  const v = value as Record<string, unknown>
  const op = v.op
  switch (op) {
    case "add_slice": {
      const slice = parseSliceDraft(v.slice)
      if (typeof slice === "string") return slice
      return { op, ...(str(v.mission) ? { mission: str(v.mission) } : {}), slice }
    }
    case "split_slice": {
      const slice = str(v.slice)
      if (!slice) return "split_slice needs the `slice` key to split."
      if (!Array.isArray(v.into) || v.into.length < 2)
        return "split_slice needs `into`: at least two slices."
      const into: SliceDraft[] = []
      for (const item of v.into) {
        const draft = parseSliceDraft(item)
        if (typeof draft === "string") return draft
        into.push(draft)
      }
      return { op, slice, into }
    }
    case "add_dependency":
    case "remove_dependency": {
      const from = str(v.from)
      const to = str(v.to)
      if (!from || !to) return `${op} needs \`from\` and \`to\` slice keys.`
      return { op, from, to }
    }
    case "reorder": {
      const order = strings(v.order)
      if (!order?.length) return "reorder needs `order`: slice keys in their new order."
      return { op, order }
    }
    case "edit_slice": {
      const slice = str(v.slice)
      if (!slice) return "edit_slice needs the `slice` key."
      const patch = parseSliceEdit(v.patch)
      if (typeof patch === "string") return patch
      return { op, slice, patch }
    }
    case "add_mission": {
      const mission = parseMissionDraft(v.mission)
      if (typeof mission === "string") return mission
      return { op, mission }
    }
    case "edit_mission": {
      const mission = str(v.mission)
      const p = (v.patch ?? {}) as Record<string, unknown>
      if (!mission) return "edit_mission needs the `mission` key."
      const patch: { name?: string; outcome?: string; definitionOfDone?: string } = {}
      if (str(p.name)) patch.name = str(p.name)
      if (typeof p.outcome === "string") patch.outcome = p.outcome
      const dod = p.definition_of_done ?? p.definitionOfDone
      if (typeof dod === "string") patch.definitionOfDone = dod
      if (!Object.keys(patch).length) return "`patch` changes nothing."
      return { op, mission, patch }
    }
    case "edit_initiative": {
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
