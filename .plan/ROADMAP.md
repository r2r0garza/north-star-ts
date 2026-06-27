# Roadmap

Intended order of work. Plan files are numbered by **creation order** (stable IDs —
never renumbered, referenced by number in git history). This file is the **priority
order**, and is meant to be reordered freely as needs change. The number next to each
item is its plan file, not its rank.

## Next up

1. **`006` — Execution environments (Local / Docker / Podman).** Foundational refactor:
   put an `Environment` interface under the machine-touching tools so the backend is
   selectable. Prerequisite for safely loosening auto-approval and for unattended
   autonomy — best done before adding more tools that would otherwise need retrofitting.
2. **`004` — Settings pane.** User-facing settings (and the natural home for the
   environment/backend choice from `006`).
3. **`005` — Stop in-flight tool calls.** Carry the abort signal into tools so a running
   shell command can be killed, not just the LLM stream. Coordinates with `006` (killing
   a process means killing it in the right backend).

## Done

- **`001` — SQLite persistence layer.** Shipped. Foundation everything else builds on.
- **`002` — Shell execution + approval gating.** Shipped (`main`, merge `7ce97d6`).
- **`003` — todo_tool.** Shipped (merge `51699ac`). Also in that merge: unbounded agent
  loop, Stop button (LLM/loop cancel), pop-out approval prompt, and `ask_user_question`.

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
