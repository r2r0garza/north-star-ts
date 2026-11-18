// Kanban board fed by external work trackers (plan 136). Shared by main (sync,
// storage, the kanban_write tool) and the renderer (board view).

// A path into the tracker's JSON: dotted string or explicit segments. Use
// segments when a key contains dots (ADO "System.Tags"). "*" maps over an array.
export type KanbanPath = string | string[]

// One replayable call: a shell command (run in the board's workspace) OR an MCP
// tool call (prefixed name `mcp__<server>__<tool>` + args). Exactly one.
export interface KanbanCall {
  command?: string
  tool?: string
  args?: Record<string, unknown>
}

// The intake recipe: agent-authored once, replayed with no LLM on each sync.
// The `{{query}}` placeholder in `command` or in string `args` is replaced on
// each sync with the board filter compiled for `tracker` (or the filter's raw
// query), so editing the filter changes what is fetched.
export interface KanbanSource extends KanbanCall {
  tracker?: KanbanTracker
  // Path to the item array in the output; omitted = the output is the array.
  itemsPath?: KanbanPath
  fields: {
    id: KanbanPath
    title: KanbanPath
    url?: KanbanPath
    body?: KanbanPath
    type?: KanbanPath
    state?: KanbanPath
    tags?: KanbanPath
    assignee?: KanbanPath
    updatedAt?: KanbanPath
    // Tracker custom fields, keyed by the tracker's field reference (ADO
    // "Custom.QAAssigned", Jira "QA Assigned" or "cf[10042]") → path to the value.
    custom?: Record<string, KanbanPath>
  }
  // Split string tags (ADO stores "a; b" in one field).
  tagSeparator?: string
  // Resolves "me" through the tracker's own identity (never stored).
  whoami?: KanbanCall & { path?: KanbanPath }
  note?: string
}

export type KanbanTracker = "github" | "jira" | "ado"

export const QUERY_PLACEHOLDER = "{{query}}"

export type KanbanAssignee =
  | { mode: "me" }
  | { mode: "anyone" }
  | { mode: "user"; user: string }

export interface KanbanIntakeFilter {
  tags: string[]
  match: "any" | "all"
  excludeTags: string[]
  assignee: KanbanAssignee
  // Work item types and states; empty = any. Re-checked locally against the
  // item's mapped `type`/`state`, so an item without one fails the check.
  types: string[]
  states: string[]
  // Custom field rules (fields mapped in source.fields.custom); each must match.
  fields?: KanbanFieldRule[]
  // Escape hatch: a raw GitHub search / JQL / WIQL used instead of the compiled
  // query. The structured fields above are still re-checked locally.
  query?: string
}

// A custom field must hold one of `values` (case-insensitive).
export interface KanbanFieldRule {
  field: string
  values: string[]
}

// The normalized item every source maps into.
export interface KanbanItem {
  id: string
  url: string | null
  title: string
  body: string
  type: string | null
  state: string | null
  tags: string[]
  assignees: string[]
  updatedAt: string | null
  // Mapped custom field values, keyed like source.fields.custom.
  custom?: Record<string, string[]>
}

// How upstream (tracker) writes are approved (plan 136 Decision 4).
export type KanbanWriteApproval =
  | "always"
  | "once_per_action"
  | "once_per_board"
  | "auto"

export const WRITE_APPROVALS: KanbanWriteApproval[] = [
  "always",
  "once_per_action",
  "once_per_board",
  "auto",
]

export type KanbanBoardSummary = KanbanBoard & { needsAttention: boolean }

export function cardNeedsAttention(
  card: Pick<KanbanCard, "runState" | "pendingApproval">
): boolean {
  return (
    !!card.pendingApproval ||
    ["waiting", "blocked", "failed"].includes(card.runState)
  )
}

export interface KanbanBoard {
  id: string
  name: string
  workspace: string | null
  source: KanbanSource | null
  filter: KanbanIntakeFilter
  approvedHash: string | null
  writeApproval: KanbanWriteApproval
  // Hashes of approved action recipes (once_per_action) or of the whole
  // board's actions (once_per_board).
  approvedActions: string[]
  // Kill switch: while set, every upstream action waits for the user.
  actionsPaused: boolean
  // 136.6: the default for whether cards get their own worktree, and (only
  // with worktrees off) whether command columns run cards in parallel.
  worktrees: boolean
  parallelCommands: boolean
  // Desktop notifications for this board's card runs. Off: only columns with
  // `notify` set raise them. Syncs never notify.
  notifications: boolean
  // Inbox cards matching this move to the first column after each sync.
  autoPromote: KanbanPromoteGate
  syncIntervalMs: number
  lastSyncAt: number | null
  lastSyncError: string | null
  createdAt: number
  updatedAt: number
}

