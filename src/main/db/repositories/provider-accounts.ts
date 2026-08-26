import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { ApiMode, Provider, ProviderAccount } from "../types"

// Persisted LLM provider connections (SCHEMA_V5). The API key is stored as a
// safeStorage-encrypted BLOB in `encrypted_key` and NEVER returned in the public
// ProviderAccount shape — callers get `hasKey` only. The raw ciphertext is read
// solely by the secrets layer (getEncryptedKey) inside the main process, decrypted
// just-in-time when building the LLM client. Nothing here touches plaintext.

interface ProviderAccountRow {
  id: string
  provider: Provider
  display_name: string
  base_url: string | null
  encrypted_key: Buffer | null
  api_mode: ApiMode
  enabled: number
  position: number
  created_at: number
  last_used_at: number | null
}

// Map a row to the public shape: the ciphertext BLOB is reduced to a boolean so
// it can never leak past the repo (and thus never over IPC to the renderer).
function toAccount(row: ProviderAccountRow): ProviderAccount {
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    baseUrl: row.base_url,
    hasKey: row.encrypted_key != null && row.encrypted_key.length > 0,
    enabled: row.enabled === 1,
    position: row.position,
    apiMode: row.api_mode,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

export function getAccount(id: string): ProviderAccount | undefined {
  const row = getDb()
    .prepare("SELECT * FROM provider_accounts WHERE id = ?")
    .get(id) as ProviderAccountRow | undefined
  return row ? toAccount(row) : undefined
}

export function listAccounts(): ProviderAccount[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM provider_accounts ORDER BY position ASC, created_at ASC"
    )
    .all() as ProviderAccountRow[]
  return rows.map(toAccount)
}

export interface CreateAccountInput {
  provider: Provider
  displayName: string
  baseUrl?: string | null
  // Defaults to "completions" when omitted (the column default backs this up).
  apiMode?: ApiMode
}

export function createAccount(input: CreateAccountInput): ProviderAccount {
  const id = randomUUID()
  const now = Date.now()
  const max = getDb()
    .prepare("SELECT MAX(position) AS value FROM provider_accounts")
    .get() as { value: number | null }
  const position = (max.value ?? -1) + 1
  getDb()
    .prepare(
      `INSERT INTO provider_accounts (id, provider, display_name, base_url, encrypted_key, api_mode, position, created_at, last_used_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL)`
    )
    .run(
      id,
      input.provider,
      input.displayName,
      input.baseUrl ?? null,
      input.apiMode ?? "completions",
      position,
      now
    )
  return getAccount(id)!
}

// Persist a complete provider ordering atomically. Requiring the exact current
// id set prevents a stale renderer from silently dropping or duplicating an
// account if another write landed before its drag ended.
export function reorderAccounts(orderedIds: string[]): ProviderAccount[] {
  const db = getDb()
  db.transaction(() => {
    const existing = db
      .prepare("SELECT id FROM provider_accounts")
      .all() as Array<{ id: string }>
    const expected = new Set(existing.map((row) => row.id))
    if (
      orderedIds.length !== expected.size ||
      new Set(orderedIds).size !== orderedIds.length ||
      orderedIds.some((id) => !expected.has(id))
    ) {
      throw new Error("Provider order is stale; reload Settings and try again.")
    }
    const update = db.prepare(
      "UPDATE provider_accounts SET position = ? WHERE id = ?"
    )
    orderedIds.forEach((id, position) => update.run(position, id))
  })()
  return listAccounts()
}

// Update the non-secret fields. The key is changed only via setEncryptedKey/
// clearKey so secret handling stays in one place.
export function updateAccount(
  id: string,
  patch: {
    displayName?: string
    baseUrl?: string | null
    apiMode?: ApiMode
    enabled?: boolean
  }
): ProviderAccount {
  const sets: string[] = []
  const args: unknown[] = []
  if (patch.displayName !== undefined) {
    sets.push("display_name = ?")
    args.push(patch.displayName)
  }
  if (patch.baseUrl !== undefined) {
    sets.push("base_url = ?")
    args.push(patch.baseUrl)
  }
  if (patch.apiMode !== undefined) {
    sets.push("api_mode = ?")
    args.push(patch.apiMode)
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?")
    args.push(patch.enabled ? 1 : 0)
  }
  if (sets.length > 0) {
    args.push(id)
    getDb()
      .prepare(`UPDATE provider_accounts SET ${sets.join(", ")} WHERE id = ?`)
      .run(...args)
  }
  return getAccount(id)!
}

export function deleteAccount(id: string): void {
  // Models cascade-delete via the FK.
  getDb().prepare("DELETE FROM provider_accounts WHERE id = ?").run(id)
}

export function touchLastUsed(id: string): void {
  getDb()
    .prepare("UPDATE provider_accounts SET last_used_at = ? WHERE id = ?")
    .run(Date.now(), id)
}

// ── Secret blob access (main-process only) ──────────────────────────────────
// These move opaque ciphertext in/out of the row. The secrets layer owns the
// safeStorage encrypt/decrypt around them; this repo never sees plaintext.

export function getEncryptedKey(id: string): Buffer | undefined {
  const row = getDb()
    .prepare("SELECT encrypted_key FROM provider_accounts WHERE id = ?")
    .get(id) as Pick<ProviderAccountRow, "encrypted_key"> | undefined
  return row?.encrypted_key ?? undefined
}

export function setEncryptedKey(id: string, ciphertext: Buffer): void {
  getDb()
    .prepare("UPDATE provider_accounts SET encrypted_key = ? WHERE id = ?")
    .run(ciphertext, id)
}

export function clearKey(id: string): void {
  getDb()
    .prepare("UPDATE provider_accounts SET encrypted_key = NULL WHERE id = ?")
    .run(id)
}
