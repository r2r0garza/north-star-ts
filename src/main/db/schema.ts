// v1 schema, applied as a single migration. Kept as a TS string export (not a
// .sql file) so it bundles cleanly without a runtime fs read.
//
// Conventions:
// - TEXT UUID primary keys (stable across export/sync) — except task_events,
//   which uses INTEGER AUTOINCREMENT for cheap monotonic log ordering.
// - Timestamps are INTEGER epoch ms, set by the repository layer.
// - Enums are TEXT with CHECK constraints mirroring the unions in types.ts.
// - JSON columns are TEXT; repositories serialize/parse.
export const SCHEMA_V1 = `
CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  mode          TEXT NOT NULL CHECK (mode IN ('chat','interactive','north_star')),
  title         TEXT,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_conversations_mode_updated ON conversations(mode, updated_at DESC);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content          TEXT,
  tool_calls       TEXT,
  tool_call_id     TEXT,
  tool_name        TEXT,
  token_estimate   INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_messages_conversation_seq ON messages(conversation_id, seq);

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title            TEXT,
  status           TEXT NOT NULL CHECK (status IN
                     ('queued','running','waiting_for_approval','interrupted',
                      'completed','failed','cancelled')),
  input            TEXT,
  result           TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_tasks_conversation ON tasks(conversation_id);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  payload     TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_task_events_task ON task_events(task_id, id);

CREATE TABLE task_checkpoints (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label       TEXT,
  state       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_task_checkpoints_task ON task_checkpoints(task_id, created_at);

CREATE TABLE approvals (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','denied')),
  request      TEXT,
  decision     TEXT,
  requested_at INTEGER NOT NULL,
  resolved_at  INTEGER
);
CREATE INDEX idx_approvals_task ON approvals(task_id);
CREATE INDEX idx_approvals_status ON approvals(status);
`

// v2: the action allowlist backing "always allow" decisions from the approval
// pipeline. Generic over tool/kind (shell command, file write, file edit) so a
// single table serves every gated tool. `identity` is the exact normalized
// action identity — matching is conservative equality, never a broad pattern
// like "git" or "rm". `workspace_path` (not a workspaces.id FK) because runChat
// receives a path; `agent_id` is reserved for a future agent abstraction.
export const SCHEMA_V2 = `
CREATE TABLE action_allowlist (
  id              TEXT PRIMARY KEY,
  tool            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  identity        TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN
                    ('once','conversation','workspace','agent','global')),
  workspace_path  TEXT,
  conversation_id TEXT,
  agent_id        TEXT,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);
CREATE INDEX idx_action_allowlist_lookup
  ON action_allowlist(kind, scope, workspace_path, identity);
`

// v3: the agent's per-conversation task list (the `todo_write` tool). A bounded
// planning scratchpad the model writes to and that is re-injected into the
// prompt each turn so a multi-step plan survives context compression. Composite
// PK (conversation_id, item_id) lets the model reuse simple ids ("1","2","3")
// per conversation without global collisions; `seq` is list order = priority.
// ON DELETE CASCADE cleans up with the conversation, like `messages`.
export const SCHEMA_V3 = `
CREATE TABLE todos (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN
                    ('pending','in_progress','completed','cancelled')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, item_id)
);
CREATE INDEX idx_todos_conversation_seq ON todos(conversation_id, seq);
`

// v4: the app's first persisted settings store. A small key-value table (one row
// per settings group, e.g. "execution", "permissions") with a JSON blob value,
// so adding a new setting is a code change in the settings service — not a
// migration. Global scope for now (no workspace/conversation FK); the table can
// grow a scope column later if per-workspace overrides are needed.
export const SCHEMA_V4 = `
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

// v5: LLM provider accounts + their models (the 004 LLM slice). A provider
// account is one configured connection to a gateway (Portkey or an
// OpenAI-compatible endpoint that routes through it). The API key is NEVER stored
// here in plaintext: `encrypted_key` holds Electron safeStorage ciphertext,
// decrypted only in the main process when building the LLM client. Models belong
// to an account (ON DELETE CASCADE) and track their `origin` so a gateway
// re-import can refresh fetched rows without clobbering user-added ones.
// `model_name` is an optional custom display label; the UI falls back to
// `model_id` when it's null. The active provider/model selection is NOT here —
// it lives in the `settings` table's `llm` blob (global scope, like the rest).
export const SCHEMA_V5 = `
CREATE TABLE provider_accounts (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL CHECK (provider IN
                  ('portkey','openai_compatible','openai','anthropic','google','azure_openai')),
  display_name  TEXT NOT NULL,
  base_url      TEXT,
  encrypted_key BLOB,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

CREATE TABLE models (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL,
  model_name  TEXT,
  origin      TEXT NOT NULL CHECK (origin IN ('manual','gateway','seeded')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (account_id, model_id)
);
CREATE INDEX idx_models_account ON models(account_id);
`

// v6: per-conversation LLM selection. A conversation can pin which provider
// account + model it uses, so different sessions (e.g. a Chat with provider A and
// a North Star with provider B) keep independent models without a global switch.
// Both nullable — null means "use the default" (the settings `llm` blob). Stored
// as the account id + the model's gateway id string (not the models.id row id),
// matching how runChat calls the gateway. No FK on account_id: a deleted account
// falls back to the default at resolve time rather than cascade-nulling here.
export const SCHEMA_V6 = `
ALTER TABLE conversations ADD COLUMN account_id TEXT;
ALTER TABLE conversations ADD COLUMN model_id TEXT;
`

// v7: durable tasks run in their OWN forked conversation so a background worker
// never interleaves its model/tool messages with the live chat transcript (which
// caused races, mixed context, and duplicate answers when a task and a live turn
// shared one message log). A task's `conversation_id` is now its PRIVATE worker
// transcript; `source_conversation_id` links back to the live conversation where
// the user started it, so the Workspace Activity panel can list a conversation's
// tasks while their messages stay isolated. Nullable + ON DELETE SET NULL so a
// task outlives the deletion of its source chat (its own transcript is what the
// runner needs). Backfilled to conversation_id for any pre-v7 task so existing
// rows keep a sane source.
export const SCHEMA_V7 = `
ALTER TABLE tasks ADD COLUMN source_conversation_id TEXT
  REFERENCES conversations(id) ON DELETE SET NULL;
UPDATE tasks SET source_conversation_id = conversation_id
  WHERE source_conversation_id IS NULL;
CREATE INDEX idx_tasks_source_conversation ON tasks(source_conversation_id);
`
