# Cowork Agent Tools — PR5: Stop in-flight tool calls (carry abort into tools)

> Status: **NOT STARTED** — pickup note (2026-06-26), written so we don't forget. Follows the
> Stop-button work shipped on `feat/agent-tools-3` (see CONSIDERATIONS.md #9). Independent of the
> todo tool; can be built any time. The shape below is a starting hypothesis, not a locked spec.

## Context

The Stop button now cancels **LLM inference** and the **agentic loop** promptly: aborting the
turn's `AbortController` makes the consume loop `break` out of the `for await`, which runs the
Portkey stream iterator's `return()` → `reader.cancel()` and tears down the HTTP body. (Note:
the Portkey SDK 3.1.0 **ignores** `opts.signal` for the fetch — `buildRequest` never attaches
it — so the `break` is what actually cancels, not the signal. See CONSIDERATIONS.md #9.)

What Stop does **not** interrupt: a tool that is **already executing** when Stop is pressed. The
loop `await`s the running tool to completion, then sees `signal.aborted` and stops before the
next model call. So the stop is honored, but a slow in-flight tool delays it. The worst offender
is `run_shell_tool` — a long command (build, install, test run) keeps going until it finishes or
hits its own timeout, even though the user asked to stop. A large `read_file`/`search` is also
technically uninterruptible, but those are short.

This PR threads the turn's abort signal into tools so the long-running ones can bail out.

## Open questions to resolve BEFORE building
1. **Surface:** add `signal?: AbortSignal` to `ToolContext` (`tools/types.ts`) and pass
   `abort.signal` from `runChat` when it builds `ctx`. Tools that don't care ignore it; the
   shell tool honors it. Confirm this is the right shape vs. a per-call cancellation token.
2. **Shell semantics:** `run_shell_tool` uses `child_process` (spawn/exec) with `cwd:
   ctx.workspace`, a timeout, and a maxBuffer. Node's `spawn`/`exec` accept a `signal` option —
   passing `ctx.signal` makes Node kill the subprocess on abort. Decide the kill signal
   (`SIGTERM` then `SIGKILL`?) and what the tool returns when aborted (an `ERROR[stopped]` or a
   neutral note?). The subprocess's child processes (a shell running a pipeline) may not all die
   with `SIGTERM` — consider `detached` + killing the process group, or accept the limitation.
3. **Return vs. throw:** when a tool is aborted mid-run, does it return an `ERROR[...]` string
   (consistent with the tool-error convention in `output.ts`) or throw? The loop already detects
   `abort.signal.aborted` after the tool returns and persists "⏹ Stopped by user." — so the
   tool's own return value for the aborted case may not even be shown. Keep it simple: tool
   returns a short stopped marker, loop's abort check takes over.
4. **Other tools:** do any current tools besides shell need it? `read_file`/`search`/`list`/
   `edit`/`write` are all fast and synchronous-ish; probably leave them as-is (they finish before
   the user notices). Revisit if/when a network or MCP tool lands — those are the real future
   case (a hung HTTP request to an MCP server is exactly where you'd want abort).
5. **Double-cancel safety:** the gate already releases a pending approval as a denial on abort
   (shipped). Make sure a tool that checks the signal AND the gate doesn't double-handle the
   stop. The shell tool gates first, then execs — if Stop fires during the gate, the gate denial
   short-circuits before exec; if during exec, the signal kills the child. Both paths should end
   cleanly.

## Likely implementation shape (hypothesis — revisit after Q1/Q2)
- **`ToolContext`** gains `signal?: AbortSignal`. `runChat` sets `signal: abort.signal` in the
  `ctx` it builds for each tool call (alongside `workspace`, `attachments`, `conversationId`,
  `gate`).
- **`run_shell_tool`** passes `signal: ctx.signal` to its `child_process` call. On abort, Node
  raises an `AbortError` from the exec; the tool catches it and returns a short
  `ERROR[stopped]`/stopped marker. Confirm the timeout path and the abort path don't fight.
  Consider killing the process group for shell pipelines (Q2).
- Tools that take no `signal` are unaffected. The change is additive and backward-compatible
  (the field is optional; unit tests that build a bare `ctx` still pass).

## Verification (when built)
- Start a long shell command (e.g. `sleep 30` or a slow build) via the agent, press Stop →
  the subprocess dies promptly (verify with `ps`/Activity Monitor: no orphaned process), the
  turn ends with the "⏹ Stopped by user." note, and the loop does not start another round-trip.
- Stop during the approval prompt for a shell command → still denies the gate, never execs
  (unchanged behavior).
- Stop during a fast tool (read/search) → no regression; turn ends cleanly.
- `pnpm typecheck` + `pnpm build` clean; existing tool tests (which build a bare `ctx` without a
  signal) still pass.

## Out of scope
- Cancelling the LLM stream / the loop (already shipped on `feat/agent-tools-3`).
- A general task-cancellation framework beyond the chat turn.
- Pausing/resuming a turn (Stop is terminal; there's no resume).
- Fixing the upstream Portkey signal bug (we work around it via the consume-loop `break`).
