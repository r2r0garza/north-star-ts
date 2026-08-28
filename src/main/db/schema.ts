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

// v8: the workspace index (plan 008). Four tables keyed by workspace_id hold a
// deterministic, incremental, resumable snapshot of a workspace so the agent can
// answer immediately from a cheap structured overview instead of re-walking the
// live filesystem. The index build runs as a durable 009 task (queue/resume/
// cancel/pause reused); this schema holds only the index-specific state — the run
// *lifecycle* lives on the task, not here.
//
// Also widens tasks.status to add 'paused' (plan 008: pause is a real task state,
// not an ad-hoc flag). SQLite can't ALTER a CHECK constraint, so tasks is rebuilt
// (create → copy → drop → rename). runMigrations disables foreign_keys around the
// migration loop so DROP TABLE tasks doesn't cascade-delete task_events/approvals/
// task_checkpoints; the rename preserves every id so child FKs stay valid.
export const SCHEMA_V8 = `
CREATE TABLE tasks_new (
  id                     TEXT PRIMARY KEY,
  conversation_id        TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  title                  TEXT,
  status                 TEXT NOT NULL CHECK (status IN
                           ('queued','running','waiting_for_approval','interrupted',
                            'completed','failed','cancelled','paused')),
  input                  TEXT,
  result                 TEXT,
  error                  TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
INSERT INTO tasks_new
  (id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at)
  SELECT id, conversation_id, source_conversation_id, title, status, input, result, error, created_at, updated_at
  FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX idx_tasks_conversation ON tasks(conversation_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_source_conversation ON tasks(source_conversation_id);

-- Per-workspace indexing state: links to the 009 task, holds resumable progress
-- and the per-workspace enable toggle. Status lives on the task; this is the
-- cheap workspace-scoped record (one per workspace) for progress + the flag.
CREATE TABLE index_runs (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id         TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  stage           TEXT NOT NULL CHECK (stage IN ('file_map','metadata','symbols','embeddings')),
  priority        TEXT NOT NULL CHECK (priority IN ('low','high')),
  cursor          TEXT,
  files_scanned   INTEGER NOT NULL DEFAULT 0,
  files_total     INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (workspace_id)
);
CREATE INDEX idx_index_runs_workspace ON index_runs(workspace_id);

-- Stage 1: the file map. One row per tracked file; hash drives incremental skip.
CREATE TABLE index_files (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  ext           TEXT,
  size          INTEGER NOT NULL,
  mtime         INTEGER NOT NULL,
  hash          TEXT NOT NULL,
  indexed_stage TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (workspace_id, path)
);
CREATE INDEX idx_index_files_workspace ON index_files(workspace_id);

-- Stage 2: parsed metadata (one row per key doc, value is JSON).
CREATE TABLE index_metadata (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  path          TEXT,
  value         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_index_metadata_workspace ON index_metadata(workspace_id, kind);

-- Stage 3: symbols & imports (unpopulated in slice 1; schema leaves room).
CREATE TABLE index_symbols (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id       TEXT NOT NULL REFERENCES index_files(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  line          INTEGER,
  detail        TEXT,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_index_symbols_workspace_name ON index_symbols(workspace_id, name);
CREATE INDEX idx_index_symbols_file ON index_symbols(file_id);
`

// v9 (plan 022): reap durable-task state orphaned by pre-fix session deletes.
// tasks.source_conversation_id is ON DELETE SET NULL, so deleting the originating
// session left the task, its forked worker conversation, and all child rows
// behind — invisible (the activity panel queries by source_conversation_id) and,
// for auto-resume kinds, a runaway with no UI handle. The delete path is fixed
// going forward (runner.deleteSourceConversation); this sweeps existing orphans.
//
// runMigrations runs the loop with foreign_keys OFF (see migrations.ts), so a
// plain DELETE does NOT cascade — every child is deleted explicitly. Orphans are
// collected transitively via a recursive CTE (a reaped worker conversation may
// itself have sourced nested tasks). The SEED of the recursion excludes
// workspace_index: it's born source-less by design and is observable in the
// indexing panel (not an orphan) — mirroring the hasIndependentSurface capability
// flag at the SQL level. The recursive step has no kind filter, so every task
// descending from a reaped worker conversation is also reaped, leaving no
// dangling source_conversation_id for the post-migration foreign_key_check.
export const SCHEMA_V9 = `
CREATE TEMP TABLE _reap_convs AS
WITH RECURSIVE r(conv) AS (
  SELECT conversation_id FROM tasks
    WHERE source_conversation_id IS NULL
      AND COALESCE(json_extract(input, '$.kind'), 'agent_chat') <> 'workspace_index'
  UNION
  SELECT t.conversation_id FROM tasks t JOIN r ON t.source_conversation_id = r.conv
)
SELECT conv FROM r;

DELETE FROM task_events WHERE task_id IN
  (SELECT id FROM tasks WHERE conversation_id IN (SELECT conv FROM _reap_convs));
DELETE FROM task_checkpoints WHERE task_id IN
  (SELECT id FROM tasks WHERE conversation_id IN (SELECT conv FROM _reap_convs));
DELETE FROM approvals WHERE task_id IN
  (SELECT id FROM tasks WHERE conversation_id IN (SELECT conv FROM _reap_convs));
DELETE FROM messages WHERE conversation_id IN (SELECT conv FROM _reap_convs);
DELETE FROM todos    WHERE conversation_id IN (SELECT conv FROM _reap_convs);
DELETE FROM tasks    WHERE conversation_id IN (SELECT conv FROM _reap_convs);
DELETE FROM conversations WHERE id IN (SELECT conv FROM _reap_convs);
DROP TABLE _reap_convs;
`

