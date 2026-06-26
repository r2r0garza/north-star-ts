# Cowork Agent Tools — PR2: Shell Execution + Approval Gating (DRAFT / PICK-UP)

> Status: **NOT STARTED** — written ahead of time as a pickup point. Do PR1 (core file
> tools, see `for-the-agent-tools-reactive-turtle.md`) first. This plan needs its own
> research + discussion pass before execution; treat the design below as a starting
> hypothesis, not a locked spec.

## Context

After PR1 the agent can read/search/edit/write files within the workspace, but still cannot
run commands. PR2 adds `run_shell_tool` — the single most capable (and most dangerous) tool —
together with the **human-approval mechanism** that makes it safe. Approval gating is the one
change that reshapes the architecture (it forces the main-process agent loop to pause, cross
the IPC boundary to ask the renderer, and resume on the human's decision), so it must land
*with* the first dangerous tool, not after.

Reference patterns in `hermes-tools/`: `terminal_tool.py` (exec, timeout, ANSI strip,
approval callback), `approval.py` (thread-safe per-session approval state, dangerous-command
classification, auxiliary-LLM auto-approve fast-path), `threat_patterns.py` (regex library for
risky commands), `ansi_strip.py`. The `approvals` table + repository
(`src/main/db/repositories/approvals.ts`) already exist but **nothing blocks on them yet** —
PR2 makes them live.

## Open questions to resolve BEFORE building (research + discuss)
1. **Approval UX:** inline buttons in the chat stream vs. a modal vs. a dedicated approvals
   panel? How does the user approve/deny, and can they "always allow" a command pattern?
2. **Classifier policy:** what's auto-approved vs. always-prompt? Seed denylist from
   `threat_patterns.py` (`rm -rf`, `curl|sh`, credential exfil, writes outside cwd, etc.).
   Do we want an auxiliary-LLM fast-path like hermes `approval.py`, or pure regex first?
3. **Persistence semantics:** per-conversation allowlist? Global? Stored in `approvals` table
   or a new settings table? How long does an "always allow" last?
4. **Timeout / interrupt:** synchronous exec only in PR2 (timeout-bounded, maxBuffer)? Defer
   background processes (`process_registry.py`) to a later PR — confirm.
5. **Confinement:** `cwd: ctx.workspace`, but shell can still `cd ..` / touch absolute paths.
   How much do we lean on approval vs. trying to sandbox? (Likely: approval is the boundary.)

## Likely implementation shape (hypothesis — revisit after discussion)

### A. Approval mechanism (the architectural change)
- Add a `ChatEvent` variant in `src/main/agent/index.ts`:
  `{ type: "approval"; id: string; tool: string; detail: string }`.
- Add a reverse IPC channel (e.g. `ipcMain.handle("chat:approve", (id, decision))`) that
  resolves a pending `Promise` held in a main-process `Map<id, resolver>`.
- Extend `ToolContext` (`tools/types.ts`) to
  `{ workspace; requestApproval?: (req) => Promise<"approved" | "denied"> }`. `runChat` injects
  `requestApproval`; gated tools call it at the top of `execute` and return a denial string if
  rejected. (PR1 left a marked TODO slot in `write_file_tool` for exactly this.)
- Persist each decision via existing `createApproval` / `resolveApproval` for audit.
- Renderer: a UI affordance to surface the request and capture approve/deny (UX TBD, Q1).

### B. Dangerous-command classifier
- New `src/main/agent/tools/approval-policy.ts`: regex denylist/allowlist seeded from
  `hermes-tools/threat_patterns.py`. Safe commands (`ls`, `cat`, `git status`) auto-approve;
  risky ones prompt. Optional auxiliary-LLM fast-path deferred unless Q2 says otherwise.

### C. `run_shell_tool` (`src/main/agent/tools/run_shell_tool.ts`)
- **Params:** `command` (required), `timeout_ms` (optional, default 30s, hard cap).
- `child_process.spawn`/`execFile` with `cwd: ctx.workspace`, `timeout`, `maxBuffer` (~1 MB).
  Strip ANSI from output (reuse PR1 `output.ts` or add `ansi_strip` helper). Return combined
  stdout+stderr + exit code, truncated via PR1 `truncateForModel`.
- Calls `ctx.requestApproval` for any command the classifier flags. **Do not register the tool
  until the approval path works** — an ungated shell tool must never ship.
- Gated behind `hasWorkspace` like the file tools (registered in `tools/index.ts`).

## Verification (when built)
- Auto-approved command (`git status`) runs without prompting.
- Dangerous command (`rm -rf .`) triggers an approval request; deny → tool returns a denial
  string and the file is untouched; approve → runs.
- Output truncation + ANSI stripping confirmed on a noisy command.
- Approval decisions appear in the `approvals` table.

## Out of scope for PR2
- Background/async processes (`process_registry.py`), `read_terminal_tool`.
- Durable todo/task tool (its own PR).
- Web/MCP/memory/delegation (Tier 3+ in the PR1 plan's deferral list).