// Which Inbox cards auto-promote: a state in `states` AND a tag in `tags`,
// each list checked only when filled in. Both empty = auto-promote off.
export interface KanbanPromoteGate {
  states: string[]
  tags: string[]
  fields?: KanbanFieldRule[]
}

export const promoteOn = (g: KanbanPromoteGate) =>
  g.states.length > 0 || g.tags.length > 0 || !!g.fields?.length

export function matchesPromoteGate(
  item: KanbanItem,
  gate: KanbanPromoteGate
): boolean {
  if (!promoteOn(gate)) return false
  const has = (list: string[], v: string | null) =>
    !!v && list.some((x) => lower(x) === lower(v))
  if (gate.states.length && !has(gate.states, item.state)) return false
  if (gate.tags.length && !gate.tags.some((t) => has(item.tags, t)))
    return false
  return matchesFields(item, gate.fields)
}

// Every rule's field holds one of its values; an unmapped field fails.
export function matchesFields(
  item: KanbanItem,
  rules: KanbanFieldRule[] | undefined
): boolean {
  return (rules ?? []).every((r) =>
    (item.custom?.[r.field] ?? []).some((v) =>
      r.values.some((x) => lower(x) === lower(v))
    )
  )
}

// Rules with a field and at least one value; omitted when there are none.
export function asFieldRules(raw: unknown): KanbanFieldRule[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const rules = raw
    .map((r) =>
      r && typeof r === "object" ? (r as Record<string, unknown>) : {}
    )
    .map((r) => ({
      field: typeof r.field === "string" ? r.field.trim() : "",
      values: stringList(r.values),
    }))
    .filter((r) => r.field && r.values.length)
  return rules.length ? rules : undefined
}

export function asPromoteGate(raw: unknown): KanbanPromoteGate {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >
  const fields = asFieldRules(r.fields)
  return {
    states: stringList(r.states),
    tags: stringList(r.tags),
    ...(fields ? { fields } : {}),
  }
}

// `agent`: the card advances when the agent reports done. `human`: it waits
// for the user to approve.
export type KanbanGate = "agent" | "human"

// Who works a column. `user`: no agent runs; entering waits for the person,
// and `instructions` say what they need to do before the card continues.
export type KanbanOwner = "agent" | "user"

// What a column's reported outcome does next (plan 136.3). `wait` needs a
// person whatever the gate; `end` finishes the card on this column; `goto`
// reruns `target` (a column id) with this run's findings as feedback.
export type KanbanOutcomeNext = "advance" | "wait" | "end" | "goto"

export interface KanbanOutcome {
  name: string
  next: KanbanOutcomeNext
  target?: string
  maxReturns?: number // goto only; default DEFAULT_MAX_RETURNS
}

export const DEFAULT_MAX_RETURNS = 2

// An upstream write, authored once as a recipe and replayed with the card's
// values bound in. `when` (exit only) limits it to those outcomes; omitted = any.
export interface KanbanAction extends KanbanCall {
  name: string
  phase: "enter" | "exit"
  when?: string[]
}

export interface KanbanColumn {
  id: string
  boardId: string
  name: string
  position: number
  agentName: string | null // null = the built-in North Star agent
  instructions: string // empty = no agent run; the card just sits here
  gate: KanbanGate
  owner: KanbanOwner
  outcomes: KanbanOutcome[]
  actions: KanbanAction[]
  // User columns only (136.5): a shell command the user wrote, run for each
  // card that enters. null timeout = no time limit.
  command: string | null
  commandTimeoutMs: number | null
  // Notify when a run here finishes; only used while the board's are off.
  notify: boolean
  // Most cards running here at once (agent or command); the rest wait as
  // Queued. null = no limit beyond the board's.
  wipLimit: number | null
}

// Matches the board-wide agent cap (MAX_PARALLEL_AGENTS); more would never run.
export const MAX_WIP_LIMIT = 4

export function wipLimitProblem(value: unknown): string | null {
  if (value === null) return null
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_WIP_LIMIT
    ? null
    : `the WIP limit must be empty or 1–${MAX_WIP_LIMIT}`
}

// A user-column command's time limit: off (null) or 5–90 minutes.
export const COMMAND_TIMEOUT_MIN_MS = 5 * 60_000
export const COMMAND_TIMEOUT_MAX_MS = 90 * 60_000

