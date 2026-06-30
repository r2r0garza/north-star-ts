# PR18: Agentic goal mode — a bounded plan → execute → review → fix loop

> Status: **NOT STARTED**. Builds on `runAgentLoop` (the shared agent core), the `TaskRunner`
> (`009`–`016`, task_events + checkpoints), and the deterministic shell/git access from `002`/`006`.

## Context

Today every turn is a single pass through `runAgentLoop`: the model plans, acts, and answers in one
shot, with no built-in self-review. We want an **agentic quality loop** — plan, execute, review, fix
if needed, finalize — but **without making every chat turn heavier**. So this is an opt-in
**execution mode**, orthogonal to the existing conversation `mode` (chat/interactive/north_star):

- **`simple`** — current behavior. One `runAgentLoop` pass. Default. Untouched.
- **`goal`** — a bounded orchestration: **plan → execute → review → (fix)\* → finalize**, capped by
  `maxIterations`, with a goal statement, a checklist, a review rubric, a final summary, and a
  `task_events`/checkpoint per phase.

Goal mode must work for **both foreground and background** tasks. The cleanest way to get that for
free: goal mode is a **task-level orchestrator inside the runner** (`runOne`), so it inherits durable
events, crash-resume, cancellation, retry, and the activity panel — exactly like any other task. A
foreground "Run with review loop" is just a goal-mode task with the panel attached (same as
"Run in background" today, plan `009`).

**Hard constraint: no unbounded autonomous looping.** The fix loop is capped by `maxIterations`
(small, e.g. 3). On exhaustion the task **finalizes with an honest summary of remaining failures** —
it never loops forever, and it never silently claims success.

**Reviewer = deterministic-first.** The review phase runs **deterministic checks where possible**
(tests, lint, build, file existence, git diff) and uses an **LLM review to supplement, not replace**
them. A deterministic failure (non-zero exit) is ground truth; the LLM judges the things checks can't
(did it actually satisfy the goal/rubric, is the diff sane). The loop only continues to a `fix` phase
when there's a **concrete, evidenced** problem.

## What exists vs. net-new (from the audit)

- **`runAgentLoop` is callable multiple times** for one conversation (it rebuilds context from stored
  messages each call, persists every turn). Calling it once per phase in `runOne`, with one task / one
  forked conversation, is the natural seam — the durable transcript already accumulates across calls.
- **`task_events` is fully wired** (`runner.ts` `emit()` → `appendEvent` → live `task:event` tail). A
  new `phase_change` event is a union addition + `emit()` calls. **Net-new but trivial.**
- **`checkpoints` table + repo + IPC exist but are UNUSED** (nothing calls `createCheckpoint` today).
  Goal mode is its first consumer: one checkpoint per phase boundary carrying the phase state. This is
  also what makes goal mode **crash-resumable** at phase granularity.
- **Deterministic checks:** `Environment.exec` (`env/types.ts`) runs commands (host or container);
  `run_shell_tool` shows the pattern; git is allowed/benign in the approval policy. The reviewer runs
  `npm test` / `npm run lint` / `npm run build` / `git diff` / file stats through `env.exec` directly
  (no model in the loop for the deterministic part).
- **Slash commands DO NOT exist** — the composer sends raw text (`App.tsx` `sendMessage`). `/goal …`
  is **net-new UI** (a small composer parse + route). The "Run with review loop" button is a sibling
  of the existing "Run in background" entry point.
- **`mode` selects prompt + tool set** and is per-conversation. Execution mode is a **separate axis**
  carried on the task input — NOT a new conversation mode (it doesn't change the tool set, it wraps
  the loop). Goal mode is available in `interactive`/`north_star` (workspace-backed); not `chat`.

## Approach

### A. Execution mode on the task (plumbing)