// v10: the rolling conversation summary (plan 019). One row per conversation — a
// compact, periodically-regenerated digest of the turns that have (or will soon)
// scroll out of the ContextBuilder's recent-message walk-back, so a long
// conversation keeps its early thread (decisions, constraints, open threads).
// A dedicated table (not a column on conversations) keeps the digest + its
// bookkeeping off the hot conversation row and carries the covered range.
//
//   covers_through — the highest messages.seq folded into `summary`. The
//     summarizer regenerates INCREMENTALLY (prior summary + only the turns with
//     seq > covers_through), and the trigger debounces off how far the tail has
//     grown past it. The walk-back is additive and independent: it may re-include
//     recent turns already in the summary (safe overlap, never a gap).
//   message_count — turns folded so far (surfaced for observability/thresholds).
//   token_estimate — the digest's cost via the shared TokenCounter, so the
//     builder budgets the section without re-counting.
//
// ON DELETE CASCADE reaps the row with its conversation (like messages/todos).
export const SCHEMA_V10 = `
CREATE TABLE conversation_summaries (
  conversation_id  TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary          TEXT NOT NULL,
  covers_through   INTEGER NOT NULL,
  message_count    INTEGER NOT NULL,
  token_estimate   INTEGER,
  updated_at       INTEGER NOT NULL
);
`

// v11: which OpenAI wire API a provider account speaks. 'completions' is the
// universal /chat/completions path (all current providers); 'responses' is
// reserved for a future OpenAI Responses (/responses) adapter. Nullable with a
// default so existing rows read as 'completions' and the app never has to
// backfill. openai/openai_compatible now route through the OpenAI SDK (Bearer
// auth on every request); portkey keeps the Portkey SDK.
export const SCHEMA_V11 = `
ALTER TABLE provider_accounts ADD COLUMN api_mode TEXT NOT NULL DEFAULT 'completions'
  CHECK (api_mode IN ('completions','responses'));
`

// v12: projects — a user-created way to GROUP conversations. A project optionally
// carries a workspace (its default directory): with one, it can back Chat,
// Interactive, and North Star conversations, and starting a fresh workspace-view
// conversation in the project auto-adopts that directory (no per-session picker);
// without one, the project is Chat-only (grouping only). `workspace_id` reuses the
// existing deduped workspaces table, so the same row backs the project and its
// conversations and indexing (keyed on workspace_id) works unchanged. ON DELETE
// SET NULL so clearing a workspace just drops the project's default directory.
//
// conversations gains a nullable `project_id` (ON DELETE SET NULL, like V7's
// source_conversation_id): existing rows read as NULL and surface under a "No
// Project" bucket, so the migration is backward compatible. Deleting a project
// keeps its conversations — they fall back to "No Project" — rather than cascading.
export const SCHEMA_V12 = `
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  workspace_id  TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
ALTER TABLE conversations ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE SET NULL;
`

// v13: custom agents — a conversation can select a user-defined agent (a
// "fleet" member) whose definition lives in a `<name>.agent.md` file on disk
// (discovered under ~/.<system>/agents, <workspace>/.github/agents, and
// <workspace>/.<system>/agents). The selected agent's markdown body is prepended
// to the mode system prompt, and its frontmatter narrows the tools/skills the
// turn is offered. Stored by NAME (not an id/FK) because agent definitions are
// files on disk, not DB rows — the name is the on-disk identifier and is
// re-resolved per turn. Nullable: existing rows read NULL and run the built-in
// main agent exactly as before, so the migration is backward compatible.
export const SCHEMA_V13 = `
ALTER TABLE conversations ADD COLUMN agent_name TEXT;
`

// v14: pinned conversations — a conversation can be pinned to float to the top of
// its group in the sidebar (its project's section, or the ungrouped "No Project"
// bucket). SQLite has no boolean; 0 = unpinned, 1 = pinned. NOT NULL DEFAULT 0 so
// existing rows read as unpinned and keep their natural recency order — backward
// compatible. Ordering among pinned items stays recency-preserving (sorted in the
// renderer), so no ordering column is needed here.
export const SCHEMA_V14 = `
ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
`

