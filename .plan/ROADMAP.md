# Roadmap

Intended order of work. Plan files are numbered by **creation order** (stable IDs —
never renumbered, referenced by number in git history). This file is the **priority
order**, and is meant to be reordered freely as needs change. The number next to each
item is its plan file, not its rank.

## Next up

1. **`017` — Todo-run follow-ups.** Two gaps surfaced testing `016`. (1) **Robust large-file writes**:
   full-file content inlined as one JSON tool argument truncates at the output-token cap (the immediate
   cap-bump + truncation-detection fix shipped with `016`; this is the structural fix — prefer surgical
   `edit_file_tool` edits and/or a chunked write tool so large writes never ride one oversized
   completion). (2) **Live todo progress in the panel**: after a handoff the Todos panel shows stale
   all-`[ ]` because it reads the *source* conversation's todos while the background agent updates the
   *forked* worker conversation — make the panel reflect real per-item progress. Independent of each
   other; general agent-tool robustness (item 1) + a UI read gap (item 2), not `todo_run`-specific.
2. **`008` — Workspace indexing.** Background, incremental, pausable/cancellable workspace index so
   the agent can answer immediately while the index improves. Four stages (file map → metadata →
   symbols → embeddings-later); incremental by content hash (skip unchanged, re-index changed, drop
   deleted, add new); resumable across restart. Controls: configurable auto-start, pause/resume,
   cancel-keeps-partial, per-workspace disable/re-enable, clear-index — plus a Workspace Indexing
   settings group. New v7 tables; reuses the `LocalEnvironment` walk + ignore rules. Interactive =
   low priority; North Star = higher, but never hard-blocks execution. **Depends on `009`**: the
   indexer runs as a durable task so pause is a real task state. **Consumes `015`** (first producer).
3. **`014` — Context builder.** Evolve the existing `ContextBuilder` into a structured, budgeted,
   multi-source assembler: conversation summary, recent messages (the current walk-back), workspace
   index + relevant files (from `008`), durable memories, task state, and approvals — each a labeled
   section under one global token budget with an explicit drop order. Ships the framework + the
   already-available sources (recent messages, task state, approvals); index/retrieval sections are
   no-ops behind a capability check until `008` lands. Surfaces two prerequisite sub-features to
   decide on: a rolling **conversation summary** and a **durable-memories** store (likely its own
   plan). **Soft-depends on `008`** (graceful without it); reads `009`'s task tables.
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
  not yet merged to `main`). A background task blocked on an approval gate now survives an app
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
- **`011` — Task retry with backoff.** Built on `feat/task-retry` (not yet merged to `main`).
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
  runner, `a33d5ac` UI; not yet merged to `main`). Activated the storage-only task tables with a
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
- **`004` — Settings pane.** Shipped on `feat/settings-pane` (not yet merged to `main`).
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
  `d572805`, not yet merged to `main`). The abort signal was already threaded end-to-end
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
