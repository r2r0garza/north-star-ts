import { getDb } from "../connection"

// The settings store is a flat key → JSON-string map (see SCHEMA_V4). This repo
// deals only in raw strings; (de)serialization and defaults live in the settings
// service (src/main/settings/service.ts), so the table stays a dumb blob store.

interface SettingRow {
  key: string
  value: string
  updated_at: number
}

export function getSetting(key: string): string | undefined {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as Pick<SettingRow, "value"> | undefined
  return row?.value
}

// Upsert: insert, or replace the value (and bump updated_at) if the key exists.
export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, Date.now())
}

export function getAll(): Record<string, string> {
  const rows = getDb()
    .prepare("SELECT key, value FROM settings")
    .all() as Array<Pick<SettingRow, "key" | "value">>
  const out: Record<string, string> = {}
  for (const row of rows) out[row.key] = row.value
  return out
}