- **Extend `TaskInput`** (`runner.ts`) with an optional goal spec — absent ⇒ `simple`, so every
  existing producer (`agent_chat`, `todo_run`) is unchanged:
  ```ts
  interface TaskInput {
    kind: string
    message: string
    seedTodos?: Array<{ itemId: string; content: string; status: TodoStatus }>
    goal?: {
      statement: string          // the goal in one sentence (the user's request, normalized)
      rubric?: string[]          // review criteria, e.g. ["tests pass", "lint clean", "file X exists"]
      checks?: GoalCheck[]       // deterministic checks (see C)
      maxIterations: number      // fix-loop cap (e.g. 3); REQUIRED when goal is present
    }
  }
  ```
- **Thread it through `enqueue`** (new optional field) and a new `kind: "goal_run"` registered with
  `autoResume: true` (a long goal survives a restart, like `todo_run`).
- The existing `runOne` branches: `task.input.goal` present ⇒ run the **goal orchestrator** (B);
  else the current single `runAgentLoop` call (unchanged).

### B. The goal orchestrator (inside `runOne`, one task / one conversation)

A bounded state machine; each phase is one `runAgentLoop` call with a phase-specific kickoff message,
bracketed by a `phase_change` event and a checkpoint:

```
plan      → agent writes the goal's checklist (reuses todo_write) + approach. 1 pass.
execute   → agent works the checklist to completion. 1 pass (its own internal tool loop).
review    → DETERMINISTIC checks first (C), then an LLM review pass that sees the check
            results + the goal/rubric and returns a structured verdict {pass, failures[]}.
fix       → only if review failed AND iterations < maxIterations: agent addresses the
            evidenced failures. Then loop back to review. (counter++)
finalize  → always runs: agent writes a final summary covering what was done and, if the
            iteration cap was hit with failures remaining, what's still broken (honest).
```

- **Bound:** the `review → fix → review` cycle runs at most `maxIterations` times. Exhaustion →
  `finalize` with remaining failures stated. **No phase is skipped on the way out; no infinite loop.**
- **Per phase:** `emit(taskId, { type: "phase_change", phase, iteration })` (durable + live-tailed)
  and `createCheckpoint({ taskId, label: phase, state: { phase, iteration, verdict } })`. The
  checkpoint is the **resume anchor** (B.1).
- **Cancellation / Stop:** the orchestrator checks `abort.signal` between phases and honors a
  `runAgentLoop` that returns `{ stopped: true }` — settles `cancelled`, same as today.
- **Phase prompts** live in a new `src/main/tasks/goal/` module (prompt builders + the state machine),
  kept out of `runOne`'s body so the runner stays readable. Reuses `todo_write` for the checklist and
  the existing tools for execute/fix — **no new agent tools** beyond what review needs (C).

### B.1. Crash-resume at phase granularity

A `goal_run` task interrupted mid-flight reconciles to `queued` (autoResume) and re-enters the
orchestrator. On resume it reads the **latest checkpoint** to learn which phase/iteration it was in
and continues from there, rather than restarting plan→execute. (The transcript is already durable;
the checkpoint adds the phase cursor + iteration count the in-memory loop would otherwise lose.) This
is the first real use of the `checkpoints` table.

### C. Deterministic reviewer (checks-first)

- **`GoalCheck` types** (a small, explicit set — deterministic and offline):
  ```ts
  type GoalCheck =
    | { kind: "command"; cmd: string; expectExit?: number }   // npm test / lint / build
    | { kind: "file_exists"; path: string }                   // artifact was created
    | { kind: "diff_nonempty" }                               // something actually changed
  ```
- A new `src/main/tasks/goal/checks.ts` runs them via `Environment.exec` (the same backend the task's
  tools use — host or container), capturing exit code / output / file stat / `git diff --stat`. Each
  produces a structured `CheckResult { check, passed, detail }`. **No LLM here** — exit codes and
  `stat` are ground truth.
- The **LLM review pass** then receives the goal statement, the rubric, the check results, and the
  diff, and returns a structured verdict (via a forced tool/JSON shape): `{ pass: boolean; failures:
  Array<{ what: string; evidence: string }> }`. It **cannot override a hard deterministic failure**
  (a failing `command` check forces `pass:false`); it can only *add* failures the checks can't see
  (e.g. "the goal asked for X but the code does Y"). Mirrors the `approval` design: deterministic
  classifier first, judgment supplements.
