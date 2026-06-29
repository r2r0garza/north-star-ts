# Roadmap

Intended order of work. Plan files are numbered by **creation order** (stable IDs —
never renumbered, referenced by number in git history). This file is the **priority
order**, and is meant to be reordered freely as needs change. The number next to each
item is its plan file, not its rank.

## Next up

1. **`011` — Task retry with backoff.** Transient failures (gateway 5xx / network / timeout) retry
   with capped exponential backoff (in-memory, recorded in `task_events`); deterministic failures
   and user Stop never retry. No schema change. **Depends on `009` (built).**
2. **`012` — Durable approval recovery.** Dual-write the in-memory approval gate to the `approvals`
   table so a task `waiting_for_approval` survives an app restart (re-prompts on resume). No schema
   change. **Depends on `009` (built).** (In-session gate recovery already works.)
3. **`013` — Task history in the panel.** Add a collapsible **History** section to the Workspace
   Activity panel listing terminal tasks (`completed`/`failed`/`cancelled`) for the active
   conversation, each opening the existing read-only transcript viewer. Renderer-only, no schema
   change (reuses `listTasks` + the transcript sheet). The Tasks section stays actionable-only.
   **Depends on `009` (built).**
4. **`008` — Workspace indexing.** Background, incremental, pausable/cancellable workspace index so
   the agent can answer immediately while the index improves. Four stages (file map → metadata →
   symbols → embeddings-later); incremental by content hash (skip unchanged, re-index changed, drop
   deleted, add new); resumable across restart. Controls: configurable auto-start, pause/resume,
   cancel-keeps-partial, per-workspace disable/re-enable, clear-index — plus a Workspace Indexing
   settings group. New v7 tables; reuses the `LocalEnvironment` walk + ignore rules. Interactive =
   low priority; North Star = higher, but never hard-blocks execution. **Depends on `009`**: the
   indexer runs as a durable task so pause is a real task state.
5. **`014` — Context builder.** Evolve the existing `ContextBuilder` into a structured, budgeted,
   multi-source assembler: conversation summary, recent messages (the current walk-back), workspace
   index + relevant files (from `008`), durable memories, task state, and approvals — each a labeled
   section under one global token budget with an explicit drop order. Ships the framework + the
   already-available sources (recent messages, task state, approvals); index/retrieval sections are
   no-ops behind a capability check until `008` lands. Surfaces two prerequisite sub-features to
   decide on: a rolling **conversation summary** and a **durable-memories** store (likely its own
   plan). **Soft-depends on `008`** (graceful without it); reads `009`'s task tables.
6. **`010` — Container runtime profiles.** Decouple Workspace (the files) from Runtime (the env a
   tool call executes in). Replace the raw container `image` string with a named **profile**
   (`node` | `python` | `fullstack`), resolved to an image in the env factory; default/fallback =
   `fullstack` (Node + Python) so a Node repo that later adds a Python backend doesn't wedge.
   One profile per conversation, user-overridable in settings. Kills the "one workspace = one image
   forever" assumption **without** building auto-routing or image management (both deferred). Small
   refactor of `env/factory.ts` + `container.ts` + execution settings (JSON blob — no migration).
7. **`005.1` — ContainerEnvironment stop in-flight.** The deferred half of `005`: killing the host
   `docker/podman exec` client doesn't stop the in-container process. Needs its own kill mechanism
   (in-container PID tracking / `exec kill`, or marker `pkill`). Out of scope when `005` shipped.
8. **`007` — Slash commands for skills.** Let users force a skill with `/skill-name …` (pre-inject
   the `read_skill` call), keeping today's model-discretionary path for plain messages. Adds a
   `skills:list` IPC channel + composer autocomplete. Independent — schedule freely.

## Done

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
  Follow-ups: retry → `011`, durable approval recovery across restart → `012`, terminal-task
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
`read_extract`, `session_search`, `process_registry`, `tool_result_storage`. Larger:
`skill_manager`, `tool_search`, `cron`/`blueprints`, `code_execution`. Deferred:
web/SSRF, memory, subagents, MCP, browser/computer-use, media, integrations.

## How to use this file

- Reorder the **Next up** list whenever priorities shift — no file renames needed.
- When a plan starts, keep its status in the plan file itself; move it to **Done** here
  when shipped (with the merge/commit ref).
- New work gets the next plan number (`007`, …) and an entry here.