export function commandTimeoutProblem(value: unknown): string | null {
  if (value === null) return null
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= COMMAND_TIMEOUT_MIN_MS &&
    value <= COMMAND_TIMEOUT_MAX_MS
    ? null
    : "the command time limit must be off or 5–90 minutes"
}

// What the user edits (settings sheet) or the agent sends (kanban_write).
// `id` keeps an existing column; without it a new one is made. A goto
// `target` may be a column id or name. `actions` omitted keeps the stored ones.
export interface KanbanColumnInput {
  id?: string
  name: string
  agentName?: string | null
  instructions?: string
  gate?: KanbanGate
  owner?: KanbanOwner
  outcomes?: KanbanOutcome[]
  actions?: KanbanAction[]
  // User path only; the agent path never sends these (stored values are kept).
  command?: string | null
  commandTimeoutMs?: number | null
  notify?: boolean // omitted keeps the stored value
  wipLimit?: number | null // omitted keeps the stored value
}

// One upstream action attempt: the audit log and the idempotency record.
export interface KanbanUpstreamAction {
  id: string
  cardId: string
  columnId: string | null
  columnName: string
  actionName: string
  phase: "enter" | "exit"
  outcome: string | null
  recipeHash: string
  call: KanbanCall
  status: "pending" | "ok" | "failed" | "skipped"
  approved: boolean
  output: string | null
  error: string | null
  createdAt: number
  finishedAt: number | null
}

// idle: nothing to do here. waiting: the column's human gate needs approval.
// done: finished the last column.
// blocked: the agent reported an obstacle only the user can clear.
export type KanbanRunState =
  | "idle"
  | "running"
  | "waiting"
  | "blocked"
  | "failed"
  | "done"

// A repo a layout-B card opened: `path` relative to the workspace (and to the
// card's folder), on `branch`, created from `base`.
export interface KanbanCardRepo {
  path: string
  branch: string
  base: string
}

// How the board's workspace holds code (136.6). repo: the workspace is (in) a
// git repo. repos: a plain folder holding repos. none: no repos at all.
export type KanbanLayout = "repo" | "repos" | "none"

// Command columns run up to this many cards at once across a board with
// parallel commands on.
export const MAX_PARALLEL_COMMANDS = 4

// Agent columns run up to this many cards at once across a board; the rest
// wait (shown as Queued), leaving the app's other model slots free.
export const MAX_PARALLEL_AGENTS = 4

export interface KanbanCardRun {
  id: string
  // agent: an agent turn. command: a user column's command (136.5).
  kind: "agent" | "command"
  cardId: string
  columnId: string | null
  columnName: string
  taskId: string | null
  conversationId: string | null
  status: "running" | "completed" | "failed"
  outcome: string | null
  result: string | null
  error: string | null
  startedAt: number
  finishedAt: number | null
}

// `unmatched`: the item no longer passes the filter upstream (kept, not deleted,
// once it has left the inbox).
export type KanbanCardStatus = "active" | "unmatched"

export interface KanbanCard {
  id: string
  boardId: string
  externalId: string
  item: KanbanItem
  columnId: string | null // null = Inbox
  status: KanbanCardStatus
  runState: KanbanRunState
  runError: string | null
  // Layout A: the card's worktree. Layout B: the card's own folder, holding
  // a worktree for each repo the agent opened (`repos`).
  worktree: string | null
  branch: string | null
  // 136.6: null = follow the board's `worktrees` setting.
  ownWorktree: boolean | null
  repos: KanbanCardRepo[]
  // A person put the card in the Inbox (reject, send back, move): it never
  // auto-promotes again.
  promoteHeld: boolean
  // The outcome the current column's run reported (the person may change it).
  outcome: string | null
  // Visits per column id (keys idempotency) and automatic gotos per column id.
  visits: Record<string, number>
  returns: Record<string, number>
  // A move parked on an upstream action (approval or failure), resumed later.
  continuation: KanbanContinuation | null
  // The upstream action the card is parked on, if any (attached by the graph).
  pendingAction?: KanbanUpstreamAction | null
  // Set while the card waits its turn for its column's command (attached by the graph).
  queued?: boolean
  // Set once the card has run anything; its worktree choice is then fixed.
  started?: boolean
  // Set while a running card is parked on a tool call needing the user's yes.
  pendingApproval?: {
    requestId: string
    tool: string
    summary: string
    reason: string
  } | null
  createdAt: number
  updatedAt: number
}

