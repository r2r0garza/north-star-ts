import { randomUUID } from "crypto"
import { getDb } from "../connection"
import {
  asFilter,
  type KanbanBoard,
  type KanbanCard,
  type KanbanColumn,
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
  created_at: number
  updated_at: number
}

function toCard(r: CardRow): KanbanCard {
  return {
    id: r.id,
    boardId: r.board_id,
    externalId: r.external_id,
    item: parse(r.item) as KanbanItem,
    columnId: r.column_id,
    status: r.status === "unmatched" ? "unmatched" : "active",
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

// Create or update a board's definition. Columns are replaced by name list;
// cards in a removed column fall back to the Inbox (ON DELETE SET NULL).
// shortcut: replace-all columns, fine while columns hold no runs; key by id in 136.2.
export function saveBoard(input: {
  id?: string
  name: string
  workspace: string | null
  source: KanbanSource
  filter: KanbanIntakeFilter
  syncIntervalMs?: number
  columns: string[]
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
    const existing = listColumns(id)
    const same =
      existing.length === input.columns.length &&
      existing.every((c, i) => c.name === input.columns[i])
    if (!same) {
      db.prepare("DELETE FROM kanban_columns WHERE board_id = ?").run(id)
      const insert = db.prepare(
        "INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)"
      )
      input.columns.forEach((name, i) => insert.run(randomUUID(), id, name, i))
    }
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

export function listColumns(boardId: string): KanbanColumn[] {
  return (
    getDb()
      .prepare(
        "SELECT id, board_id, name, position FROM kanban_columns WHERE board_id = ? ORDER BY position"
      )
      .all(boardId) as Array<{
      id: string
      board_id: string
      name: string
      position: number
    }>
  ).map((r) => ({
    id: r.id,
    boardId: r.board_id,
    name: r.name,
    position: r.position,
  }))
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
      if (card.columnId === null) {
        db.prepare("DELETE FROM kanban_cards WHERE id = ?").run(card.id)
      } else if (card.status !== "unmatched") {
        db.prepare(
          "UPDATE kanban_cards SET status = 'unmatched', updated_at = ? WHERE id = ?"
        ).run(now, card.id)
      }
    }
  })()
}