// v15: the Process engine (plan 025). A user-authored agentic DAG — reusable
// process *definitions* (phases + dependency edges + per-phase agent pool +
// routing/gate/fan-out) split from *run* instances (one per execution, each
// carrying per-phase execution state). Pure CREATE TABLE, so it's safe under the
// foreign_keys=OFF migration loop (no table rebuild). First real consumer of
// task_checkpoints — the orchestrator snapshots its DAG frontier there.
//
// Notes on the shape:
// - The definition/run split lets a Process be authored once and re-run many times.
// - The run<->backing-task link is bidirectional but not circular: process_runs
//   .task_id -> tasks.id (ON DELETE SET NULL) lets a control verb resolve a run's
//   backing task; the task's input blob carries { kind, processRunId } (a JSON
//   string, not an FK) so the executor finds its run on (re)start — the 015
//   producer contract. tasks has no FK back to process_runs.
// - status columns are bare TEXT (no CHECK): the tasks table needed a painful v8
//   rebuild to widen a status CHECK, so process statuses are validated in the repo
//   layer instead (mirrors the enums in types.ts).
// - process_phase_agents is the agent POOL for a phase: one row (routing='single')
//   or N rows (routing='dispatch'); skills/tools are JSON tri-state overrides
//   (NULL = the agent's own, matching the .agent.md frontmatter semantics).
// - process_phase_runs.parent_id + process_phases.fan_out + the on_each_subtask
//   trigger are migrated now but only exercised by the 025.1/025.2 fast-follows.
export const SCHEMA_V15 = `
CREATE TABLE process_definitions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE process_phases (
  id          TEXT PRIMARY KEY,
  process_id  TEXT NOT NULL REFERENCES process_definitions(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  routing     TEXT NOT NULL DEFAULT 'single' CHECK (routing IN ('single','dispatch')),
  gate_policy TEXT NOT NULL DEFAULT 'auto'   CHECK (gate_policy IN ('auto','approve')),
  fan_out     INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL,
  UNIQUE (process_id, key)
);

CREATE TABLE process_phase_agents (
  id         TEXT PRIMARY KEY,
  phase_id   TEXT NOT NULL REFERENCES process_phases(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  skills     TEXT,
  tools      TEXT,
  position   INTEGER NOT NULL
);

CREATE TABLE process_edges (
  id            TEXT PRIMARY KEY,
  process_id    TEXT NOT NULL REFERENCES process_definitions(id) ON DELETE CASCADE,
  from_phase_id TEXT NOT NULL REFERENCES process_phases(id) ON DELETE CASCADE,
  to_phase_id   TEXT NOT NULL REFERENCES process_phases(id) ON DELETE CASCADE,
  trigger       TEXT NOT NULL DEFAULT 'on_complete'
                  CHECK (trigger IN ('on_complete','on_each_subtask'))
);

CREATE TABLE process_runs (
  id                     TEXT PRIMARY KEY,
  process_id             TEXT REFERENCES process_definitions(id) ON DELETE SET NULL,
  source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  task_id                TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  objective              TEXT,
  status                 TEXT NOT NULL,
  started_at             INTEGER,
  finished_at            INTEGER,
  created_at             INTEGER NOT NULL
);

CREATE TABLE process_phase_runs (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES process_runs(id) ON DELETE CASCADE,
  phase_id    TEXT NOT NULL REFERENCES process_phases(id),
  parent_id   TEXT REFERENCES process_phase_runs(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_name  TEXT,
  iteration   INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  started_at  INTEGER,
  finished_at INTEGER
);

CREATE INDEX idx_process_phases_process ON process_phases(process_id);
CREATE INDEX idx_process_phase_agents_phase ON process_phase_agents(phase_id);
CREATE INDEX idx_process_edges_process ON process_edges(process_id);
CREATE INDEX idx_process_runs_process ON process_runs(process_id);
CREATE INDEX idx_process_phase_runs_run ON process_phase_runs(run_id);
CREATE INDEX idx_process_phase_runs_parent ON process_phase_runs(parent_id);
`

// v16 (plan 026): give a process run its OWN workspace. A run started from the
// Process screen has no source conversation (sourceConversationId = null), so its
// phase workers resolved `workspace = undefined` and every file/shell tool failed
// closed — the run had nowhere to write. Store the picked folder as a workspaces.id
// (deduped on path via upsertWorkspace, like conversations/projects), resolved to a
// directory for every phase worker. Nullable FK, ON DELETE SET NULL — matches
// process_runs' existing FKs; old rows read NULL and still render. Pure ADD COLUMN,
// safe under the foreign_keys=OFF migration loop (no table rebuild).
export const SCHEMA_V16 = `
ALTER TABLE process_runs ADD COLUMN workspace_id TEXT
  REFERENCES workspaces(id) ON DELETE SET NULL;
`

