import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { ModelEntry, ModelOrigin } from "../types"

// Models belonging to a provider account (SCHEMA_V5). The local list is the
// source of truth: the user adds/edits/deletes ids by hand, and an optional
// gateway import merges fetched ids in as `origin:'gateway'` WITHOUT deleting
// user-added rows. `model_name` is an optional custom display label; the UI
// falls back to `model_id` when null. UNIQUE(account_id, model_id) makes the
// merge a per-id upsert.

interface ModelRow {
  id: string
  account_id: string
  model_id: string
  model_name: string | null
  origin: ModelOrigin
  created_at: number
  updated_at: number
}

function toModel(row: ModelRow): ModelEntry {
  return {
    id: row.id,
    accountId: row.account_id,
    modelId: row.model_id,
    modelName: row.model_name,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getModel(id: string): ModelEntry | undefined {
  const row = getDb()
    .prepare("SELECT * FROM models WHERE id = ?")
    .get(id) as ModelRow | undefined
  return row ? toModel(row) : undefined
}

export function listModels(accountId: string): ModelEntry[] {
  const rows = getDb()
    .prepare("SELECT * FROM models WHERE account_id = ? ORDER BY created_at ASC")
    .all(accountId) as ModelRow[]
  return rows.map(toModel)
}

export interface AddModelInput {
  accountId: string
  modelId: string
  modelName?: string | null
  origin?: ModelOrigin
}

// Add one model id. Ignores a duplicate (account_id, model_id) so re-adding is a
// no-op rather than an error; returns the existing or newly-created row.
export function addModel(input: AddModelInput): ModelEntry {
  const existing = getDb()
    .prepare("SELECT * FROM models WHERE account_id = ? AND model_id = ?")
    .get(input.accountId, input.modelId) as ModelRow | undefined
  if (existing) return toModel(existing)
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO models (id, account_id, model_id, model_name, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.accountId, input.modelId, input.modelName ?? null, input.origin ?? "manual", now, now)
  return getModel(id)!
}

// Edit a model's id and/or custom display name. Editing the id leaves origin
// untouched (a user-renamed gateway id is still "gateway").
export function updateModel(
  id: string,
  patch: { modelId?: string; modelName?: string | null }
): ModelEntry {
  const sets: string[] = []
  const args: unknown[] = []
  if (patch.modelId !== undefined) {
    sets.push("model_id = ?")
    args.push(patch.modelId)
  }
  if (patch.modelName !== undefined) {
    sets.push("model_name = ?")
    args.push(patch.modelName)
  }
  if (sets.length > 0) {
    sets.push("updated_at = ?")
    args.push(Date.now())
    args.push(id)
    getDb().prepare(`UPDATE models SET ${sets.join(", ")} WHERE id = ?`).run(...args)
  }
  return getModel(id)!
}

export function deleteModel(id: string): void {
  getDb().prepare("DELETE FROM models WHERE id = ?").run(id)
}

// Merge gateway-fetched ids into the account's list. Each id is inserted as
// `origin:'gateway'` if new; existing rows (any origin) are left untouched, so a
// user-added or renamed id survives a re-import. Returns the merged list. The
// caller decides what to do on fetch failure — this only ever adds.
export function mergeGatewayModels(accountId: string, modelIds: string[]): ModelEntry[] {
  const db = getDb()
  const now = Date.now()
  const tx = db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO models (id, account_id, model_id, model_name, origin, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'gateway', ?, ?)
       ON CONFLICT(account_id, model_id) DO NOTHING`
    )
    for (const modelId of modelIds) {
      const trimmed = modelId.trim()
      if (trimmed) insert.run(randomUUID(), accountId, trimmed, now, now)
    }
  })
  tx()
  return listModels(accountId)
}
