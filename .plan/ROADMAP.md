# Roadmap

Intended order of work. Plan files are numbered by **creation order** (stable IDs —
never renumbered, referenced by number in git history). This file is the **priority
order**, and is meant to be reordered freely as needs change. The number next to each
item is its plan file, not its rank.

## Next up

1. **`009` — Durable task execution.** Activate the storage-only task tables (`tasks`,
   `task_events`, `task_checkpoints`, `approvals` from `001`) with a real runner: resumable
   (survive crash/quit + pause), background (no live renderer needed), queued (ordered under a
   concurrency cap), and retried (transient failures back off; cancel never retries). Wraps the
   existing `runChat` loop, checkpointing at turn boundaries. The substrate `008` runs on.
2. **`008` — Repository indexing.** Background, incremental, cancellable workspace index so the
   agent can answer immediately while the index improves. Four stages (file map → metadata →
   symbols → embeddings-later); incremental by content hash (skip unchanged, re-index changed,
   drop deleted, add new); resumable across restart. New v7 tables; reuses the `LocalEnvironment`
   walk + ignore rules. Interactive = low priority; North Star = higher, but never hard-blocks
   execution. First real client of `009`'s runner (ships its own `IndexService` first; converges
   later).
3. **`005.1` — ContainerEnvironment stop in-flight.** The deferred half of `005`: killing the host
   `docker/podman exec` client doesn't stop the in-container process. Needs its own kill mechanism
   (in-container PID tracking / `exec kill`, or marker `pkill`). Out of scope when `005` shipped.
4. **`007` — Slash commands for skills.** Let users force a skill with `/skill-name …` (pre-inject
   the `read_skill` call), keeping today's model-discretionary path for plain messages. Adds a
   `skills:list` IPC channel + composer autocomplete. Independent — schedule freely.

## Done

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