// v17 (plan 026 pass 1): give a phase-run an optional display TITLE. Fan-out
// children were all rendered "<phase> #1" — the "#1" was the retry-iteration
// counter (always 1 on first success), not a child index. Each child's sub-task
// briefing is a freeform string, so the scheduler derives a short title from it
// at child-creation and stores it here, letting the monitor show the real work
// (e.g. "Implement: counter component"). Null for ordinary (non-child) phase
// runs. Pure ADD COLUMN — safe under the foreign_keys=OFF migration loop.
export const SCHEMA_V17 = `
ALTER TABLE process_phase_runs ADD COLUMN title TEXT;
`

// v18: give a process RUN an optional display TITLE — a short, LLM-generated
// summary of the run's objective (mirrors how a conversation is titled from its
// first message). The run selector previously showed the whole objective; the
// title makes it scannable. Null for pre-existing runs (the renderer falls back
// to the objective slice). Pure ADD COLUMN — safe under the foreign_keys=OFF loop.
export const SCHEMA_V18 = `
ALTER TABLE process_runs ADD COLUMN title TEXT;
`

// v19: the process review feedback loop (plan 029). A gated phase (gate_policy
// 'approve') gains a third decision — "Request changes" — that re-runs the
// phase's own worker with a feedback note and re-gates, bounded per phase.
//   - process_phase_runs.rework_note: the feedback text injected into the
//     re-run's kickoff (read by makeRunPhase); null for a first/normal run.
//   - process_phase_runs.rework_round: how many times this phase-run has been
//     sent back (the bound counter); default 0.
//   - process_phases.max_rework_rounds: the per-phase cap (0 = unlimited,
//     preserving prior behavior); at the cap the gate card drops the control.
// All three are pure ADD COLUMN — safe under the foreign_keys=OFF migration loop
// (no table rebuild), matching the V16/V17/V18 pattern.
export const SCHEMA_V19 = `
ALTER TABLE process_phase_runs ADD COLUMN rework_note TEXT;
ALTER TABLE process_phase_runs ADD COLUMN rework_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE process_phases ADD COLUMN max_rework_rounds INTEGER NOT NULL DEFAULT 0;
`

// v20: per-phase dot-folder toggle (plan 030). When set, the phase's kickoff
// steers its agent to write artifacts under a `.<phase.key>/` folder at the
// workspace root — a predictable location (an agent convention, not FS-enforced),
// so the run monitor's file chips are reliable and downstream phases know where
// to look. Pure ADD COLUMN — safe under the foreign_keys=OFF loop (no rebuild),
// matching the V16-V19 pattern. Default 0 preserves prior behavior.
export const SCHEMA_V20 = `
ALTER TABLE process_phases ADD COLUMN dot_folder INTEGER NOT NULL DEFAULT 0;
`

// v21: per-phase VALIDATOR — the automatic same-phase half of plan 031 (031.1).
// When enabled, a second agent reviews the phase's output after its worker
// completes and either approves it or sends it back with feedback (reusing the
// 029 rework_note kickoff channel), bounded by an iteration cap; on exhaustion
// the phase escalates to a human gate.
//   - process_phases.validator: the toggle (0/1); default 0 preserves prior behavior.
//   - process_phases.validator_max_iterations: the per-phase cap on review rounds.
//     0 = use the engine default (DEFAULT_VALIDATOR_ITERATIONS); a positive value
//     overrides. NEVER unlimited — the DAG has no cycle guard, so a bound is
//     mandatory (unlike max_rework_rounds where 0 = unlimited).
//   - process_phases.validator_agent: the dedicated reviewer agent name; NULL
//     falls back to the phase's own resolved agent (pool[0]).
//   - process_phase_runs.validator_round: the validator's own round counter, kept
//     SEPARATE from rework_round (which drives the 029 count-based gate re-detection
//     and must not be perturbed); default 0.
// All four are pure ADD COLUMN — safe under the foreign_keys=OFF migration loop
// (no table rebuild), matching the V16-V20 pattern.
export const SCHEMA_V21 = `
ALTER TABLE process_phases ADD COLUMN validator INTEGER NOT NULL DEFAULT 0;
ALTER TABLE process_phases ADD COLUMN validator_max_iterations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE process_phases ADD COLUMN validator_agent TEXT;
ALTER TABLE process_phase_runs ADD COLUMN validator_round INTEGER NOT NULL DEFAULT 0;
`

