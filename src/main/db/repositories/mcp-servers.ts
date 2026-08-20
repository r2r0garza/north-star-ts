import { getDb } from "../connection"

// Per-machine MCP server state (SCHEMA_V25 `mcp_server_state`), keyed by the
// server `name` (the mcp.json object key + tool prefix). Server DEFINITIONS live
// in files (agent/mcp/); this table holds ONLY the enabled override and the
// encrypted OAuth secrets — the two things that can't live in a committable file.
//
// Effective enabled state: a row exists here only once toggled (or OAuth stored),
// so ABSENT means "never touched → default ON". `isEnabled` and `enabledMap`
// encode that default; callers never treat a missing row as OFF.

interface StateRow {
  name: string
  enabled: number
  oauth_tokens: Buffer | null
  oauth_client: Buffer | null
  created_at: number
  updated_at: number
}

// Upsert the row for `name`, applying a patch and stamping timestamps. Keeps the
// existing values for columns not in the patch. The single write path so the
// default-ON invariant (a fresh row starts enabled=1 unless the patch says else)
// is centralized.
function upsert(
  name: string,
  patch: {
    enabled?: boolean
    oauthTokens?: Buffer | null
    oauthClient?: Buffer | null
  }
): void {
  const db = getDb()
  const now = Date.now()
  const existing = db
    .prepare("SELECT * FROM mcp_server_state WHERE name = ?")
    .get(name) as StateRow | undefined
  const enabled =
    patch.enabled !== undefined
      ? patch.enabled
        ? 1
        : 0
      : (existing?.enabled ?? 1)
  const oauthTokens =
    patch.oauthTokens !== undefined
      ? patch.oauthTokens
      : (existing?.oauth_tokens ?? null)
  const oauthClient =
    patch.oauthClient !== undefined
      ? patch.oauthClient
      : (existing?.oauth_client ?? null)
  db.prepare(
    `INSERT INTO mcp_server_state (name, enabled, oauth_tokens, oauth_client, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       enabled = excluded.enabled,
       oauth_tokens = excluded.oauth_tokens,
       oauth_client = excluded.oauth_client,
       updated_at = excluded.updated_at`
  ).run(
    name,
    enabled,
    oauthTokens,
    oauthClient,
    existing?.created_at ?? now,
    now
  )
}

// Whether a server is enabled. Absent row → ON (default), per the invariant.
export function isEnabled(name: string): boolean {
  const row = getDb()
    .prepare("SELECT enabled FROM mcp_server_state WHERE name = ?")
    .get(name) as Pick<StateRow, "enabled"> | undefined
  return row ? row.enabled !== 0 : true
}

// enabled state for a set of names, resolving the default-ON for absent rows.
// Handy for the loader's join over file-discovered servers.
export function enabledMap(names: string[]): Map<string, boolean> {
  const map = new Map<string, boolean>()
  for (const name of names) map.set(name, isEnabled(name))
  return map
}

// Whether a completed OAuth token set is stored for a server.
export function hasOauth(name: string): boolean {
  const row = getDb()
    .prepare("SELECT oauth_tokens FROM mcp_server_state WHERE name = ?")
    .get(name) as Pick<StateRow, "oauth_tokens"> | undefined
  return !!row?.oauth_tokens && row.oauth_tokens.length > 0
}

// Set of names that have OAuth stored, for the loader's join (one query).
export function oauthNameSet(): Set<string> {
  const rows = getDb()
    .prepare(
      "SELECT name FROM mcp_server_state WHERE oauth_tokens IS NOT NULL AND length(oauth_tokens) > 0"
    )
    .all() as Array<Pick<StateRow, "name">>
  return new Set(rows.map((r) => r.name))
}

export function setEnabled(name: string, enabled: boolean): void {
  upsert(name, { enabled })
}

// ── Secret blob access (main-process only) ──────────────────────────────────
// Move opaque ciphertext in/out of the row. The secrets layer owns the
// safeStorage encrypt/decrypt around these; this repo never sees plaintext.

export function getOauthTokens(name: string): Buffer | undefined {
  const row = getDb()
    .prepare("SELECT oauth_tokens FROM mcp_server_state WHERE name = ?")
    .get(name) as Pick<StateRow, "oauth_tokens"> | undefined
  return row?.oauth_tokens ?? undefined
}

export function setOauthTokens(name: string, ciphertext: Buffer): void {
  upsert(name, { oauthTokens: ciphertext })
}

export function getOauthClient(name: string): Buffer | undefined {
  const row = getDb()
    .prepare("SELECT oauth_client FROM mcp_server_state WHERE name = ?")
    .get(name) as Pick<StateRow, "oauth_client"> | undefined
  return row?.oauth_client ?? undefined
}

export function setOauthClient(name: string, ciphertext: Buffer): void {
  upsert(name, { oauthClient: ciphertext })
}

// Forget stored OAuth secrets (re-auth from scratch). Leaves the enabled flag.
export function clearOauth(name: string): void {
  upsert(name, { oauthTokens: null, oauthClient: null })
}