// enter: put the card in a column (running its on-enter actions, then its
// agent). leave: run the column's exit actions for `outcome`, then go `to`.
// `findings`: a goto's reason, handed to the target column as untrusted data.
export interface KanbanFindings {
  column: string
  outcome: string
  result: string
  // The target comes after the sender. Missing on findings saved before this.
  forward?: boolean
}

export type KanbanContinuation =
  | {
      kind: "enter"
      columnId: string | null
      feedback?: string
      findings?: KanbanFindings
    }
  | {
      kind: "leave"
      fromColumnId: string
      outcome: string | null
      to: { columnId: string } | { done: true }
      findings?: KanbanFindings
      countReturn?: boolean
    }

export interface KanbanBoardGraph {
  board: KanbanBoard
  columns: KanbanColumn[]
  cards: KanbanCard[]
  sourceHash: string | null
  approved: boolean
  layout: KanbanLayout
  // What a sync runs (query bound in), or why it can't run.
  intakeCall: KanbanCall | null
  intakeError: string | null
}

export const DEFAULT_FILTER: KanbanIntakeFilter = {
  tags: [],
  match: "any",
  excludeTags: [],
  assignee: { mode: "me" },
  types: [],
  states: [],
}

export const MAX_ITEMS = 500
const MAX_BODY_CHARS = 20_000

function segments(path: KanbanPath | undefined): string[] {
  if (path === undefined) return []
  return Array.isArray(path) ? path : path.split(".").filter(Boolean)
}

// Every leaf value at `path`, with "*" expanding arrays.
export function pickAll(
  value: unknown,
  path: KanbanPath | undefined
): unknown[] {
  let current: unknown[] = [value]
  for (const seg of segments(path)) {
    const next: unknown[] = []
    for (const v of current) {
      if (seg === "*") {
        if (Array.isArray(v)) next.push(...v)
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        const child = (v as Record<string, unknown>)[seg]
        if (child !== undefined && child !== null) next.push(child)
      }
    }
    current = next
  }
  // A path ending on an array yields its elements.
  return current.flatMap((v) => (Array.isArray(v) ? v : [v]))
}

function scalar(value: unknown, path: KanbanPath | undefined): string | null {
  if (path === undefined) return null
  const leaf = pickAll(value, path).find(
    (v) => typeof v === "string" || typeof v === "number"
  )
  return leaf === undefined ? null : String(leaf)
}

function strings(
  value: unknown,
  path: KanbanPath | undefined,
  separator?: string
): string[] {
  if (path === undefined) return []
  return pickAll(value, path)
    .filter((v) => typeof v === "string" || typeof v === "number")
    .flatMap((v) => (separator ? String(v).split(separator) : [String(v)]))
    .map((s) => s.trim())
    .filter(Boolean)
}

function safeUrl(raw: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : null
  } catch {
    return null
  }
}

function itemUrl(row: unknown, path: KanbanPath | undefined): string | null {
  const mapped = safeUrl(scalar(row, path))
  if (!mapped) return null
  const url = new URL(mapped)
  const api = url.pathname.match(/^(.*)\/_apis\/wit\/workitems\/(\d+)\/?$/i)
  if (
    !api ||
    !(
      url.hostname.endsWith(".visualstudio.com") ||
      url.hostname === "dev.azure.com"
    )
  )
    return mapped

  const html = safeUrl(scalar(row, ["_links", "html", "href"]))
  if (html) return html
  const project = scalar(row, ["fields", "System.TeamProject"])
  let prefix = api[1]
  const organizationOnly =
    url.hostname === "dev.azure.com" ? /^\/[^/]+$/.test(prefix) : !prefix
  if (organizationOnly && project) prefix += `/${encodeURIComponent(project)}`
  url.pathname = `${prefix}/_workitems/edit/${api[2]}`
  url.search = ""
  url.hash = ""
  return url.href
}

// MCP results arrive as text; commands as stdout. Both must be JSON.
export function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output.trim())
  } catch {
    throw new Error("intake recipe must output JSON")
  }
}

