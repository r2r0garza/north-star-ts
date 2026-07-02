# PR20: Durable memories — persisted, cross-conversation facts the agent remembers

> Status: **NOT STARTED**. A prerequisite sub-feature split out of `014` (context builder, Q2).
> `014` shipped the section framework; this fills the **durable-memories section** it reserved.
> Builds on the SQLite layer (`001`), `runAgentLoop` + the tool interface (`002`/`003`), the approval
> pipeline (a memory write is a gated side effect), and the `014` `ContextSection` seam.

## Context

Every conversation starts cold. Facts and preferences the user establishes ("always use pnpm", "the
API base URL is X", "I prefer terse commit messages", "the auth module lives in `src/auth`") are
lost the moment the conversation's recent-message window rolls past them — and are *never* available
to a *different* conversation. `014` reserved a **durable-memories section** for persisted,
cross-conversation facts but shipped it as a no-op: there's no memory store and no write path.

This PR adds **durable memories**: small, persisted facts the agent can write ("remember this") and
that are injected into future turns as a context section, scoped so they don't bleed where they
don't belong. It's the one deliberate exception to `014`'s "sections stay scoped" rule — and
precisely *because* it's an exception, the write must be explicit and the scoping must be tight.

**Explicit, gated writes — no silent profiling.** A memory is created only by an explicit act (a
`remember` tool the model calls when the user says "remember…", or a user UI action), and the write
goes through the **approval gate** like any other durable side effect. The agent does not silently
infer and persist facts about the user. Reads are advisory context, never asserted as ground truth.

## Goal

1. **Storage** for scoped memories (global / per-workspace / per-conversation), each a short fact
   with provenance and a timestamp.
2. **A write path**: a gated `remember` tool (model-invoked) + a read/delete surface so the user can
   see and prune what's stored (memories are durable and cross-conversation — they need to be
   inspectable and revocable).
3. **Wiring into `014`**: a `memoriesSection(scope)` renderer returning a `ContextSection` of the
   memories in scope, enabled by mode.

## Likely shape (hypothesis — revisit per Open questions)

### Schema (new migration — append to `db/migrations.ts` + a new `SCHEMA_V<n>`)
```sql
CREATE TABLE memories (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL CHECK (scope IN ('global','workspace','conversation')),
  workspace_id   TEXT REFERENCES workspaces(id) ON DELETE CASCADE,     -- set iff scope='workspace'
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE, -- set iff scope='conversation'
  content        TEXT NOT NULL,        -- the fact (short)
  source         TEXT,                 -- 'tool' | 'user' — how it was created
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_used_at   INTEGER               -- touched when injected, for future pruning/ranking
);
CREATE INDEX idx_memories_scope ON memories(scope, workspace_id, conversation_id);
```
Scoping mirrors the `action_allowlist` pattern (`002`): `global` always applies; `workspace` applies
when the turn's workspace matches; `conversation` applies to that conversation only. `ON DELETE
CASCADE` from workspace/conversation so a memory can't outlive its scope owner.

### Write path
- **`remember` tool** (gated): mode-gated like `todo_write` (interactive/north_star). Args:
  `content`, `scope` (default `workspace` when a workspace exists, else `conversation`). Routes
  through `ctx.gate` — the **write is the approved action** (a new approval kind, always prompts;
  never sandbox-downgraded), so the user confirms what gets persisted and at what scope. Mirrors the
  `run_todos_in_background` delegation-gate precedent (`016`).
- **Read/manage surface**: `db:memories:list` / `db:memories:delete` IPC + a small panel (or a
  Settings section) so stored memories are visible and revocable. Durable + cross-conversation means
  the user MUST be able to audit and delete them.

### Wiring into 014
- `context/sections.ts` gains `memoriesSection({ workspaceId, conversationId })`: selects in-scope
  memories, returns `{ name: "memories", priority: SECTION_PRIORITY.memories, content }` or null;
  touches `last_used_at` on the ones it injects.
- Add `memories` to `SECTION_PRIORITY` (high — user-stated facts are valuable; rank vs summary in
  build). Cap the number/size injected (see Open questions) so a large store can't blow the budget.

## Open questions to resolve BEFORE building
1. **Retrieval when the store grows.** All in-scope memories inline (simple, bounded while small) vs
   retrieval-ranked (recency / lexical match to the current turn). Lean **all-inline with a hard cap
   + recency order** for v1 (no embedding infra, per `008`/`014`); upgrade to ranked retrieval later.
   Define the cap and what happens past it (drop oldest / least-used, and log it).
2. **Write trigger — tool-only vs inferred.** v1 is **explicit only** (tool + user action); no
   silent inference. Confirm we're not folding in auto-extraction (that's a bigger, riskier feature).
3. **Dedup / update semantics.** Is "remember X" that contradicts an existing memory an update, a
   second row, or a prompt-to-replace? Lean: append, with the manage UI for cleanup; smart dedup
   later.
4. **Scope default & UX.** What scope does a bare "remember this" get — workspace (if present) or
   conversation? How does the user pick/override at write time (the approval card could carry it)?
5. **Approval kind.** Reuse an existing gate category or add a `memory_write` kind? It should always
   prompt (like `delegate` in `016`) and never be sandbox-auto-approved.
6. **Interaction with summaries (`019`).** A summary compresses one conversation's history; a memory
   is a deliberately-promoted cross-conversation fact. Keep them separate sections; a memory is not
   auto-derived from a summary.

## Verification (when built)
- "Remember that this project uses pnpm" → approval prompt → on approve, a memory row is written at
  the chosen scope; a **new** conversation in the same workspace sees it in its context section.
- Scoping holds: a `conversation` memory never appears in another conversation; a `workspace` memory
  never appears for a different workspace; `global` appears everywhere.
- The user can list and delete memories; a deleted memory stops being injected; deleting a
  workspace/conversation cascades its memories.
- The memories section respects the injection cap (a large store doesn't blow the budget; drops are
  logged), and reads are advisory (the agent doesn't assert a memory as fact without checking).
- `pnpm typecheck` + `pnpm build` clean; repo + tool + section tests; migration applies over the
  current version.

## Out of scope
- **Automatic / inferred memory extraction** — explicit writes only in v1 (the deliberate guardrail).
- **Embedding-based memory retrieval** — recency/lexical + cap first (embeddings deferred, per `008`).
- **Rolling conversation summaries** — that's `019`, a separate section/scope.
- **Sharing memories across users / sync** — single local user; no multi-user story here.