// v22: cross-phase FLAG-BACK — the second half of plan 031 (031.2). A phase-worker
// that finds a defect an EARLIER phase owns flags it back (a gated flag_for_rework
// tool) instead of fixing out of lane; the engine resets the target phase (or a
// single fan-out sub-task) AND everything downstream of it, then re-walks.
//   - process_definitions.require_flag_approval: per-process autonomy toggle.
//     1 (default) = a flag needs human confirmation before the send-back; 0 = the
//     agent routes autonomously.
//   - process_phase_runs.source_child_run_id: first-class on_each_subtask lineage —
//     which source fan-out CHILD this consumer instance consumes (was only recorded
//     in the append-only eachsubtask: checkpoint blob). NULL for ordinary runs and
//     fan-out children; set for on_each_subtask consumer instances. Makes the
//     per-child reset ("only the Test instance tied to the reworked Implement
//     sub-task") a direct query. ON DELETE SET NULL mirrors the other self-FKs.
//   - process_flags: durable flag records (lifecycle pending -> applied | dismissed),
//     status bare TEXT validated in the repo (the V15 status pattern). target_child_
//     run_id is the resolved specific sub-task (from the flagging instance's
//     source_child_run_id, or a key#N index); NULL = the whole phase.
// The two ALTERs are pure ADD COLUMN; the CREATE TABLE/INDEX are new objects — all
// safe under the foreign_keys=OFF migration loop (no table rebuild).
export const SCHEMA_V22 = `
ALTER TABLE process_definitions ADD COLUMN require_flag_approval INTEGER NOT NULL DEFAULT 1;
ALTER TABLE process_phase_runs ADD COLUMN source_child_run_id TEXT
  REFERENCES process_phase_runs(id) ON DELETE SET NULL;
CREATE TABLE process_flags (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES process_runs(id) ON DELETE CASCADE,
  flagging_phase_run_id TEXT NOT NULL REFERENCES process_phase_runs(id) ON DELETE CASCADE,
  target_phase_id       TEXT NOT NULL REFERENCES process_phases(id),
  target_child_run_id   TEXT REFERENCES process_phase_runs(id) ON DELETE SET NULL,
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL,
  created_at            INTEGER NOT NULL
);
CREATE INDEX idx_process_flags_run ON process_flags(run_id);
`

// v23 (plan 031.2 follow-up): make the flag audit trail durable. process_flags
// .flagging_phase_run_id was ON DELETE CASCADE, so a PER-CHILD send-back — which
// DELETES the flagging on_each_subtask instance so it re-triggers fresh — cascaded
// the flag row away with it. Applied/dismissed flags then vanished from the table,
// leaving it an unreliable history (the durable record lived only on the approvals
// table). Rebuild it with ON DELETE SET NULL so a flag row SURVIVES its flagging
// instance's deletion (the column becomes nullable — a settled flag whose instance
// was later re-triggered reads NULL there, which is fine; run_id still anchors it).
// SQLite can't alter an FK in place, so this is a table rebuild (the V8 pattern),
// safe under the foreign_keys=OFF migration loop. run_id keeps CASCADE (deleting a
// run should still drop its flags); target_child_run_id already SET NULL.
export const SCHEMA_V23 = `
CREATE TABLE process_flags_new (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES process_runs(id) ON DELETE CASCADE,
  flagging_phase_run_id TEXT REFERENCES process_phase_runs(id) ON DELETE SET NULL,
  target_phase_id       TEXT NOT NULL REFERENCES process_phases(id),
  target_child_run_id   TEXT REFERENCES process_phase_runs(id) ON DELETE SET NULL,
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL,
  created_at            INTEGER NOT NULL
);
INSERT INTO process_flags_new
  (id, run_id, flagging_phase_run_id, target_phase_id, target_child_run_id, reason, status, created_at)
  SELECT id, run_id, flagging_phase_run_id, target_phase_id, target_child_run_id, reason, status, created_at
  FROM process_flags;
DROP TABLE process_flags;
ALTER TABLE process_flags_new RENAME TO process_flags;
CREATE INDEX idx_process_flags_run ON process_flags(run_id);
`

// v24 (plan 038.1 — sub-processes): a phase can run ANOTHER process definition as
// a nested run.
//   - process_phases.subprocess_id: the referenced definition a sub-process phase
//     runs. Originally mutually exclusive with fan-out; RELAXED in plan 038.3 —
//     a phase may set BOTH, meaning it fans out into N sub-tasks and runs the
//     sub-process once per child (seeded with that child's briefing) instead of a
//     worker. Sub-process alone = one nested run; fan-out alone = a worker per
//     child. Validated in the repo layer (the V15 bare-TEXT ruling; no
//     CHECK-rebuild — only the acyclicity guard remains). ON DELETE SET NULL:
//     deleting a referenced definition leaves the phase orphaned (its dispatch then
//     fails loudly at run time) rather than cascading the parent definition away.
//   - process_runs.parent_phase_run_id: a NESTED run's caller. NULL for a top-level
//     run; set to the sub-process phase-run that started it, so the monitor can nest
//     the child run's phase-runs under the phase and crash-resume can re-attach to
//     the in-flight nested run (find-by-parent) instead of restarting it. Mirrors the
//     process_phase_runs.parent_id / source_child_run_id self-FKs.
// Both are pure ADD COLUMN — safe under the foreign_keys=OFF migration loop (no
// table rebuild), matching V16's nullable-FK precedent.
export const SCHEMA_V24 = `
ALTER TABLE process_phases ADD COLUMN subprocess_id TEXT
  REFERENCES process_definitions(id) ON DELETE SET NULL;
ALTER TABLE process_runs ADD COLUMN parent_phase_run_id TEXT
  REFERENCES process_phase_runs(id) ON DELETE SET NULL;
`

