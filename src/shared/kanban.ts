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
  // Escape hatch: a raw GitHub search / JQL / WIQL used instead of the compiled
  // query. The structured fields above are still re-checked locally.
  query?: string
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
}

export interface KanbanBoard {
  id: string
  name: string
  workspace: string | null
  source: KanbanSource | null
  filter: KanbanIntakeFilter
  approvedHash: string | null
  syncIntervalMs: number
  lastSyncAt: number | null
  lastSyncError: string | null
  createdAt: number
  updatedAt: number
}

// `agent`: the card advances when the agent reports done. `human`: it waits
// for the user to approve.
export type KanbanGate = "agent" | "human"

export interface KanbanColumn {
  id: string
  boardId: string
  name: string
  position: number
  agentName: string | null // null = the built-in North Star agent
  instructions: string // empty = no agent run; the card just sits here
  gate: KanbanGate
}

// What the user edits (settings sheet) or the agent sends (kanban_write).
// `id` keeps an existing column; without it a new one is made.
export interface KanbanColumnInput {
  id?: string
  name: string
  agentName?: string | null
  instructions?: string
  gate?: KanbanGate
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

export interface KanbanCardRun {
  id: string
  cardId: string
  columnId: string | null
  columnName: string
  taskId: string | null
  conversationId: string | null
  status: "running" | "completed" | "failed"
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
  worktree: string | null
  branch: string | null
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

export interface KanbanBoardGraph {
  board: KanbanBoard
  columns: KanbanColumn[]
  cards: KanbanCard[]
  sourceHash: string | null
  approved: boolean
  // What a sync runs (query bound in), or why it can't run.
  intakeCall: KanbanCall | null
  intakeError: string | null
}

export const DEFAULT_FILTER: KanbanIntakeFilter = {
  tags: [],
  match: "any",
  excludeTags: [],
  assignee: { mode: "me" },
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
      url: safeUrl(scalar(row, f.url)),
      title,
      body: (scalar(row, f.body) ?? "").slice(0, MAX_BODY_CHARS),
      type: scalar(row, f.type),
      state: scalar(row, f.state),
      tags: strings(row, f.tags, source.tagSeparator),
      assignees: strings(row, f.assignee),
      updatedAt: scalar(row, f.updatedAt),
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
  const list = (v: unknown) =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string" && !!s.trim())
      : []
  const a = (r.assignee ?? {}) as Record<string, unknown>
  const assignee: KanbanAssignee =
    a.mode === "anyone"
      ? { mode: "anyone" }
      : a.mode === "user" && typeof a.user === "string" && a.user.trim()
        ? { mode: "user", user: a.user.trim() }
        : { mode: "me" }
  const query = typeof r.query === "string" ? r.query.trim() : ""
  return {
    ...(query ? { query } : {}),
    tags: list(r.tags),
    match: r.match === "all" ? "all" : "any",
    excludeTags: list(r.excludeTags),
    assignee,
  }
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
  parts.push("statusCategory != Done")
  return parts.join(" AND ")
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
  // shortcut: default process state names; a custom process needs the raw query.
  parts.push("[System.State] NOT IN ('Closed', 'Done', 'Removed')")
  return (
    "SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], " +
    "[System.Tags], [System.AssignedTo], [System.ChangedDate] FROM WorkItems WHERE " +
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