// Map raw tracker output into normalized items. Rows without an id or title are
// dropped; the list is capped at MAX_ITEMS.
export function normalizeItems(
  output: unknown,
  source: KanbanSource
): KanbanItem[] {
  const rows =
    source.itemsPath === undefined
      ? Array.isArray(output)
        ? output
        : [output]
      : pickAll(output, source.itemsPath)
  const f = source.fields
  const items: KanbanItem[] = []
  for (const row of rows) {
    const id = scalar(row, f.id)
    const title = scalar(row, f.title)
    if (!id || !title) continue
    items.push({
      id,
      url: itemUrl(row, f.url),
      title,
      body: (scalar(row, f.body) ?? "").slice(0, MAX_BODY_CHARS),
      type: scalar(row, f.type),
      state: scalar(row, f.state),
      tags: strings(row, f.tags, source.tagSeparator),
      assignees: strings(row, f.assignee),
      updatedAt: scalar(row, f.updatedAt),
      ...(f.custom
        ? {
            custom: Object.fromEntries(
              Object.entries(f.custom).map(([k, path]) => [
                k,
                strings(row, path),
              ])
            ),
          }
        : {}),
    })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

const lower = (s: string) => s.trim().toLowerCase()

// The local re-check every synced item must pass, whatever the recipe's query
// did. `me` is the tracker identity resolved this sync; when the filter needs it
// and it is missing, nothing matches (fail closed).
export function matchesFilter(
  item: KanbanItem,
  filter: KanbanIntakeFilter,
  me: string | null
): boolean {
  const tags = new Set(item.tags.map(lower))
  const wanted = filter.tags.map(lower)
  if (wanted.length > 0) {
    const ok =
      filter.match === "all"
        ? wanted.every((t) => tags.has(t))
        : wanted.some((t) => tags.has(t))
    if (!ok) return false
  }
  if (filter.excludeTags.some((t) => tags.has(lower(t)))) return false
  const oneOf = (list: string[], v: string | null) =>
    !list.length || (!!v && list.some((x) => lower(x) === lower(v)))
  if (!oneOf(filter.types, item.type) || !oneOf(filter.states, item.state))
    return false
  if (!matchesFields(item, filter.fields)) return false
  const assignees = item.assignees.map(lower)
  switch (filter.assignee.mode) {
    case "anyone":
      return true
    case "me":
      return !!me && assignees.includes(lower(me))
    case "user":
      return assignees.includes(lower(filter.assignee.user))
  }
}

// Coerce a stored/model-supplied filter into a valid one.
export function asFilter(raw: unknown): KanbanIntakeFilter {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >
  const list = stringList
  const a = (r.assignee ?? {}) as Record<string, unknown>
  const assignee: KanbanAssignee =
    a.mode === "anyone"
      ? { mode: "anyone" }
      : a.mode === "user" && typeof a.user === "string" && a.user.trim()
        ? { mode: "user", user: a.user.trim() }
        : { mode: "me" }
  const query = typeof r.query === "string" ? r.query.trim() : ""
  const fields = asFieldRules(r.fields)
  return {
    ...(query ? { query } : {}),
    ...(fields ? { fields } : {}),
    tags: list(r.tags),
    match: r.match === "all" ? "all" : "any",
    excludeTags: list(r.excludeTags),
    assignee,
    types: list(r.types),
    states: list(r.states),
  }
}

function stringList(v: unknown): string[] {
  return Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === "string" && !!s.trim())
        .map((s) => s.trim())
    : []
}

// ── filter → tracker query ──────────────────────────────────────────────────

// GitHub search has no quote escaping; a label containing `"` can't be matched.
const ghLabel = (t: string) => `"${t.replace(/"/g, "")}"`
const jqlString = (t: string) =>
  `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
const wiqlString = (t: string) => `'${t.replace(/'/g, "''")}'`

function githubQuery(f: KanbanIntakeFilter): string {
  const parts = ["is:issue", "is:open"]
  if (f.tags.length)
    parts.push(
      ...(f.match === "all"
        ? f.tags.map((t) => `label:${ghLabel(t)}`)
        : [`label:${f.tags.map(ghLabel).join(",")}`])
    )
  parts.push(...f.excludeTags.map((t) => `-label:${ghLabel(t)}`))
  if (f.assignee.mode === "me") parts.push("assignee:@me")
  if (f.assignee.mode === "user")
    parts.push(`assignee:${f.assignee.user.replace(/\s/g, "")}`)
  // Issue types; states are only open/closed (is:open), so they're checked locally.
  if (f.types.length) parts.push(`type:${f.types.map(ghLabel).join(",")}`)
  if (f.fields?.length)
    throw new Error(
      "GitHub issues have no custom fields; use a raw query or remove the custom field rules"
    )
  return parts.join(" ")
}