- Default checks when the caller gives none: infer from the repo (`npm test`/`lint`/`build` if those
  scripts exist in `package.json`; `diff_nonempty`). Conservative — a missing script is skipped, not
  failed.

### D. Invocation (manual first)

- **`/goal <request>`** — net-new composer affordance. Parse a leading `/goal ` in `sendMessage`
  (`App.tsx`); strip it, build a `goal` spec (statement = request, `maxIterations` default, inferred
  checks), and enqueue a `goal_run` task instead of a live `chat` turn. Foreground = the activity
  panel attaches to it (like Run-in-background today).
- **"Run with review loop"** — a sibling entry point to the composer's "Run in background" button,
  enqueuing the same `goal_run` task. Both routes converge on `TaskRunner.enqueue({ kind: "goal_run",
  goal })` (one operation, per the `015` producer contract).
- A new `task:start-goal` IPC + preload bridge (mirrors `task:start` / `task:start-todos`), snapshotting
  nothing — the goal spec is built renderer-side or normalized in the handler.

### E. Renderer: phase visibility

- The activity panel's task row shows the **current phase** + iteration (from the `phase_change` tail),
  e.g. "Goal · review (fix 2/3)". The read-only transcript viewer already replays `task_events`, so the
  phase markers and the final summary appear inline. Small additions to `tasks-section.tsx` /
  `timeline.ts` to label the new event. No new panel.

## Deferred to a later PR (explicitly out of scope here)

- **The execution-mode setting** (your "later"): a Settings control — *Always use goal mode* /
  *Ask when task is complex* / *Manual only* / *Off*. This PR ships **Manual only** (the `/goal`
  command + the button). The setting + a complexity heuristic for "ask when complex" is its own plan.
- **Unbounded / fully autonomous looping** — never. The cap is a hard invariant.
- **One-task-per-item / subagents / parallel phases** — goal mode is sequential, one task.
- **A bespoke diff viewer** — reviewer uses `git diff` text; rich diff UI is separate.
- **Live mirroring of the fork's checklist into the source panel** — same gap as `016`/`017` item 2;
  rides on whatever `017` chooses.

## Verification

**Unit (`src/main/tasks/goal/*.test.ts`, runner test):**
- The orchestrator runs phases in order and emits a `phase_change` + checkpoint per phase (stub
  `runAgentLoop`); a passing review skips `fix` and goes straight to `finalize`.
- A failing review drives `fix` then re-`review`, and **stops at `maxIterations`** — assert it does
  not exceed the cap and `finalize` still runs with remaining failures recorded.
- `checks.ts`: a `command` check with non-zero exit ⇒ `passed:false`; `file_exists` true/false;
  `diff_nonempty` against a stubbed `exec`. The LLM verdict cannot flip a hard check failure to pass.
- Resume: an orphaned `goal_run` with a `review` checkpoint reconciles to `queued` and re-enters at
  `review`, not `plan` (assert via the checkpoint cursor).
- `simple` tasks (no `goal`) are completely unchanged (existing runner tests stay green).

**Manual (real app):**
1. `/goal add a CONTRIBUTING.md and make sure the build passes` in an interactive/workspace session →
   a `goal_run` task appears; the panel shows phase progression plan→execute→review→…→finalize.
2. Force a fix loop: a goal whose first attempt fails a deterministic check (e.g. `npm run build`) →
   see `review` fail, `fix` run, `review` re-run, and either pass or stop at the cap with an honest
   final summary.
3. Background + resume: start a `/goal` run, quit mid-`execute`, relaunch → it resumes at the right
   phase and finishes.
4. Cancel mid-loop from the panel → settles `cancelled`, no further phases.

**Build/test note:** runner/DB suites need `better-sqlite3` built for **node**
(`npm rebuild better-sqlite3`); restore Electron afterward (`npx electron-rebuild -f -w better-sqlite3`).
Run `npm run typecheck`.