// v25 (MCP servers — per-machine side-store): MCP server DEFINITIONS live in
// file-based mcp.json configs (discovered from user/workspace/custom dirs, exactly
// like agents/skills — see agent/mcp/), NOT in the DB. This table holds only the
// two things that can't live in a shareable/committable file, keyed by the server
// `name` (the mcp.json object key + tool prefix):
//   - enabled: an EXPLICIT on/off OVERRIDE. A discovered server defaults ON; a row
//     exists here only once the user has toggled it (or OAuth was stored). So the
//     effective state is: row present → row.enabled; row absent → ON. Bare TEXT-free
//     INTEGER; no CHECK.
//   - oauth_tokens / oauth_client: safeStorage-encrypted BLOBs for an http server
//     that completed the OAuth flow (tokens = access/refresh set; client = the
//     dynamic client registration). Written only through settings/secrets.ts; never
//     cross IPC (the UI sees a derived `hasOauth` boolean), mirroring
//     provider_accounts.encrypted_key.
// PK is the server name (global — an MCP server name is unique across the app's
// discovery order by last-wins, so one state row per name is correct).
// A plain CREATE TABLE — a new object, safe under the foreign_keys=OFF loop.
export const SCHEMA_V25 = `
CREATE TABLE mcp_server_state (
  name          TEXT PRIMARY KEY,
  enabled       INTEGER NOT NULL DEFAULT 1,
  oauth_tokens  BLOB,
  oauth_client  BLOB,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
`

// v26 (plan 033 — Live dashboards): a saved layout of widgets, each backed by a
// data-fetch RECIPE describing how to pull its data. Mirrors the 025 process
// engine's definition-vs-run split and bare-TEXT-statuses-validated-in-the-repo
// convention (no CHECK — the v8 tasks rebuild to widen a CHECK was painful):
//   - dashboards + dashboard_widgets = the DEFINITION (top-level objects, NOT
//     conversation-scoped, so a dashboard persists like a process definition).
//   - dashboard_widget_data = the RUN/CACHE side: the last fetched rows the view
//     renders, one row per widget (PK = widget_id), replaced on each refresh.
// A widget's `type` (chart|stat|table) and the cache `status` (ok|error|stale)
// are bare TEXT, validated/coerced in repositories/dashboards.ts (mirrors the
// unions in types.ts). JSON blobs (layout/config/recipe/pos/data) are TEXT.
// The data-fetch recipe re-runnability + deterministic replay is plan 033.3.
// Three plain CREATE TABLEs — new objects, safe under the foreign_keys=OFF loop.
export const SCHEMA_V26 = `
CREATE TABLE dashboards (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  layout      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE dashboard_widgets (
  id           TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  type         TEXT NOT NULL,
  config       TEXT,
  recipe       TEXT,
  pos          TEXT,
  position     INTEGER NOT NULL
);

CREATE TABLE dashboard_widget_data (
  widget_id  TEXT PRIMARY KEY REFERENCES dashboard_widgets(id) ON DELETE CASCADE,
  data       TEXT,
  status     TEXT NOT NULL DEFAULT 'ok',
  error      TEXT,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX idx_dashboard_widgets_dashboard ON dashboard_widgets(dashboard_id);
`

// v27 (plan 033 follow-up): pin dashboards to the top of the list. A bare
// INTEGER 0/1 flag (SQLite has no boolean), coerced to/from a JS boolean in the
// repo. NOT NULL DEFAULT 0 so existing rows migrate as unpinned. The list order
// becomes `pinned DESC, updated_at DESC`.
export const SCHEMA_V27 = `
ALTER TABLE dashboards ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
`

// v28: provider visibility + model favorites.
// Provider accounts can be disabled without deleting credentials or models. A
// disabled account is hidden from the composer model picker and ignored by LLM
// resolution/active-provider checks. Models can be favorited so provider-local
// pickers place preferred models first. Both are bare INTEGER booleans, coerced
// by repositories.
export const SCHEMA_V28 = `
ALTER TABLE provider_accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE models ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
`

