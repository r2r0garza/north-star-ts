# Implemented Agent Tools

The tools the Cowork agent can call, as currently wired in `src/main/agent/`.
Update this file whenever a tool is added, removed, or its gating changes.

- **Source of truth:** `src/main/agent/tools/index.ts` (registry + which tools
  are offered when). Each tool's schema/behavior lives in its own
  `src/main/agent/tools/<name>.ts`. `read_skill` is built per-chat in
  `src/main/agent/skills/tool.ts`. Offering logic (mode/workspace gating) is in
  `runChat` in `src/main/agent/index.ts`.

## Modes

Three conversation modes select which tools are offered:
- **Chat** — no workspace; the user attaches files instead. Tool-light.
- **Interactive** — workspace-backed; collaborative, incremental.
- **North Star** — workspace-backed; autonomous, end-to-end.

## Tools

| Tool | What it does | Offered in | Gating / notes |
|------|--------------|-----------|----------------|
| `list_files_tool` | List files/directories at a path inside the workspace. | Interactive, North Star | Workspace-confined. |
| `read_file_tool` | Read a UTF-8 text file (line-numbered, offset/limit paging). | Interactive, North Star; **Chat** (attachments only) | In Chat, scoped to the user's attached files; otherwise workspace-confined. |
| `search_tool` | Regex search over file contents; returns `path:line: text`. Params: `pattern` (req), `path`, `glob`, `max_results`. | Interactive, North Star | Workspace-confined. |
| `edit_file_tool` | Find-and-replace exact text in a workspace file. | Interactive, North Star | Workspace-confined; routes through the approval gate (auto-allowed by default policy). |
| `write_file_tool` | Create or overwrite a file (creates parent dirs; atomic write). | Interactive, North Star | Workspace-confined; routes through the approval gate (auto-allowed by default policy). |
| `run_shell_tool` | Run a shell command in the workspace; returns stdout+stderr+exit code. Params: `command` (req), `timeout_ms` (default 30s, cap 600s). | Interactive, North Star | **Human-approval gate**: safe cmds run, risky ones (e.g. `rm -rf`, `git reset --hard`) prompt, catastrophic ones are blocked. Confined to `cwd: workspace`; fails closed without a workspace. |
| `read_skill` | Load a skill's full body on demand (only metadata is in the prompt). | All modes (when skills are loaded) | Built per-chat; closes over the loaded skills. |
| `todo_write` | Manage a per-conversation task list (read with no args; replace-all or `merge` by id). Statuses: pending/in_progress/completed/cancelled. | Interactive, North Star | **Mode-gated, not workspace-gated** (excluded from Chat). Persists to the `todos` table; re-injected into the prompt each turn. Not a gated/dangerous action. |
| `ask_user_question` | Ask the user 1–4 clarifying questions, each with 2–4 options (+ auto "Other" free-form) and optional `multiSelect`. Pauses the turn; answers returned as JSON. | All modes | Universal — clarification matters everywhere. Released as cancelled on Stop. |

## Foundational (not tools)

- **Execution environment / backend** — *not yet implemented.* Every
  machine-touching tool currently talks to the **host directly** (`run_shell_tool`
  → `child_process`; file tools → Node `fs`). There is no seam to swap where tools
  execute. Planned: an `Environment` interface so the user can choose a backend —
  **Local** (host, as now) or a **container runtime (Docker / Podman)** for
  isolation. This is the prerequisite for safely loosening auto-approval and for
  unattended autonomy. We do **not** need ssh/cloud backends (the agent runs on the
  user's own machine). Design: `.plan/006-environments-execution-backend.md`.

## Cross-cutting mechanisms

- **Approval gate** (`src/main/agent/approval/`): every dangerous action builds a
  `ToolAction` and routes through one `PolicyEngine`. Decisions: `allow` /
  `require_approval` / `hard_block`. "Always allow in this workspace" persists a
  rule in the `action_allowlist` table. UI: a pop-out prompt above the composer.
- **Stop / cancellation** (`runChat`): the Stop button aborts the turn — cancels
  in-flight LLM inference + the loop, and releases any pending approval or
  question. Does **not** yet interrupt an already-running tool (see
  `.plan/005-stop-inflight-tool-calls.md`).
- **Agentic loop**: unbounded — runs until the model returns a turn with no tool
  calls. Errors are persisted and surfaced.

## Not yet implemented (candidates from `hermes-tools/`)

### Near-term shortlist (low risk, high fit, no new safety boundary)

1. **`read_extract`** — transparent `.ipynb`/`.docx`/`.xlsx` → text inside
   `read_file`. Pure, no deps, no network. Smallest win; upgrades a tool we ship.
2. **`session_search`** — search/recall across *past* conversations (hermes uses
   FTS5). We already persist all messages in SQLite, so it's a natural fit.
3. **`process_registry`** — background/long-running shell processes (start, poll,
   kill); the async counterpart to `run_shell_tool`. Pairs with the in-flight
   cancel work in `.plan/005-stop-inflight-tool-calls.md`.
4. **`tool_result_storage`** — *mechanism, not a tool*: persist large tool
   outputs instead of truncating, so the model can page back into them. Improves
   every existing tool.

### Larger / needs a new boundary or subsystem

5. **`skill_manager`** — let the agent create/edit skills (we only read them
   today). Turns skills into writable procedural memory; needs a write-approval gate.
6. **`tool_search`** — progressive tool disclosure (bridge tools when the catalog
   is large). Only matters once we have many tools.
7. **`cronjob`/`blueprints`** — scheduled/automated runs. Needs a scheduler; more
   a product direction than a single tool.
8. **`code_execution`** — programmatic tool calling: the LLM writes a script that
   calls our tools via RPC, collapsing multi-step chains into one turn. High power,
   high complexity.

### Deferred (bigger lifts / external deps)

`web_search`/`web_extract` (need an SSRF guard + blocklist first), `memory_tool`
(+ write-approval), `delegate`/subagents, MCP client (+ OAuth, OSV malware
check), browser / computer-use, `checkpoint_manager`, `kanban`, `project_tools`,
and the media/integration tools (tts, transcription, vision, image/video gen,
discord, home-assistant, feishu, x_search, send_message, etc.).
