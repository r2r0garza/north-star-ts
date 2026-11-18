import { randomUUID } from "crypto"
import { getDb } from "../connection"
import {
  asActions,
  asFilter,
  asOutcomes,
  asPromoteGate,
  columnProblem,
  commandTimeoutProblem,
  wipLimitProblem,
  WRITE_APPROVALS,
  type KanbanAction,
  type KanbanBoard,
  type KanbanCall,
  type KanbanContinuation,
  type KanbanUpstreamAction,
  type KanbanWriteApproval,
  type KanbanCard,
  type KanbanCardRun,
  type KanbanCardRepo,
  type KanbanColumn,
  type KanbanColumnInput,
  type KanbanRunState,
  type KanbanIntakeFilter,
  type KanbanItem,
  type KanbanPromoteGate,
  type KanbanSource,
} from "../../../shared/kanban"

// Repository for kanban boards (plan 136.1). Flat functions, like dashboards.

export const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000
export const MIN_SYNC_INTERVAL_MS = 60_000

function parse(text: string | null): unknown {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

interface BoardRow {
  id: string
  name: string
  workspace: string | null
  source: string | null
  filter: string
  approved_hash: string | null
  write_approval: string
  approved_actions: string
  actions_paused: number
  worktrees: number
  parallel_commands: number
  notifications: number
  auto_promote: string
  sync_interval_ms: number
  last_sync_at: number | null
  last_sync_error: string | null
  created_at: number
  updated_at: number
}

function toBoard(r: BoardRow): KanbanBoard {
  return {
    id: r.id,
    name: r.name,
    workspace: r.workspace,
    source: parse(r.source) as KanbanSource | null,
    filter: asFilter(parse(r.filter)),
    approvedHash: r.approved_hash,
    writeApproval: WRITE_APPROVALS.includes(
      r.write_approval as KanbanWriteApproval
    )
      ? (r.write_approval as KanbanWriteApproval)
      : "once_per_action",
    approvedActions: (parse(r.approved_actions) as string[] | null) ?? [],
    actionsPaused: r.actions_paused === 1,
    worktrees: r.worktrees !== 0,
    parallelCommands: r.parallel_commands === 1,
    notifications: r.notifications !== 0,
    autoPromote: asPromoteGate(parse(r.auto_promote)),
    syncIntervalMs: r.sync_interval_ms,
    lastSyncAt: r.last_sync_at,
    lastSyncError: r.last_sync_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

interface CardRow {
  id: string
  board_id: string
  external_id: string
  item: string
  column_id: string | null
  status: string
  run_state: string
  run_error: string | null
  worktree: string | null
  branch: string | null
  own_worktree: number | null
  repos: string
  promote_held: number
  outcome: string | null
  visits: string
  returns: string
  continuation: string | null
  created_at: number
  updated_at: number
}

const counts = (text: string) =>
  (parse(text) as Record<string, number> | null) ?? {}

const RUN_STATES = new Set([
  "idle",
  "running",
  "waiting",
  "blocked",
  "failed",
  "done",
])

function toCard(r: CardRow): KanbanCard {
  return {
    id: r.id,
    boardId: r.board_id,
    externalId: r.external_id,
    item: parse(r.item) as KanbanItem,
    columnId: r.column_id,
    status: r.status === "unmatched" ? "unmatched" : "active",
    runState: (RUN_STATES.has(r.run_state)
      ? r.run_state
      : "idle") as KanbanRunState,
    runError: r.run_error,
    worktree: r.worktree,
    branch: r.branch,
    ownWorktree: r.own_worktree === null ? null : r.own_worktree === 1,
    repos: (parse(r.repos) as KanbanCardRepo[] | null) ?? [],
    promoteHeld: r.promote_held === 1,
    outcome: r.outcome,
    visits: counts(r.visits),
    returns: counts(r.returns),
    continuation: parse(r.continuation) as KanbanContinuation | null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listBoards(): KanbanBoard[] {
  return (
    getDb()
      .prepare("SELECT * FROM kanban_boards ORDER BY updated_at DESC")
      .all() as BoardRow[]
  ).map(toBoard)
}

export function getBoard(id: string): KanbanBoard | null {
  const row = getDb()
    .prepare("SELECT * FROM kanban_boards WHERE id = ?")
    .get(id) as BoardRow | undefined
  return row ? toBoard(row) : null
}

// Create or update a board's definition. `columns` omitted leaves them as is.
export function saveBoard(input: {
  id?: string
  name: string
  workspace: string | null
  source: KanbanSource
  filter: KanbanIntakeFilter
  syncIntervalMs?: number
  columns?: KanbanColumnInput[]
}): KanbanBoard {
  const db = getDb()
  const now = Date.now()
  const interval = Math.max(
    MIN_SYNC_INTERVAL_MS,
    input.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS
  )
  return db.transaction(() => {
    const id = input.id ?? randomUUID()
    if (input.id) {
      db.prepare(
        "UPDATE kanban_boards SET name = ?, workspace = ?, source = ?, filter = ?, sync_interval_ms = ?, updated_at = ? WHERE id = ?"
      ).run(
        input.name,
        input.workspace,
        JSON.stringify(input.source),
        JSON.stringify(input.filter),
        interval,
        now,
        id
      )
    } else {
      db.prepare(
        "INSERT INTO kanban_boards (id, name, workspace, source, filter, sync_interval_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        id,
        input.name,
        input.workspace,
        JSON.stringify(input.source),
        JSON.stringify(input.filter),
        interval,
        now,
        now
      )
    }
    if (input.columns) saveColumns(id, input.columns)
    return getBoard(id)!
  })()
}

export function deleteBoard(id: string): void {
  getDb().prepare("DELETE FROM kanban_boards WHERE id = ?").run(id)
}

export function setApprovedHash(id: string, hash: string): void {
  getDb()
    .prepare("UPDATE kanban_boards SET approved_hash = ? WHERE id = ?")
    .run(hash, id)
}

export function setSyncResult(id: string, error: string | null): void {
  getDb()
    .prepare(
      "UPDATE kanban_boards SET last_sync_at = ?, last_sync_error = ? WHERE id = ?"
    )
    .run(Date.now(), error, id)
}

// A board edit that can't be saved; the message is shown to the user.
export class KanbanColumnInUseError extends Error {}

export function setActionSettings(
  id: string,
  settings: { writeApproval: KanbanWriteApproval; actionsPaused: boolean }
): void {
  getDb()
    .prepare(
      "UPDATE kanban_boards SET write_approval = ?, actions_paused = ? WHERE id = ?"
    )
    .run(settings.writeApproval, settings.actionsPaused ? 1 : 0, id)
}

export function setRunSettings(
  id: string,
  settings: { worktrees: boolean; parallelCommands: boolean }
): void {
  getDb()
    .prepare(
      "UPDATE kanban_boards SET worktrees = ?, parallel_commands = ? WHERE id = ?"
    )
    .run(settings.worktrees ? 1 : 0, settings.parallelCommands ? 1 : 0, id)
}

export function setNotifications(id: string, on: boolean): void {
  getDb()
    .prepare("UPDATE kanban_boards SET notifications = ? WHERE id = ?")
    .run(on ? 1 : 0, id)
}

export function setAutoPromote(id: string, gate: KanbanPromoteGate): void {
  getDb()
    .prepare("UPDATE kanban_boards SET auto_promote = ? WHERE id = ?")
    .run(JSON.stringify(asPromoteGate(gate)), id)
}

export function addApprovedAction(id: string, hash: string): void {
  const board = getBoard(id)
  if (!board || board.approvedActions.includes(hash)) return
  getDb()
    .prepare("UPDATE kanban_boards SET approved_actions = ? WHERE id = ?")
    .run(JSON.stringify([...board.approvedActions, hash]), id)
}

// Set a board's columns in order. A column keeps its id (and its cards and run
// history) when matched by `id`, or by name when no id is sent (the agent tool
// doesn't know ids). Removing a column that still holds cards is refused.
export function saveColumns(boardId: string, input: KanbanColumnInput[]): void {
  const db = getDb()
  db.transaction(() => {
    const existing = listColumns(boardId)
    const kept = new Set<string>()
    const rows = input.map((c) => {
      const match =
        existing.find((e) => c.id && e.id === c.id) ??
        (c.id
          ? undefined
          : existing.find((e) => e.name === c.name && !kept.has(e.id)))
      if (match) kept.add(match.id)
      return {
        ...c,
        id: match?.id ?? randomUUID(),
        isNew: !match,
        actions: c.actions ? asActions(c.actions) : (match?.actions ?? []),
        outcomes: c.outcomes ? asOutcomes(c.outcomes) : (match?.outcomes ?? []),
        // Only a user column has a command; omitted keeps the stored one.
        command:
          c.owner !== "user"
            ? null
            : c.command !== undefined
              ? c.command?.trim() || null
              : (match?.command ?? null),
        commandTimeoutMs:
          c.commandTimeoutMs !== undefined
            ? c.commandTimeoutMs
            : (match?.commandTimeoutMs ?? null),
        notify: c.notify ?? match?.notify ?? false,
        wipLimit:
          c.wipLimit !== undefined ? c.wipLimit : (match?.wipLimit ?? null),
      }
    })
    // goto targets may name a column (the agent tool doesn't know ids).
    for (const c of rows) {
      c.outcomes = c.outcomes.map((o) =>
        o.next === "goto"
          ? {
              ...o,
              target:
                rows.find((r) => r.id === o.target)?.id ??
                rows.find((r) => r.name.trim() === o.target)?.id ??
                o.target,
            }
          : o
      )
      const problem = columnProblem(
        {
          name: c.name,
          outcomes: c.outcomes,
          actions: c.actions,
          instructions: c.instructions,
          command: c.command,
        },
        rows
      )
      if (problem)
        throw new KanbanColumnInUseError(`column "${c.name}": ${problem}`)
      const timeout = commandTimeoutProblem(c.commandTimeoutMs)
      if (timeout)
        throw new KanbanColumnInUseError(`column "${c.name}": ${timeout}`)
      const wip = wipLimitProblem(c.wipLimit)
      if (wip) throw new KanbanColumnInUseError(`column "${c.name}": ${wip}`)
    }
    for (const col of existing) {
      if (kept.has(col.id)) continue
      const held = db
        .prepare("SELECT COUNT(*) AS n FROM kanban_cards WHERE column_id = ?")
        .get(col.id) as { n: number }
      if (held.n > 0)
        throw new KanbanColumnInUseError(
          `column "${col.name}" still holds ${held.n} card(s); move them first`
        )
      db.prepare("DELETE FROM kanban_columns WHERE id = ?").run(col.id)
    }
    rows.forEach((c, i) => {
      const values = [
        c.name.trim(),
        c.agentName?.trim() || null,
        c.instructions?.trim() ?? "",
        c.gate === "human" ? "human" : "agent",
        c.owner === "user" ? "user" : "agent",
        JSON.stringify(c.outcomes),
        JSON.stringify(c.actions),
        c.command,
        c.commandTimeoutMs,
        c.notify ? 1 : 0,
        c.wipLimit,
        i,
      ]
      if (c.isNew)
        db.prepare(
          "INSERT INTO kanban_columns (name, agent_name, instructions, gate, owner, outcomes, actions, command, command_timeout_ms, notify, wip_limit, position, id, board_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(...values, c.id, boardId)
      else
        db.prepare(
          "UPDATE kanban_columns SET name = ?, agent_name = ?, instructions = ?, gate = ?, owner = ?, outcomes = ?, actions = ?, command = ?, command_timeout_ms = ?, notify = ?, wip_limit = ?, position = ? WHERE id = ?"
        ).run(...values, c.id)
    })
  })()
}

export function listColumns(boardId: string): KanbanColumn[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM kanban_columns WHERE board_id = ? ORDER BY position"
      )
      .all(boardId) as Array<{
      id: string
      board_id: string
      name: string
      position: number
      agent_name: string | null
      instructions: string
      gate: string
      owner: string
      outcomes: string
      actions: string
      command: string | null
      command_timeout_ms: number | null
      notify: number
      wip_limit: number | null
    }>
  ).map((r) => ({
    id: r.id,
    boardId: r.board_id,
    name: r.name,
    position: r.position,
    agentName: r.agent_name,
    instructions: r.instructions,
    gate: r.gate === "human" ? "human" : "agent",
    owner: r.owner === "user" ? "user" : "agent",
    outcomes: asOutcomes(parse(r.outcomes)),
    actions: asActions(parse(r.actions)),
    command: r.owner === "user" ? r.command : null,
    commandTimeoutMs: r.command_timeout_ms,
    notify: r.notify === 1,
    wipLimit: r.wip_limit,
  }))
}

export function getCard(id: string): KanbanCard | null {
  const row = getDb()
    .prepare("SELECT * FROM kanban_cards WHERE id = ?")
    .get(id) as CardRow | undefined
  return row ? toCard(row) : null
}

export function updateCard(
  id: string,
  patch: {
    columnId?: string | null
    runState?: KanbanRunState
    runError?: string | null
    worktree?: string | null
    branch?: string | null
    ownWorktree?: boolean | null
    repos?: KanbanCardRepo[]
    promoteHeld?: boolean
    outcome?: string | null
    visits?: Record<string, number>
    returns?: Record<string, number>
    continuation?: KanbanContinuation | null
  }
): void {
  const map: Record<string, string> = {
    columnId: "column_id",
    runState: "run_state",
    runError: "run_error",
    worktree: "worktree",
    branch: "branch",
    ownWorktree: "own_worktree",
    repos: "repos",
    promoteHeld: "promote_held",
    outcome: "outcome",
    visits: "visits",
    returns: "returns",
    continuation: "continuation",
  }
  const json = new Set(["visits", "returns", "continuation", "repos"])
  const keys = Object.keys(patch).filter((k) => k in map)
  if (!keys.length) return
  getDb()
    .prepare(
      `UPDATE kanban_cards SET ${keys.map((k) => `${map[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
    )
    .run(
      ...keys.map((k) => {
        const v = patch[k as keyof typeof patch] ?? null
        if (typeof v === "boolean") return v ? 1 : 0
        return json.has(k) && v !== null ? JSON.stringify(v) : v
      }),
      Date.now(),
      id
    )
}

export function deleteCard(id: string): void {
  getDb().prepare("DELETE FROM kanban_cards WHERE id = ?").run(id)
}

// Cards left `running` by a crash or quit: their task is gone.
export function listRunningCards(): KanbanCard[] {
  return (
    getDb()
      .prepare("SELECT * FROM kanban_cards WHERE run_state = 'running'")
      .all() as CardRow[]
  ).map(toCard)
}

interface RunRow {
  id: string
  kind: string
  card_id: string
  column_id: string | null
  column_name: string
  task_id: string | null
  conversation_id: string | null
  status: string
  outcome: string | null
  result: string | null
  error: string | null
  started_at: number
  finished_at: number | null
}

function toRun(r: RunRow): KanbanCardRun {
  return {
    id: r.id,
    kind: r.kind === "command" ? "command" : "agent",
    cardId: r.card_id,
    columnId: r.column_id,
    columnName: r.column_name,
    taskId: r.task_id,
    conversationId: r.conversation_id,
    status:
      r.status === "completed" || r.status === "failed" ? r.status : "running",
    outcome: r.outcome,
    result: r.result,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }
}

export function createRun(input: {
  cardId: string
  columnId: string
  columnName: string
  kind?: "agent" | "command"
}): KanbanCardRun {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO kanban_card_runs (id, kind, card_id, column_id, column_name, status, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?)"
    )
    .run(
      id,
      input.kind ?? "agent",
      input.cardId,
      input.columnId,
      input.columnName,
      Date.now()
    )
  return listRuns(input.cardId).find((r) => r.id === id)!
}

export function setRunTask(id: string, taskId: string): void {
  getDb()
    .prepare("UPDATE kanban_card_runs SET task_id = ? WHERE id = ?")
    .run(taskId, id)
}

export function setRunConversation(id: string, conversationId: string): void {
  getDb()
    .prepare("UPDATE kanban_card_runs SET conversation_id = ? WHERE id = ?")
    .run(conversationId, id)
}

export function finishRun(
  id: string,
  outcome: { result: string; outcome?: string | null } | { error: string }
): void {
  getDb()
    .prepare(
      "UPDATE kanban_card_runs SET status = ?, result = ?, outcome = ?, error = ?, finished_at = ? WHERE id = ?"
    )
    .run(
      "result" in outcome ? "completed" : "failed",
      "result" in outcome ? outcome.result : null,
      "result" in outcome ? (outcome.outcome ?? null) : null,
      "error" in outcome ? outcome.error : null,
      Date.now(),
      id
    )
}

export function setRunOutcome(id: string, outcome: string | null): void {
  getDb()
    .prepare("UPDATE kanban_card_runs SET outcome = ? WHERE id = ?")
    .run(outcome, id)
}

export function listRuns(cardId: string): KanbanCardRun[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM kanban_card_runs WHERE card_id = ? ORDER BY started_at, rowid"
      )
      .all(cardId) as RunRow[]
  ).map(toRun)
}

// A board's unfinished runs of one kind, oldest first: those with a task are
// running, the rest wait their turn (136.5/136.6).
export function listBoardRuns(
  boardId: string,
  kind: "agent" | "command"
): KanbanCardRun[] {
  return (
    getDb()
      .prepare(
        `SELECT r.* FROM kanban_card_runs r JOIN kanban_cards c ON c.id = r.card_id
         WHERE c.board_id = ? AND r.kind = ? AND r.status = 'running'
         ORDER BY r.started_at, r.rowid`
      )
      .all(boardId, kind) as RunRow[]
  ).map(toRun)
}

export function listCards(boardId: string): KanbanCard[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM kanban_cards WHERE board_id = ? ORDER BY created_at"
      )
      .all(boardId) as CardRow[]
  ).map(toCard)
}

// Apply one sync's matched items: upsert them as active; a card that no longer
// matches is dropped from the Inbox (no work done yet) or marked `unmatched` if
// it has moved into a column.
export function applySync(boardId: string, items: KanbanItem[]): void {
  const db = getDb()
  const now = Date.now()
  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO kanban_cards (id, board_id, external_id, item, column_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'active', ?, ?)
       ON CONFLICT(board_id, external_id) DO UPDATE SET item = excluded.item, status = 'active', updated_at = excluded.updated_at`
    )
    for (const item of items) {
      upsert.run(randomUUID(), boardId, item.id, JSON.stringify(item), now, now)
    }
    const seen = new Set(items.map((i) => i.id))
    for (const card of listCards(boardId)) {
      if (seen.has(card.externalId)) continue
      // An Inbox card with a worktree was sent back after work: keep it.
      if (card.columnId === null && !card.worktree) {
        db.prepare("DELETE FROM kanban_cards WHERE id = ?").run(card.id)
      } else if (card.status !== "unmatched") {
        db.prepare(
          "UPDATE kanban_cards SET status = 'unmatched', updated_at = ? WHERE id = ?"
        ).run(now, card.id)
      }
    }
  })()
}

// ── upstream actions (plan 136.3): audit log + idempotency ──────────────────

interface ActionRow {
  id: string
  card_id: string
  column_id: string | null
  column_name: string
  action_name: string
  phase: string
  outcome: string | null
  recipe_hash: string
  call: string
  status: string
  approved: number
  output: string | null
  error: string | null
  created_at: number
  finished_at: number | null
}

const ACTION_STATUSES = new Set(["pending", "ok", "failed", "skipped"])

function toAction(r: ActionRow): KanbanUpstreamAction {
  return {
    id: r.id,
    cardId: r.card_id,
    columnId: r.column_id,
    columnName: r.column_name,
    actionName: r.action_name,
    phase: r.phase === "enter" ? "enter" : "exit",
    outcome: r.outcome,
    recipeHash: r.recipe_hash,
    call: (parse(r.call) as KanbanCall | null) ?? {},
    status: (ACTION_STATUSES.has(r.status)
      ? r.status
      : "pending") as KanbanUpstreamAction["status"],
    approved: r.approved === 1,
    output: r.output,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }
}

export function getActionByKey(key: string): KanbanUpstreamAction | null {
  const row = getDb()
    .prepare("SELECT * FROM kanban_upstream_actions WHERE key = ?")
    .get(key) as ActionRow | undefined
  return row ? toAction(row) : null
}

export function getAction(id: string): KanbanUpstreamAction | null {
  const row = getDb()
    .prepare("SELECT * FROM kanban_upstream_actions WHERE id = ?")
    .get(id) as ActionRow | undefined
  return row ? toAction(row) : null
}

// Record (or refresh, on a retry) the attempt at `key` as pending. A changed
// recipe drops an earlier approval of this attempt.
export function upsertPendingAction(input: {
  key: string
  cardId: string
  columnId: string
  columnName: string
  action: KanbanAction
  outcome: string | null
  recipeHash: string
  call: KanbanCall
}): KanbanUpstreamAction {
  const db = getDb()
  const existing = getActionByKey(input.key)
  if (existing) {
    db.prepare(
      "UPDATE kanban_upstream_actions SET call = ?, recipe_hash = ?, approved = ?, status = 'pending', error = NULL WHERE id = ?"
    ).run(
      JSON.stringify(input.call),
      input.recipeHash,
      existing.approved && existing.recipeHash === input.recipeHash ? 1 : 0,
      existing.id
    )
    return getAction(existing.id)!
  }
  const id = randomUUID()
  db.prepare(
    `INSERT INTO kanban_upstream_actions (id, card_id, column_id, column_name, action_name, phase, outcome, key, recipe_hash, call, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    input.cardId,
    input.columnId,
    input.columnName,
    input.action.name,
    input.action.phase,
    input.outcome,
    input.key,
    input.recipeHash,
    JSON.stringify(input.call),
    Date.now()
  )
  return getAction(id)!
}

export function approveActionRow(id: string): void {
  getDb()
    .prepare("UPDATE kanban_upstream_actions SET approved = 1 WHERE id = ?")
    .run(id)
}

export function finishAction(
  id: string,
  result:
    | { status: "ok"; output: string }
    | { status: "failed" | "skipped"; error: string }
): void {
  getDb()
    .prepare(
      "UPDATE kanban_upstream_actions SET status = ?, output = ?, error = ?, finished_at = ? WHERE id = ?"
    )
    .run(
      result.status,
      "output" in result ? result.output.slice(0, 8_000) : null,
      "error" in result ? result.error : null,
      Date.now(),
      id
    )
}

// Pending attempts are dropped when the person moves the card elsewhere.
export function skipPendingActions(cardId: string, reason: string): void {
  getDb()
    .prepare(
      "UPDATE kanban_upstream_actions SET status = 'skipped', error = ?, finished_at = ? WHERE card_id = ? AND status = 'pending'"
    )
    .run(reason, Date.now(), cardId)
}

export function listActions(cardId: string): KanbanUpstreamAction[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM kanban_upstream_actions WHERE card_id = ? ORDER BY created_at, rowid"
      )
      .all(cardId) as ActionRow[]
  ).map(toAction)
}

export function pendingAction(cardId: string): KanbanUpstreamAction | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM kanban_upstream_actions WHERE card_id = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1"
    )
    .get(cardId) as ActionRow | undefined
  return row ? toAction(row) : null
}