function jiraQuery(f: KanbanIntakeFilter): string {
  const parts: string[] = []
  if (f.tags.length)
    parts.push(
      f.match === "all"
        ? f.tags.map((t) => `labels = ${jqlString(t)}`).join(" AND ")
        : `labels in (${f.tags.map(jqlString).join(", ")})`
    )
  // `not in` alone also drops unlabeled issues, so keep them explicitly.
  if (f.excludeTags.length)
    parts.push(
      `(labels is EMPTY OR labels not in (${f.excludeTags.map(jqlString).join(", ")}))`
    )
  if (f.assignee.mode === "me") parts.push("assignee = currentUser()")
  if (f.assignee.mode === "user")
    parts.push(`assignee = ${jqlString(f.assignee.user)}`)
  if (f.types.length)
    parts.push(`issuetype in (${f.types.map(jqlString).join(", ")})`)
  for (const r of f.fields ?? [])
    parts.push(
      `${/^cf\[\d+\]$/.test(r.field) ? r.field : jqlString(r.field)} in (${r.values.map(jqlString).join(", ")})`
    )
  parts.push(
    f.states.length
      ? `status in (${f.states.map(jqlString).join(", ")})`
      : "statusCategory != Done"
  )
  return parts.join(" AND ")
}

// ADO field reference names: letters, digits, `_` and `.` (e.g. Custom.QAAssigned).
function wiqlField(ref: string): string {
  if (!/^[A-Za-z][\w.]*$/.test(ref))
    throw new Error(
      `"${ref}" isn't an ADO field reference name (like Custom.QAAssigned)`
    )
  return `[${ref}]`
}

function adoQuery(f: KanbanIntakeFilter): string {
  const tag = (t: string) => `[System.Tags] CONTAINS ${wiqlString(t)}`
  const parts: string[] = []
  if (f.tags.length)
    parts.push(
      `(${f.tags.map(tag).join(f.match === "all" ? " AND " : " OR ")})`
    )
  parts.push(...f.excludeTags.map((t) => `NOT ${tag(t)}`))
  if (f.assignee.mode === "me") parts.push("[System.AssignedTo] = @Me")
  if (f.assignee.mode === "user")
    parts.push(`[System.AssignedTo] = ${wiqlString(f.assignee.user)}`)
  if (f.types.length)
    parts.push(
      `[System.WorkItemType] IN (${f.types.map(wiqlString).join(", ")})`
    )
  // shortcut: default process state names when no states are given; a custom
  // process lists its own states.
  parts.push(
    f.states.length
      ? `[System.State] IN (${f.states.map(wiqlString).join(", ")})`
      : "[System.State] NOT IN ('Closed', 'Done', 'Removed')"
  )
  const custom = (f.fields ?? []).map((r) => wiqlField(r.field))
  parts.push(
    ...(f.fields ?? []).map(
      (r, i) => `${custom[i]} IN (${r.values.map(wiqlString).join(", ")})`
    )
  )
  // Custom fields are selected too, so the local re-check can read them.
  return (
    "SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], " +
    "[System.Tags], [System.AssignedTo], [System.ChangedDate]" +
    custom.map((c) => `, ${c}`).join("") +
    " FROM WorkItems WHERE " +
    parts.join(" AND ")
  )
}

// The tracker query for a filter: its raw query if set, else compiled.
export function compileIntakeQuery(
  filter: KanbanIntakeFilter,
  tracker: KanbanTracker
): string {
  if (filter.query) return filter.query
  if (tracker === "github") return githubQuery(filter)
  if (tracker === "jira") return jiraQuery(filter)
  return adoQuery(filter)
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

function usesPlaceholder(call: KanbanCall): boolean {
  return JSON.stringify([call.command, call.args]).includes(QUERY_PLACEHOLDER)
}

function replaceInArgs(value: unknown, query: string): unknown {
  if (typeof value === "string")
    return value.split(QUERY_PLACEHOLDER).join(query)
  if (Array.isArray(value)) return value.map((v) => replaceInArgs(v, query))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, replaceInArgs(v, query)])
    )
  return value
}

// The call a sync actually runs. The query goes into a command shell-quoted as
// one argument (never spliced raw), and into MCP args as plain strings.
export function resolveIntakeCall(
  source: KanbanSource,
  filter: KanbanIntakeFilter
): KanbanCall {
  if (!usesPlaceholder(source))
    return { command: source.command, tool: source.tool, args: source.args }
  if (!filter.query && !source.tracker)
    throw new Error(
      `the recipe uses ${QUERY_PLACEHOLDER} but sets no tracker and the filter has no raw query`
    )
  const query = compileIntakeQuery(filter, source.tracker ?? "github")
  return {
    command: source.command?.split(QUERY_PLACEHOLDER).join(shellQuote(query)),
    tool: source.tool,
    args: source.args
      ? (replaceInArgs(source.args, query) as Record<string, unknown>)
      : undefined,
  }
}

