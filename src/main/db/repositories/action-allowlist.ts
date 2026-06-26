import { randomUUID } from "crypto"
import { getDb } from "../connection"
import type { ActionAllowlistRule, AllowlistScope } from "../types"

// Persistence for "always allow" decisions from the approval pipeline. Matching
// is deliberately conservative: an exact `identity` equality plus scope match —
// never a broad prefix/glob. PR2 only writes `workspace`-scoped rules, but the
// table and repo support every scope so future UI needs no schema change.

interface AllowlistRow {
  id: string
  tool: string
  kind: string
  identity: string
  scope: AllowlistScope
  workspace_path: string | null
  conversation_id: string | null
  agent_id: string | null
  created_at: number
  last_used_at: number | null
}

function toRule(row: AllowlistRow): ActionAllowlistRule {
  return {
    id: row.id,
    tool: row.tool,
    kind: row.kind,
    identity: row.identity,
    scope: row.scope,
    workspacePath: row.workspace_path,
    conversationId: row.conversation_id,
    agentId: row.agent_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }
}

export function addRule(input: {
  tool: string
  kind: string
  identity: string
  scope: AllowlistScope
  workspacePath?: string | null
  conversationId?: string | null
  agentId?: string | null
}): ActionAllowlistRule {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO action_allowlist
         (id, tool, kind, identity, scope, workspace_path, conversation_id, agent_id, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.tool,
      input.kind,
      input.identity,
      input.scope,
      input.workspacePath ?? null,
      input.conversationId ?? null,
      input.agentId ?? null,
      now,
      null
    )
  const row = getDb()
    .prepare("SELECT * FROM action_allowlist WHERE id = ?")
    .get(id) as AllowlistRow
  return toRule(row)
}

// Find a remembered rule covering this action in the given scope context.
// Conservative: exact (kind, identity) equality. Workspace scope additionally
// requires the workspace path to match; conversation scope the conversation id.
// Touches last_used_at on a hit so stale rules are identifiable later.
export function findMatch(
  kind: string,
  identity: string,
  opts: { workspacePath?: string | null; conversationId?: string | null } = {}
): ActionAllowlistRule | undefined {
  const rows = getDb()
    .prepare(
      "SELECT * FROM action_allowlist WHERE kind = ? AND identity = ? ORDER BY created_at DESC"
    )
    .all(kind, identity) as AllowlistRow[]

  for (const row of rows) {
    if (row.scope === "global") return touch(toRule(row))
    if (
      row.scope === "workspace" &&
      opts.workspacePath &&
      row.workspace_path === opts.workspacePath
    ) {
      return touch(toRule(row))
    }
    if (
      row.scope === "conversation" &&
      opts.conversationId &&
      row.conversation_id === opts.conversationId
    ) {
      return touch(toRule(row))
    }
    // `once` and `agent` scopes are not matched here: `once` is never
    // persisted, and `agent` is reserved until the agent abstraction lands.
  }
  return undefined
}

function touch(rule: ActionAllowlistRule): ActionAllowlistRule {
  touchLastUsed(rule.id)
  return rule
}

export function touchLastUsed(id: string): void {
  getDb()
    .prepare("UPDATE action_allowlist SET last_used_at = ? WHERE id = ?")
    .run(Date.now(), id)
}