// v29 (plan 041): widen provider_accounts for the first local autonomous CLI
// provider and persist its per-conversation native session reference. SQLite
// cannot alter a CHECK constraint, so rebuild the provider table while foreign
// keys are disabled by the migration runner.
export const SCHEMA_V29 = `
CREATE TABLE provider_accounts_v29 (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL CHECK (provider IN
                  ('portkey','openai_compatible','openai','claude_code','anthropic','google','azure_openai')),
  display_name  TEXT NOT NULL,
  base_url      TEXT,
  encrypted_key BLOB,
  api_mode      TEXT NOT NULL DEFAULT 'completions'
                  CHECK (api_mode IN ('completions','responses')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
INSERT INTO provider_accounts_v29
  (id, provider, display_name, base_url, encrypted_key, api_mode, enabled, created_at, last_used_at)
SELECT id, provider, display_name, base_url, encrypted_key, api_mode, enabled, created_at, last_used_at
FROM provider_accounts;
DROP TABLE provider_accounts;
ALTER TABLE provider_accounts_v29 RENAME TO provider_accounts;

CREATE TABLE cli_sessions (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('claude_code')),
  session_id      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, provider),
  UNIQUE (provider, session_id)
);
CREATE INDEX idx_cli_sessions_provider_session
  ON cli_sessions(provider, session_id);
`

// v30 (plans 041.1 + 044): Claude Code exposes durable model aliases rather
// than our OpenAI-style gateway catalog, and provider accounts gain an authored
// display position shared by Settings and every conversation model picker.
// Legacy provider rows all start at position 0; created_at remains the stable
// tie-breaker until the user performs their first reorder.
export const SCHEMA_V30 = `
ALTER TABLE provider_accounts ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

UPDATE conversations
SET model_id = 'sonnet'
WHERE model_id = 'claude-code'
  AND account_id IN (
    SELECT id FROM provider_accounts WHERE provider = 'claude_code'
  );

UPDATE settings
SET value = json_set(value, '$.activeModelId', 'sonnet')
WHERE key = 'llm'
  AND json_extract(value, '$.activeAccountId') IN (
    SELECT id FROM provider_accounts WHERE provider = 'claude_code'
  )
  AND (
    json_extract(value, '$.activeModelId') IS NULL OR
    json_extract(value, '$.activeModelId') = 'claude-code'
  );

DELETE FROM models
WHERE model_id = 'claude-code'
  AND account_id IN (
    SELECT id FROM provider_accounts WHERE provider = 'claude_code'
  );

INSERT OR IGNORE INTO models
  (id, account_id, model_id, model_name, origin, favorite, created_at, updated_at)
SELECT lower(hex(randomblob(16))), id, 'sonnet', 'Sonnet', 'seeded', 1,
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       CAST(strftime('%s','now') AS INTEGER) * 1000
FROM provider_accounts WHERE provider = 'claude_code';

INSERT OR IGNORE INTO models
  (id, account_id, model_id, model_name, origin, favorite, created_at, updated_at)
SELECT lower(hex(randomblob(16))), provider_accounts.id, alias.id, alias.name, 'seeded', 0,
       CAST(strftime('%s','now') AS INTEGER) * 1000 + alias.seq,
       CAST(strftime('%s','now') AS INTEGER) * 1000 + alias.seq
FROM provider_accounts
JOIN (
  SELECT 'haiku' AS id, 'Haiku' AS name, 1 AS seq
  UNION ALL SELECT 'opus', 'Opus', 2
  UNION ALL SELECT 'fable', 'Fable', 3
) AS alias
WHERE provider = 'claude_code';
`

// v31 (plan 042): add the Codex CLI autonomous local provider. Both provider
// tables have CHECK constraints, so rebuild them to admit `codex_cli`.
export const SCHEMA_V31 = `
CREATE TABLE provider_accounts_v31 (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL CHECK (provider IN
                  ('portkey','openai_compatible','openai','claude_code','codex_cli','anthropic','google','azure_openai')),
  display_name  TEXT NOT NULL,
  base_url      TEXT,
  encrypted_key BLOB,
  api_mode      TEXT NOT NULL DEFAULT 'completions'
                  CHECK (api_mode IN ('completions','responses')),
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  position      INTEGER NOT NULL DEFAULT 0
);
INSERT INTO provider_accounts_v31
  (id, provider, display_name, base_url, encrypted_key, api_mode, enabled, created_at, last_used_at, position)
SELECT id, provider, display_name, base_url, encrypted_key, api_mode, enabled, created_at, last_used_at, position
FROM provider_accounts;
DROP TABLE provider_accounts;
ALTER TABLE provider_accounts_v31 RENAME TO provider_accounts;

CREATE TABLE cli_sessions_v31 (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('claude_code','codex_cli')),
  session_id      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, provider),
  UNIQUE (provider, session_id)
);
INSERT INTO cli_sessions_v31
  (conversation_id, provider, session_id, created_at, updated_at)
SELECT conversation_id, provider, session_id, created_at, updated_at
FROM cli_sessions;
DROP TABLE cli_sessions;
ALTER TABLE cli_sessions_v31 RENAME TO cli_sessions;
CREATE INDEX idx_cli_sessions_provider_session
  ON cli_sessions(provider, session_id);
`

