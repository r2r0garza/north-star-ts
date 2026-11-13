import { randomUUID } from "crypto"
import { getDb } from "../connection"
import {
  asFilter,
  type KanbanBoard,
  type KanbanCard,
  type KanbanCardRun,
  type KanbanColumn,
  type KanbanColumnInput,
  type KanbanRunState,
  type KanbanIntakeFilter,
  type KanbanItem,
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
  created_at: number
  updated_at: number
}

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

export class KanbanColumnInUseError extends Error {}

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
      return { ...c, id: match?.id ?? randomUUID(), isNew: !match }
    })
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
        i,
      ]
      if (c.isNew)
        db.prepare(
          "INSERT INTO kanban_columns (name, agent_name, instructions, gate, position, id, board_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(...values, c.id, boardId)
      else
        db.prepare(
          "UPDATE kanban_columns SET name = ?, agent_name = ?, instructions = ?, gate = ?, position = ? WHERE id = ?"
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
    }>
  ).map((r) => ({
    id: r.id,
    boardId: r.board_id,
    name: r.name,
    position: r.position,
    agentName: r.agent_name,
    instructions: r.instructions,
    gate: r.gate === "human" ? "human" : "agent",
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
  }
): void {
  const map: Record<string, string> = {
    columnId: "column_id",
    runState: "run_state",
    runError: "run_error",
    worktree: "worktree",
    branch: "branch",
  }
  const keys = Object.keys(patch).filter((k) => k in map)
  if (!keys.length) return
  getDb()
    .prepare(
      `UPDATE kanban_cards SET ${keys.map((k) => `${map[k]} = ?`).join(", ")}, updated_at = ? WHERE id = ?`
    )
    .run(
      ...keys.map((k) => patch[k as keyof typeof patch] ?? null),
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
  card_id: string
  column_id: string | null
  column_name: string
  task_id: string | null
  conversation_id: string | null
  status: string
  result: string | null
  error: string | null
  started_at: number
  finished_at: number | null
}

function toRun(r: RunRow): KanbanCardRun {
  return {
    id: r.id,
    cardId: r.card_id,
    columnId: r.column_id,
    columnName: r.column_name,
    taskId: r.task_id,
    conversationId: r.conversation_id,
    status:
      r.status === "completed" || r.status === "failed" ? r.status : "running",
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
}): KanbanCardRun {
  const id = randomUUID()
  getDb()
    .prepare(
      "INSERT INTO kanban_card_runs (id, card_id, column_id, column_name, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)"
    )
    .run(id, input.cardId, input.columnId, input.columnName, Date.now())
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
  outcome: { result: string } | { error: string }
): void {
  getDb()
    .prepare(
      "UPDATE kanban_card_runs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?"
    )
    .run(
      "result" in outcome ? "completed" : "failed",
      "result" in outcome ? outcome.result : null,
      "error" in outcome ? outcome.error : null,
      Date.now(),
      id
    )
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
