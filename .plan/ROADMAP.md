# Roadmap

Intended order of work. Plan files are numbered by **creation order** (stable IDs —
never renumbered, referenced by number in git history). This file is the **priority
order**, and is meant to be reordered freely as needs change. The number next to each
item is its plan file, not its rank.

## Next up

1. **`004` (LLM slice) — Settings pane, provider/model + API key.** The remaining half of
   `004`: settings-aware `getClient()` (dynamic provider/model + invalidation), safeStorage
   API-key encryption, and the Provider/Model + API-Key tabs in the Settings Sheet. The store,
   service, IPC, and Sheet shell already exist (slice 1) — this fills in §C and the LLM parts of
   §B/§E/§F. Open questions Q1 (key storage) and Q3 (model list) still to decide.
2. **`005` — Stop in-flight tool calls.** Carry the abort signal into tools so a running
   shell command can be killed, not just the LLM stream. The `Environment.exec` signal seam
   already exists (from `006`); this wires it through and adds the in-container kill (the
   documented `006` follow-up — killing `docker exec` doesn't stop the inner process yet).
3. **`007` — Slash commands for skills.** Let users force a skill with `/skill-name …` (pre-inject
   the `read_skill` call), keeping today's model-discretionary path for plain messages. Adds a
   `skills:list` IPC channel + composer autocomplete. Independent of `004`/`005` — schedule freely.

## Done

- **`001` — SQLite persistence layer.** Shipped. Foundation everything else builds on.
- **`002` — Shell execution + approval gating.** Shipped (`main`, merge `7ce97d6`).
- **`003` — todo_tool.** Shipped (merge `51699ac`). Also in that merge: unbounded agent
  loop, Stop button (LLM/loop cancel), pop-out approval prompt, and `ask_user_question`.
- **`006` — Execution environments (Local / Docker / Podman).** Shipped (`main`, merge `828a397`).
  `Environment` interface under the machine-touching tools, `LocalEnvironment` + a minimal
  `ContainerEnvironment`, bulk `search`, and an `exec` abort seam. Section E (settings + sandbox
  approval) was deferred into `004` and has since shipped (see below).
- **`004` (slice 1) — Settings pane: backend + sandbox approval.** Shipped on `feat/settings-pane`
  (commit `213654e`; not yet merged to `main`). First persisted settings store (`SCHEMA_V4`),
  execution-backend choice in the UI (replacing the `COWORK_ENV_RUNTIME` env var), file-permission
  toggles, and the sandbox-aware approval downgrade (the `006`-E payoff — config-driven by
  category, hardline never bypassed). **LLM provider/model + API-key UI still pending** → Next up.

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