// v32 (plan 042 follow-up): Codex CLI gets durable selectable model aliases,
// matching the fixed-alias treatment used for Claude Code.
export const SCHEMA_V32 = `
UPDATE conversations
SET model_id = 'gpt-5.3-codex'
WHERE model_id = 'codex-cli'
  AND account_id IN (
    SELECT id FROM provider_accounts WHERE provider = 'codex_cli'
  );

UPDATE settings
SET value = json_set(value, '$.activeModelId', 'gpt-5.3-codex')
WHERE key = 'llm'
  AND json_extract(value, '$.activeAccountId') IN (
    SELECT id FROM provider_accounts WHERE provider = 'codex_cli'
  )
  AND (
    json_extract(value, '$.activeModelId') IS NULL OR
    json_extract(value, '$.activeModelId') = 'codex-cli'
  );

DELETE FROM models
WHERE model_id = 'codex-cli'
  AND account_id IN (
    SELECT id FROM provider_accounts WHERE provider = 'codex_cli'
  );

INSERT OR IGNORE INTO models
  (id, account_id, model_id, model_name, origin, favorite, created_at, updated_at)
SELECT lower(hex(randomblob(16))), id, 'gpt-5.3-codex', 'GPT-5.3 Codex', 'seeded', 1,
       CAST(strftime('%s','now') AS INTEGER) * 1000,
       CAST(strftime('%s','now') AS INTEGER) * 1000
FROM provider_accounts WHERE provider = 'codex_cli';

INSERT OR IGNORE INTO models
  (id, account_id, model_id, model_name, origin, favorite, created_at, updated_at)
SELECT lower(hex(randomblob(16))), provider_accounts.id, alias.id, alias.name, 'seeded', 0,
       CAST(strftime('%s','now') AS INTEGER) * 1000 + alias.seq,
       CAST(strftime('%s','now') AS INTEGER) * 1000 + alias.seq
FROM provider_accounts
JOIN (
  SELECT 'gpt-5.3-codex-spark' AS id, 'GPT-5.3 Codex Spark' AS name, 1 AS seq
  UNION ALL SELECT 'gpt-5.5', 'GPT-5.5', 2
  UNION ALL SELECT 'gpt-5.6-sol', 'GPT-5.6 Sol', 3
  UNION ALL SELECT 'gpt-5.6-terra', 'GPT-5.6 Terra', 4
  UNION ALL SELECT 'gpt-5.6-luna', 'GPT-5.6 Luna', 5
) AS alias
WHERE provider = 'codex_cli';
`

// v33 (plan 058): explicit external-agent model mappings. Source model tokens
// from GitHub/Cursor/Claude/Codex definitions never fuzzy-match into the
// destination account catalog. A mapping is namespaced by source system and
// destination account; exact active-catalog IDs can resolve without a row.
export const SCHEMA_V33 = `
CREATE TABLE external_agent_model_mappings (
  source_kind              TEXT NOT NULL CHECK (source_kind IN ('github','cursor','claude','codex')),
  source_model             TEXT NOT NULL,
  normalized_source_model  TEXT NOT NULL,
  destination_account_id   TEXT NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
  destination_model_id     TEXT NOT NULL,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  PRIMARY KEY (source_kind, normalized_source_model, destination_account_id)
);
CREATE INDEX idx_external_agent_model_mappings_account
  ON external_agent_model_mappings(destination_account_id);
`

// v34 (plan 064): conversation-scoped recall. Full-text search is indexed by
// message text and serialized tool-call arguments, while conversation/role/seq
// metadata stays unindexed for strict server-owned scope filtering.
export const SCHEMA_V34 = `
CREATE VIRTUAL TABLE message_fts USING fts5(
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  seq UNINDEXED,
  role UNINDEXED,
  created_at UNINDEXED,
  tool_name UNINDEXED,
  content,
  tokenize = 'unicode61'
);

INSERT INTO message_fts
  (message_id, conversation_id, seq, role, created_at, tool_name, content)
SELECT
  id,
  conversation_id,
  seq,
  role,
  created_at,
  tool_name,
  trim(COALESCE(content, '') || ' ' || COALESCE(tool_calls, ''))
FROM messages
WHERE trim(COALESCE(content, '') || ' ' || COALESCE(tool_calls, '')) <> '';

CREATE TRIGGER messages_ai_message_fts AFTER INSERT ON messages BEGIN
  INSERT INTO message_fts
    (message_id, conversation_id, seq, role, created_at, tool_name, content)
  SELECT
    NEW.id,
    NEW.conversation_id,
    NEW.seq,
    NEW.role,
    NEW.created_at,
    NEW.tool_name,
    trim(COALESCE(NEW.content, '') || ' ' || COALESCE(NEW.tool_calls, ''))
  WHERE trim(COALESCE(NEW.content, '') || ' ' || COALESCE(NEW.tool_calls, '')) <> '';
END;

CREATE TRIGGER messages_ad_message_fts AFTER DELETE ON messages BEGIN
  DELETE FROM message_fts WHERE message_id = OLD.id;
END;
`