// ── column outcomes and upstream actions (plan 136.3) ───────────────────────

const ACTION_VARS = ["id", "url", "branch", "result"] as const
export type KanbanActionVars = Record<(typeof ACTION_VARS)[number], string>

function bindArgs(value: unknown, vars: KanbanActionVars): unknown {
  if (typeof value === "string")
    return ACTION_VARS.reduce(
      (s, k) => s.split(`{{${k}}}`).join(vars[k]),
      value
    )
  if (Array.isArray(value)) return value.map((v) => bindArgs(v, vars))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, bindArgs(v, vars)])
    )
  return value
}

// The call an action runs for one card. Values go into a command shell-quoted
// as one argument each (never spliced raw), into MCP args as plain strings.
export function bindActionCall(
  action: KanbanAction,
  vars: KanbanActionVars
): KanbanCall {
  return {
    command: action.command
      ? ACTION_VARS.reduce(
          (s, k) => s.split(`{{${k}}}`).join(shellQuote(vars[k])),
          action.command
        )
      : undefined,
    tool: action.tool,
    args: action.args
      ? (bindArgs(action.args, vars) as Record<string, unknown>)
      : undefined,
  }
}

// ── column placeholders (136.7) ─────────────────────────────────────────────
// A column's command and agent instructions can name the card's values as
// {{name}}. Instructions are the user's orders to the agent, so only values
// from the board or with a fixed shape go in; tracker text (the title) is
// allowed only in commands, where it is shell-quoted as one argument.
export const COMMAND_PLACEHOLDERS = ["id", "url", "branch", "title"] as const
export const INSTRUCTION_PLACEHOLDERS = ["id", "url", "branch"] as const
export type KanbanCardVars = Record<
  (typeof COMMAND_PLACEHOLDERS)[number],
  string
>

const PLACEHOLDER = /\{\{\s*([A-Za-z_]+)\s*\}\}/g

// Why `text` can't be saved, or null: it names a placeholder that isn't allowed.
export function placeholderProblem(
  text: string | null | undefined,
  allowed: readonly string[],
  field: string
): string | null {
  for (const [, name] of (text ?? "").matchAll(PLACEHOLDER))
    if (!allowed.includes(name))
      return `${field} uses {{${name}}}, which isn't available there. Use ${allowed.map((a) => `{{${a}}}`).join(", ")}.`
  return null
}

// One pass, so a filled-in value is never expanded again.
function fill(
  text: string,
  vars: KanbanCardVars,
  allowed: readonly string[],
  render: (value: string) => string
): string {
  return text.replace(PLACEHOLDER, (match, name: string) =>
    allowed.includes(name) ? render(vars[name as keyof KanbanCardVars]) : match
  )
}

export const fillCommand = (command: string, vars: KanbanCardVars) =>
  fill(command, vars, COMMAND_PLACEHOLDERS, shellQuote)

export const fillInstructions = (text: string, vars: KanbanCardVars) =>
  fill(text, vars, INSTRUCTION_PLACEHOLDERS, (v) => v)

export function cardVars(
  card: Pick<KanbanCard, "item" | "branch">
): KanbanCardVars {
  return {
    id: card.item.id,
    url: card.item.url ?? "",
    branch: card.branch ?? "",
    title: card.item.title,
  }
}

const NEXTS = new Set(["advance", "wait", "end", "goto"])

// Coerce stored/model-supplied outcomes; drops nameless or duplicate ones.
export function asOutcomes(raw: unknown): KanbanOutcome[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: KanbanOutcome[] = []
  for (const r of raw) {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>
    const name = typeof o.name === "string" ? o.name.trim() : ""
    if (!name || seen.has(name)) continue
    seen.add(name)
    const next = NEXTS.has(o.next as string)
      ? (o.next as KanbanOutcomeNext)
      : "advance"
    out.push(
      next === "goto"
        ? {
            name,
            next,
            target: typeof o.target === "string" ? o.target.trim() : "",
            maxReturns:
              typeof o.maxReturns === "number" && o.maxReturns >= 0
                ? Math.floor(o.maxReturns)
                : DEFAULT_MAX_RETURNS,
          }
        : { name, next }
    )
  }
  return out
}

