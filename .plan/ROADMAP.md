# Roadmap

Intended order of work. Plan files are numbered by **creation order** (stable IDs —
never renumbered, referenced by number in git history). This file is the **priority
order**, and is meant to be reordered freely as needs change. The number next to each
item is its plan file, not its rank.

## Next up

1. **`021` — Approvals context section.** The last section `014` reserved: give the agent read-only
   visibility into what the user has **already granted/denied** so it doesn't re-request an
   allowlisted action or retry a denied one. Additive over existing tables (no migration): a new
   `listRules({ workspacePath, conversationId })` read on `action_allowlist` (`002`) + optionally
   recent/pending `approvals` rows (`009`/`012`) for durable-task turns, folded into an
   `approvalsSection` (slot `SECTION_PRIORITY.approvals = 20` already defined). Advisory only — never
   bypasses the live gate. Pairs naturally with `018` (its fix loop re-runs gated actions). Small;
   scheduled next by request (a dedicated session to preserve design context).
2. **`019` — Conversation summaries.** The rolling-summary section `014` reserved: a compact,
   periodically-regenerated digest of the turns that fell out of the recent-message window, injected
   as a high-priority context section so long conversations keep their thread. New
   `conversation_summaries` table (one row/conversation, tracks the covered `seq` range); an
   **out-of-band** generation step (a `009` `summarize` task — never on the user's turn latency),
   incremental + debounced past a size threshold; a `summarySection` renderer for the `014`
   framework. Split out of `014` Q1.
3. **`020` — Durable memories.** The cross-conversation memories section `014` reserved: small,
   persisted facts the agent writes (a **gated, explicit** `remember` tool — no silent profiling)
   and that inject into future turns, **scoped** global / workspace / conversation (mirrors the
   `action_allowlist` scoping). New `memories` table + a list/delete surface (durable +
   cross-conversation ⇒ must be auditable/revocable); a `memoriesSection` renderer with an injection
   cap. Split out of `014` Q2.
4. **`010` — Container runtime profiles.** Decouple Workspace (the files) from Runtime (the env a
   tool call executes in). Replace the raw container `image` string with a named **profile**
   (`node` | `python` | `fullstack`), resolved to an image in the env factory; default/fallback =
   `fullstack` (Node + Python) so a Node repo that later adds a Python backend doesn't wedge.
   One profile per conversation, user-overridable in settings. Kills the "one workspace = one image
   forever" assumption **without** building auto-routing or image management (both deferred). Small
   refactor of `env/factory.ts` + `container.ts` + execution settings (JSON blob — no migration).
5. **`005.1` — ContainerEnvironment stop in-flight.** The deferred half of `005`: killing the host
   `docker/podman exec` client doesn't stop the in-container process. Needs its own kill mechanism
   (in-container PID tracking / `exec kill`, or marker `pkill`). Out of scope when `005` shipped.
6. **`007` — Slash commands for skills.** Let users force a skill with `/skill-name …` (pre-inject
   the `read_skill` call), keeping today's model-discretionary path for plain messages. Adds a
   `skills:list` IPC channel + composer autocomplete. Independent — schedule freely.
7. **`018` — Agentic goal mode.** An opt-in **execution mode** (orthogonal to chat/interactive/
   north_star): `simple` (today's one-pass behavior, default) vs `goal` (bounded **plan → execute →
   review → fix → finalize**, capped by `maxIterations` — never unbounded). Modeled as a task-level
   orchestrator inside the runner's `runOne` (one task / one forked conversation, calling
   `runAgentLoop` once per phase), so it works for foreground AND background and inherits durable
   events, crash-resume, and cancellation for free. First real consumer of the unused `checkpoints`
   table (one checkpoint per phase = the resume cursor) and a new `phase_change` task event. Reviewer
   is **deterministic-first** — tests/lint/build/file-existence/`git diff` via `Environment.exec`,
   with an LLM review that *supplements* (can't flip a hard check failure). Manual invocation only this
   PR (`/goal <request>` — reuses `007`'s composer slash-command affordance — + a "Run with review
   loop" button); the Always/Ask/Manual/Off **setting is deferred** to its own plan. Placed by `007`
   since both add `/`-command composer UI.

## Done

- **`014` — Context builder (framework + available sources).** Built on `feat/workspace-indexing`
  (commit `aff2db5`; not yet merged to `main`). Evolved the `ContextBuilder` from a single-budget
  history walk-back into a section assembler: a `ContextSection` abstraction, one global token budget
  with an explicit **drop order** (a section-budget share admitted highest-priority-first that can
  never starve the recent-message walk-back — the non-droppable core, tool-call integrity preserved),
  and an include/drop log (no silent truncation). Migrated `runAgentLoop`'s ad-hoc `systemPrompt +=`
  appends (skills, todos, workspace-index summary) into sections and added a **task-state** section
  (active durable tasks spawned from the session, so the agent doesn't re-start running work). The
  **workspace-index consumption** side shipped alongside `008` (commit `a57fe48`, fixes `a2ba066`):
  the injected index summary + the `index_query_tool` (find-symbol / what-imports / list-files /
  metadata — advisory, with live-fs fallback and honest truncation/counts). `SECTION_PRIORITY`
  centralizes the order: index → approvals → task-state → todos → skills. Verified: `pnpm typecheck`/
  `build` clean, section-framework + renderer + query-tool tests, and live in the app. **Deferred to
  their own plans** (sections reserved): rolling **conversation summary** → `019`, **durable
  memories** → `020`; the **approvals section** is recorded in `014` as additive future work (not a
  plan — the tables already exist).
- **`008` — Workspace indexing (slice 1).** Built on `feat/workspace-indexing` (commit `591e9e2`;
  not yet merged to `main`). A background, incremental, deterministic (no LLM in the build path)
  workspace index run as a `009` durable task. **Ships Stages 1 (file map) + 2 (metadata)**: a
  recursive walk (shared `walkFiles`, factored out of `LocalEnvironment.search`, `.gitignore` via the
  `ignore` dep) upserts one `index_files` row per file with an incremental **hash-skip** — `(size,
  mtime)` fast path → `sha1` only on a miss, drop deleted, add new — then parses `package.json`/
  `tsconfig`/`vite`/`README`/`pnpm-workspace`/git-branch into `index_metadata`. The **crux** is a
  deterministic **executor seam** on the runner: `TaskKindCapability.run` — `runOne` drives it for the
  `workspace_index` kind and leaves the `runAgentLoop` path unchanged for LLM kinds; `enqueueKind` is a
  lean message-free enqueue, config in the input blob (015 contract). **Pause is a real task state**
  (`SCHEMA_V8` widens the task-status CHECK via a tasks-table rebuild; `PAUSE_ABORT_REASON` +
  `pause()`, `resume()` accepts `paused`, reconcile leaves it put across restart). Four v8 tables
  (`index_runs`/`index_files`/`index_metadata`/`index_symbols` — symbols unpopulated, schema leaves
  room). Controls: auto-index on workspace-open (North Star `high` / Interactive `low`),
  pause/resume/cancel-keeps-partial/clear/start-rebuild, per-workspace disable — via reused `task:*`
  verbs + new `index:*` handlers and a Workspace-Activity status strip; plus a Workspace Indexing
  settings group. Agent consumption is a **compact system-prompt summary only** (indexed status,
  file counts by ext, package/framework/config metadata, git branch), gated by "Use index for
  context" and advisory (the agent still uses real file tools). Verified manually (index on select,
  cross-session reuse, auto-resume after quit/reopen, pause/resume, cancel, clear) + `pnpm typecheck`/
  `build` clean and **276 unit tests** (migration-over-v7 incl. `paused`, repos, walk/gitignore,
  `classifyFile`, full IndexService incremental flow + restart-after-cancel/clear, runner executor
  seam + pause/resume). **Follow-up shipped in `014`** (commit `a57fe48`): Stage 3 (symbols +
  Extractor registry + `typescript` promoted to a runtime dep) now populates `index_symbols`, and the
  `index_query_tool` queries it. **Still deferred:** Stage 4 embeddings, live file watching,
  extractors beyond TS/JS + fallback.
- **`017` — Todo-run follow-ups.** Two gaps surfaced testing `016`, shipped as one PR. (1) **Robust
  large-file writes** (steer + append): `write_file_tool` gained an optional `mode: "create" | "append"`
  (default `create`) — append re-reads the file and rewrites the concatenation via the existing
  `atomicWrite`, so a large file is built across small, parseable calls instead of one oversized JSON
  argument that truncates at the output cap. No `Environment` change; gate identity stays
  `file_write:${path}` so one approval covers a multi-chunk write. Tool descriptions + both system
  prompts steer toward `edit_file_tool` for existing files. (2) **Live todo progress in the panel**: the
  Todos panel now reads the latest `todo_run` task's *fork* todos (was reading the frozen *source*
  snapshot), so it shows real `[ ] → [>] → [x]` progress and the final list on completion; the **Run all
  in background** button is disabled while a live task exists. Refresh rides the existing `tasks.onEvent`
  tail — no backend/preload change. Verified: typecheck clean; 40 tool tests (9 new in
  `write_file_tool.test.ts`).
- **`016` — Todo → background handoff.** Run a whole todo list as one durable background task. The
  agent builds a list with `todo_write`, then either it calls the new gated `run_todos_in_background`
  tool (the **delegation** is the approved action — a new `delegate` approval kind that always prompts,
  never sandbox-downgraded or allowlisted; the turn pauses on the live-chat approval card, which omits
  "always allow") or the user clicks **Run all in background** on the new **Todos** panel (explicit
  intent → no gate). Both converge on `TaskRunner.enqueue` with `kind: "todo_run"` (`registerKind`,
  auto-resume) and a **seed** mechanism: since `enqueue` forks an empty worker conversation, the
  current list is snapshotted into `TaskInput.seedTodos` and seeded into the fork. `enqueueTask` is
  injected into `ToolContext` (the agent layer can't import the runner — cycle), supplied by both
  `runChat` and the runner's `runOne`. New `db:todos:list` read path + Todos panel. Verified:
  typecheck + 209 tests (runner seed/auto-resume, tool gate/deny/fail-closed, delegation classifier).
  Follow-ups → `017` (large-file write robustness — immediate cap-bump+truncation-detection fix shipped
  here; live todo progress in the panel).
- **`015` — Task producer API.** Stated + lightly enforced the contract that *every* background
  producer creates work through `TaskRunner.enqueue` (never the DB or `runAgentLoop` directly), so
  approvals, events, recovery, transcript, and history stay consistent. The audit found the runner
  already general (no hardcoded origin, headless-capable, open `kind`); the gap was a
  `registerKind(kind, { autoResume })` affordance (registry moved from a private const to a per-instance
  map; `agent_chat` pre-registered) for producers whose kind should re-queue on restart. Also fixed a
  real FK bug it exposed: `enqueue` wrote `source_conversation_id` to a non-existent source under
  `foreign_keys = ON`; now links back only when the source exists (else self-sourced). No schema change.
  `016` is its first consumer.
- **`013` — Task history in the panel.** Built on `feat/task-history-panel`. A collapsible **History**
  section in the Workspace Activity panel lists terminal tasks (`completed`/`failed`/`cancelled`) for
  the active source conversation, newest first, capped at 25 ("Showing last 25"), each row opening the
  existing read-only transcript viewer. The Tasks section stays actionable-only. Replaced the per-task
  "Background task completed" cards (which didn't scale — one dismissable card per finished task) with
  a **single** toast: reusing a fixed Sonner toast id means there's never more than one on screen — one
  aggregate toast on opening a session with unseen terminal history, one coalesced toast when tasks
  finish live, both with a **View history** action that opens the panel + expands History. Renderer-only,
  no schema/IPC change (reuses `listTasks` + the transcript sheet + the `tasks.onEvent` tail). Verified:
  `pnpm typecheck` + `pnpm build` clean, 140 tests passing.
- **`012` — Durable approval recovery.** Built on `feat/durable-approval-recovery` (commit `7bc7f78`;
  merged to `main`). A background task blocked on an approval gate now survives an app
  restart: quit while it asks → reopen → Resume → it **re-prompts**, and on approval completes. Three
  layers: (1) the runner dual-writes the gate to the existing `approvals` table (`createApproval` on
  the `approval` event, `recordApprovalDecision` on the user's choice, reconcile/cancel sweeps stale
  rows) — runner-side because `approvals.task_id` is `NOT NULL`, so the live chat path is untouched;
  (2) `will-quit` now aborts with a `SHUTDOWN_ABORT_REASON` sentinel so the gate is left *unresolved*
  instead of fabricating an `ERROR[denied]` result that wedged resume; (3) two-mode dangling
  tool-call repair in `runAgentLoop` (`agent/repair.ts`) — task **resume rolls back** the incomplete
  turn so the agent re-issues the gated tool (re-prompt), live chat **synthesizes** an interrupted
  result and lets a new message drive. Renderer shows a reloaded mid-gate tool-call as `interrupted`
  rather than a stuck spinner. No schema change. Verified: `agent/repair.test.ts` + runner cases
  (194 passing) and E2E (`delete build/` → quit at prompt → Resume → re-prompt → approve → deleted).
  Spun off `015` (task producer API).
- **`011` — Task retry with backoff.** Built on `feat/task-retry` (merged to `main`).
  Transient failures (HTTP `408`/`429`/`5xx`, connection-layer codes / SDK connection errors) retry
  with capped exponential backoff + full jitter (max 3 attempts), in-memory in the runner and
  recorded as `attempt` events in `task_events`; deterministic failures (other 4xx, provider config)
  and user Stop never retry. Classification lives in `isTransientError` (`agent/providers`) at the
  catch block where the raw `.status`/`.code` survives, surfaced via a new `ChatResult.retryable`.
  The slot frees during backoff while the DB row stays `running` (crash → `interrupted`); `takeNext`
  treats backing-off conversations as busy to preserve per-conversation serialization. No schema
  change. Verified: classifier + 7 runner unit tests (183 passing) and E2E against a local 5xx/401
  server.
- **`009` — Durable task execution (Phase 1).** Built on `feat/durable-tasks` (commits `03257c3`
  runner, `a33d5ac` UI; merged to `main`). Activated the storage-only task tables with a
  real runner: FIFO queue + concurrency cap, background execution (progress in `task_events`,
  live-tailed over `task:event`), and crash-resume (orphaned tasks reconcile to `interrupted`,
  manual resume; auto-resume is a per-task-kind capability). `runChat` refactored to a shared
  `runAgentLoop` core; resume replays the persisted transcript. **Task isolation** (`SCHEMA_V7`):
  each task runs in its own forked conversation (`source_conversation_id` links back), so a
  background task never interleaves with the live chat. **Workspace Activity panel** (right-hand,
  collapsible) with a Tasks section, Resume/Cancel, inline approval + ask_user_question gates
  (`task:approve`/`deny`/`answer`), a "Run in background" composer entry point, source-chat
  completion cards, and a read-only task transcript viewer. Verified end-to-end on local + Podman.
  Follow-ups: retry → `011` (built), durable approval recovery across restart → `012`, terminal-task
  history → `013`.
- **`001` — SQLite persistence layer.** Shipped. Foundation everything else builds on.
- **`002` — Shell execution + approval gating.** Shipped (`main`, merge `7ce97d6`).
- **`003` — todo_tool.** Shipped (merge `51699ac`). Also in that merge: unbounded agent
  loop, Stop button (LLM/loop cancel), pop-out approval prompt, and `ask_user_question`.
- **`006` — Execution environments (Local / Docker / Podman).** Shipped (`main`, merge `828a397`).
  `Environment` interface under the machine-touching tools, `LocalEnvironment` + a minimal
  `ContainerEnvironment`, bulk `search`, and an `exec` abort seam. Section E (settings + sandbox
  approval) was deferred into `004` and has since shipped (see below).
- **`004` — Settings pane.** Shipped on `feat/settings-pane` (merged to `main`).
  - *Slice 1* (commit `213654e`): first persisted settings store (`SCHEMA_V4`), execution-backend
    choice in the UI (replacing the `COWORK_ENV_RUNTIME` env var), file-permission toggles, and the
    sandbox-aware approval downgrade (the `006`-E payoff — config-driven by category, hardline
    never bypassed).
  - *LLM slice*: multi-provider LLM layer (`SCHEMA_V5` — `provider_accounts` + `models`),
    safeStorage-encrypted API keys (strict, no plaintext fallback, env no longer a runtime
    fallback), a provider routing layer (`agent/providers`) replacing the env-keyed `getClient()`
    singleton, dual-source model management (user-maintained + optional gateway import, custom
    `model_name` labels), Providers/Models settings tabs, a filterable composer model picker, and
    first-launch provider setup. **Per-conversation model selection** (`SCHEMA_V6`) — each session
    keeps its own provider+model, with the Settings choice as the default for new sessions.
    Q1→safeStorage, Q3→both sources, selection scope→per-conversation.
- **`005` — Stop in-flight tool calls (Local).** Shipped on `feat/stop-tools-mid-flight` (commit
  `d572805`, merged to `main`). The abort signal was already threaded end-to-end
  (`ctx.signal` → `env.exec` → `captureSpawn`); the real fix was process-group orphaning —
  `LocalEnvironment.exec` now spawns `detached` and abort/timeout SIGKILL the whole group, so a
  pipeline/build's grandchildren die instead of being reparented to PID 1. The container half is
  split out to `005.1` (in Next up).

## Backlog (not yet planned)

Tracked in `IMPLEMENTED-TOOLS.md` → "Not yet implemented". Near-term tool candidates:
`apply_patch`, `read_extract`, `session_search`, `process_registry`, `tool_result_storage`. Larger:
`skill_manager`, `tool_search`, `cron`/`blueprints`, `code_execution`. Deferred:
web/SSRF, memory, subagents, MCP, browser/computer-use, media, integrations.

## How to use this file

- Reorder the **Next up** list whenever priorities shift — no file renames needed.
- When a plan starts, keep its status in the plan file itself; move it to **Done** here
  when shipped (with the merge/commit ref).
- New work gets the next plan number (`007`, …) and an entry here.
