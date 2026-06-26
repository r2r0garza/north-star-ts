# Cowork Agent Tools — PR2: Shell Execution + Approval Gating

> Status: **COMPLETE** — shipped on `main` (merge `7ce97d6`, "Merge agent-tools-2: shell
> execution + generic tool-action approval pipeline"). The design below was the pre-execution
> hypothesis; the **"As built"** section at the bottom records what actually shipped and where it
> diverged. 60 unit tests, typecheck + build clean.

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

---

## As built (shipped on `main`)

The hypothesis above held up, with one significant reshape: the approval mechanism is **generic
over a tool *action*, not shell-specific**. Every gated tool (shell, write, edit) builds a
`ToolAction` and routes through one `PolicyEngine`/`gate`, so adding gating to a new tool is a
policy change, not an architectural one. This was a deliberate mid-plan decision.

### Resolved open questions
1. **Approval UX:** inline in the chat stream — an approval card attached to the live tool-use
   marker (`tool-group.tsx`), with **Approve / Always allow in this workspace / Deny**. The tool
   group auto-expands when a card is pending so it's never hidden.
2. **Classifier policy:** pure regex, pluggable. `RegexCommandClassifier` (ported from hermes
   `approval.py` HARDLINE/DANGEROUS patterns) + a default-allow `FileActionClassifier`. **No
   auxiliary LLM** — the LLM is never the security boundary. `hard_block` is unconditional and
   never overridable by the allowlist.
3. **Persistence:** a **new `action_allowlist` table** (SCHEMA_V2 migration), generic over
   tool/kind, conservative exact-`identity` matching. Scopes modeled (`once | conversation |
   workspace | agent | global`); only **workspace** is exposed in the UI for now. The existing
   task-scoped `approvals` table was **not** used — it requires `task_id NOT NULL` and the chat
   loop has no task.
4. **Timeout / interrupt:** synchronous exec only, timeout-bounded (default 30s, hard cap 600s,
   non-positive falls back to default), 1 MB byte-accurate output cap. Background processes
   deferred as planned.
5. **Confinement:** approval is the boundary, plus `cwd: ctx.workspace`. The shell tool **fails
   closed** when there's no workspace (Chat mode), matching the file tools.

### What shipped (files)
- **Approval core** `src/main/agent/approval/`: `types.ts` (`ToolAction`/`ActionDecision`/
  `ActionClassifier`/`Gate`), `policy.ts` (`PolicyEngine` + `AllowlistLookup`),
  `regex-classifier.ts`, `file-classifier.ts` (the seam — auto-allows file actions today),
  `normalize.ts`, `ansi.ts`. Pure + unit-tested (`approval.test.ts`).
- **Persistence**: `action_allowlist` table in `schema.ts` (SCHEMA_V2) + `migrations.ts` entry;
  repo `db/repositories/action-allowlist.ts` (`addRule`/`findMatch`/`touchLastUsed`); type
  `ActionAllowlistRule` in `db/types.ts`.
- **Tools**: new `tools/run_shell_tool.ts` (+ `run_shell_tool.test.ts`); `write_file_tool.ts` and
  `edit_file_tool.ts` now call `ctx.gate(...)`; `ToolContext` gained optional `conversationId` +
  `gate`; registered in `tools/index.ts`.
- **Bridge**: `agent/index.ts` adds an `approval` `ChatEvent`, a module-level `pendingApprovals`
  map, and an exported `resolveApproval`. Keyed by a **process-unique `requestId`** (not the
  model's `call.id`) so a decision can't resolve another turn's gate. `chat:approve` IPC handler
  in `main/index.ts`; `chatApprove` + the `approval` event variant in `preload/index.ts`.
- **Renderer**: live-only `approval` field on `ToolUse` (`timeline.ts`), event handling in
  `App.tsx`, and the inline `ApprovalCard` in `tool-group.tsx`.
- **Prompts**: `interactive`/`north-star` system prompts + the shell tool description now tell the
  model the approval gate exists, so it issues risky-but-reasonable commands instead of refusing.
- **Tooling**: added `vitest` + `vitest.config.mts` and `test`/`test:watch` scripts (the repo had
  no test runner before).

### Divergences from the hypothesis
- Approval is **action-generic**, not a shell-only `requestApproval`. `ToolContext` gained
  `gate(action) → "approved" | "denied" | "blocked"` (not `requestApproval`).
- Allowlist lives in a **new `action_allowlist` table**, not the existing `approvals` table.
- The decision levels are `allow | require_approval | hard_block` (not a boolean approve/deny),
  surfaced by `PolicyEngine.decide`.
- `write_file_tool` **is** gated in PR2 (routed through `ctx.gate`); the earlier draft had
  considered leaving it untouched.

### Known limitation (carried forward)
If the renderer disconnects mid-approval (window closed / crash), the gate promise never resolves
and the turn hangs — the chat IPC path has no cancellation/abort. A proper fix is cross-cutting
(turn cancellation) and was left out of PR2.