// Coerce stored/model-supplied actions, keeping only recipe keys (anything else
// would be stored and hashed). Shape problems are reported by `actionProblem`.
export function asActions(raw: unknown): KanbanAction[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((r) => r && typeof r === "object")
    .map((r) => {
      const o = r as Record<string, unknown>
      const when = Array.isArray(o.when)
        ? o.when.filter((w): w is string => typeof w === "string" && !!w.trim())
        : []
      return {
        name: typeof o.name === "string" ? o.name.trim() : "",
        phase: o.phase === "enter" ? "enter" : "exit",
        ...(typeof o.command === "string" && o.command.trim()
          ? { command: o.command.trim() }
          : {}),
        ...(typeof o.tool === "string" && o.tool.trim()
          ? { tool: o.tool.trim() }
          : {}),
        ...(o.args && typeof o.args === "object" && !Array.isArray(o.args)
          ? { args: o.args as Record<string, unknown> }
          : {}),
        ...(o.phase !== "enter" && when.length ? { when } : {}),
      } satisfies KanbanAction
    })
}

// Why a column's outcomes/actions can't be saved, or null. `columns` is every
// column's id and name after the save (goto targets are already resolved).
export function columnProblem(
  column: {
    name: string
    outcomes: KanbanOutcome[]
    actions: KanbanAction[]
    instructions?: string | null
    command?: string | null
  },
  columns: Array<{ id: string; name: string }>
): string | null {
  const placeholders =
    placeholderProblem(
      column.instructions,
      INSTRUCTION_PLACEHOLDERS,
      "the instructions"
    ) ?? placeholderProblem(column.command, COMMAND_PLACEHOLDERS, "the command")
  if (placeholders) return placeholders
  for (const o of column.outcomes)
    if (o.next === "goto" && !columns.some((c) => c.id === o.target))
      return `outcome "${o.name}" goes to "${o.target}", which is not a column on this board`
  const names = new Set<string>()
  for (const a of column.actions) {
    if (!a.name) return "every action needs a name"
    if (names.has(a.name)) return `two actions are named "${a.name}"`
    names.add(a.name)
    if (!!a.command === !!a.tool)
      return `action "${a.name}" needs exactly one of command or tool`
    if (a.tool && !/^mcp__[^_].*__.+/.test(a.tool))
      return `action "${a.name}": tool must be an MCP tool name like mcp__<server>__<tool>`
    const unknown = a.when?.find(
      (w) => !column.outcomes.some((o) => o.name === w)
    )
    if (unknown)
      return `action "${a.name}" runs when "${unknown}", which is not an outcome of this column`
  }
  return null
}

// The agent's column list merged with the user's columns (136.5). The agent
// writes only agent columns. Each user column keeps its settings and stays
// right after the agent column it followed (or first, if it was first); if the
// agent removed that column, it stays after as many agent columns as before.
// A name that clashes with a user column is refused.
export function mergeAgentColumns(
  existing: KanbanColumn[],
  input: KanbanColumnInput[]
): KanbanColumnInput[] {
  const users = existing.filter((c) => c.owner === "user")
  const clash = input.find((c) =>
    users.some((u) => u.name.trim() === c.name.trim())
  )
  if (clash)
    throw new Error(
      `"${clash.name}" is one of the user's own columns; you can't change it. Pick another name.`
    )
  const merged: KanbanColumnInput[] = input.map(
    ({ command: _c, commandTimeoutMs: _t, ...c }) => ({ ...c, owner: "agent" })
  )
  const isUser = (c: KanbanColumnInput) => c.owner === "user"
  for (const u of users) {
    const prior = existing
      .slice(0, existing.indexOf(u))
      .filter((c) => c.owner !== "user")
    const anchor = prior.at(-1)
    let at = anchor
      ? merged.findIndex(
          (c) =>
            !isUser(c) &&
            (c.id === anchor.id || c.name.trim() === anchor.name.trim())
        ) + 1
      : 0
    if (anchor && at === 0)
      for (let seen = 0; at < merged.length && seen < prior.length; at++)
        if (!isUser(merged[at])) seen++
    // After any user columns already placed there (they came first before).
    while (at < merged.length && isUser(merged[at])) at++
    merged.splice(at, 0, {
      id: u.id,
      name: u.name,
      agentName: u.agentName,
      instructions: u.instructions,
      gate: u.gate,
      owner: "user",
      outcomes: u.outcomes,
      actions: u.actions,
      command: u.command,
      commandTimeoutMs: u.commandTimeoutMs,
      notify: u.notify,
    })
  }
  return merged
}
