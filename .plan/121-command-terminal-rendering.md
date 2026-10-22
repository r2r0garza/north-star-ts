# PR121: Specialized terminal rendering for command tools

> Status: **Proposed — not implemented.** Renderer-only command output presentation built on the existing Trace and Code Block primitives. Related: PR113 Trace adoption, proposed PR114 Code Block adoption, and PR74/75 command completion retention/UI.

## Objective

Adopt the [shadcn Terminal pattern](https://ui.shadcn.com/docs/ai-elements/base/terminal) as a specialized renderer for agent command tools. Trace owns the activity row, disclosure and status; Code Block owns the exact command and bounded plain-text output. This is not a new execution engine, interactive shell or terminal emulator.

The existing xterm drawer serves a different purpose and must remain untouched: no changes to its component, terminal sessions, IPC, keyboard behavior, mounting, dependencies or backend. Do not route agent commands through xterm or substitute this component for the drawer.

The documented Terminal is a composition of Trace and Code Block, not a required new package. Reuse installed primitives; do not add an AI SDK dependency or its data-part transport.

## Current contracts and evidence

`src/renderer/src/components/tool-group.tsx` already renders tool rows with Trace but displays generic raw arguments and clipped result text. It preserves contextual activity titles, approval state, interruption explanations, lazy media and a 4,000-character display cap. Its icon map currently identifies `run_shell_tool` as a terminal, but not `exec_command`.

`src/main/agent/tools/command_session_tools.ts` defines `exec_command`, `poll_command`, `write_stdin`, `terminate_command` and `wait_for_events`. Structured command snapshots contain `status`, optional `sessionId`, `exitCode`, `signal`, `durationMs`, `output`, cursor/truncation metadata and optional cleanup errors. Status is `running`, `completed`, `timed_out` or `terminated`. A returned tool call can therefore describe a still-running process. Wait results can contain multiple completion events.

`run_shell_tool.ts` delegates to the compatibility path. That path returns a provenance-wrapped text result beginning with a generated exit/timeout/signal summary, or a tool error. It is not the structured JSON command contract.

The existing command pipeline performs approval through `ctx.gate`. Presentation must not change that gate, policy, confinement, ownership, cancellation, process lifetime, result format or model context. `timeline.ts` reconstructs tool calls from persisted messages; special runtime completion messages are not ordinary user prose. Existing completion retention and timeline behavior must be inspected before projecting session outcomes.

PR114 is currently proposed, not completed. This work may use the already installed Code Block primitives independently, but should not implement PR114's broad Markdown, approval and error-surface migration. Coordinate the shared tool payload integration so the two plans do not independently rewrite the same generic renderer.

## Scope and non-goals

Support command launch rows for `exec_command` and `run_shell_tool`, plus command-session snapshots returned by `poll_command`, `write_stdin` and `terminate_command`. Render recognized command completion events inside `wait_for_events` results using the same compact output presentation. Preserve non-command event shapes through the generic fallback. Do not specialize arbitrary tools merely because they return text containing a command, status or exit code.

Integrate the shared payload renderer into live and reloaded conversation transcripts and task transcripts that consume ToolGroup, and into workflow run-detail tool disclosures without changing workflow response pairing. Keep one existing Trace activity disclosure per call; do not wrap every command body in another redundant Trace.

Do not add execution, rerun, stdin, terminate, clear, shell-link or auto-poll controls. Do not add live output subscriptions, streaming IPC, data-terminal parts, PTY emulation, ANSI/HTML rendering, output fetching, session merging or database migrations. Structured test-result tools remain on their current renderer; this is not a generic process-output redesign.

## Rendering and interaction contract

Keep contextual activity titles as the primary label. Use a terminal icon for command launch rows and appropriate existing labels for session operations. Display the exact submitted command separately from the friendly title, as literal copyable text, with cwd when supplied. Do not infer a missing command from prose or invent a workspace path. A session-only operation may show its session identity instead. Preserve access to original arguments and raw results through a secondary details disclosure, using existing display limits rather than silently removing diagnostic information.

Use compact Code Blocks with wrapped output, long-token wrapping, a bounded `max-h-64` output surface and no competing nested scroll containers. Keep current fonts, density and theme tokens. Render output as text, never HTML or executable links. Empty output is a valid result and is distinct from no result yet. Do not add highlighting to runtime output or an ANSI interpretation dependency.

For this first version, preserve initially closed disclosures and manual open state using stable call/event identity. Do not introduce auto-open or auto-scroll behavior intended for continuous streaming; no continuous output stream is being added. Copy controls must sit outside the Trace trigger and copy the displayed command or displayed output only, with truncation clearly represented and accessible labels. No hidden full output through Copy.

Preserve the current 4,000-character ordinary-tool display cap, applied to extracted output independently of envelope parsing. Explicitly distinguish UI clipping from source truncation/dropped/omitted output. Keep status and cleanup metadata visible even when output is clipped. Bound every completion-event output and the number initially rendered for large event arrays, with an explicit expansion affordance for already available events; do not imply unavailable output can be fetched.

## Parsing and fallback

Introduce a small pure renderer-side adapter for recognized tool names and validated result shapes. Parse the full result before display clipping. Preserve original raw strings unchanged. Validate field types and known statuses; unknown, malformed or historical shapes fall back to existing generic argument/result rendering without crashing or claiming success.

For structured snapshots, use explicit machine fields for status, exit code, signal, duration and truncation. Do not search output for strings such as “passed” or “error.” `completed` alone is not proof of success: require exit code zero and no signal/cleanup failure for a success treatment. Cleanup failure must remain visible even if the command itself exited zero.

For legacy shell results, inspect the existing context-envelope helpers and recognize only the producer's anchored generated status line after correctly handling its envelope. Do not scan arbitrary stdout for exit codes. Retain provenance and the original result in details. Unsupported legacy formats and tool errors use the generic fallback with their existing error treatment.

For wait results, validate the known command-event envelope and each entry individually. Keep event/session identity, ordering, partial/missing entries and all original raw responses; never collapse multiple events into one synthetic command.

## Lifecycle truthfulness

Approval pending is not execution. Preserve pending/denied approval labels and all existing approval routing, scopes and keyboard controls. Tool errors remain distinct from process exit failure; a process may exit nonzero inside a successfully returned tool result.

Use explicit states for currently running, completed successfully, nonzero exit, timed out, terminated, interrupted, cleanup failure and unknown outcome. A returned background session must not receive the generic done checkmark while its process is still running. Aggregate ToolGroup counts/status must agree with the displayed command outcome, including process failure not encoded in ToolStatus.

Within a live transcript, derive newer session outcomes only from existing authoritative command snapshots/completion events already available in that conversation/run, joined by session identity and existing ownership boundaries. Never join by command text, globally cached session ID, or wall-clock guesses. Do not concatenate cursor-based snapshots into fictional complete output or suppress their original tool calls.

For historical snapshots without a later available authoritative outcome, show “Running when reported” / “Final outcome unavailable” as appropriate, rather than a perpetual spinner or a fabricated success. If existing renderer data cannot expose a terminal outcome without new transport, retain that honest snapshot treatment and document the limitation; defer transport work. A narrow renderer-only projection of already persisted structured completion data is allowed, but hidden runtime context must not become user-authored prose, model messages must not be rewritten, and the same projection rules must apply on replay. Inspect PR74 retention implementation before selecting the join location.

## Proposed implementation surfaces

Add a focused pure adapter and tests near renderer `lib` for command snapshots, legacy envelope recognition and presentation state. Add a small shared command-output payload component using installed Code Block primitives; keep Trace ownership in current consumers. Extend `tool-group.tsx` and its tests for command bodies, terminal icons and truthful row/group state. Reuse the payload component in `run-detail.tsx`, preserving exact original argument strings, multiple responses, errors and orphan/unlinked output. Touch timeline/transcript adapters only if needed to project already available session outcomes with replay parity, with focused regression tests.

Do not change `terminal-drawer.tsx` or any xterm-related implementation. No main-process, preload, shared execution contract or dependency changes are planned.

## Delivery phases

Phase A: implement and test typed presentation adaptation for recognized JSON snapshots, command completion arrays, legacy output and safe generic fallback. Establish output bounds and authoritative state precedence.

Phase B: compose command payloads with existing Code Block and Trace; integrate command tool rows and aggregate status, retain contextual titles, raw details, approval behavior and media handling. Reuse payloads in workflow disclosures without changing their response adapter.

Phase C: verify foreground/background lifecycle and reloaded history using existing retained events; add narrowly scoped renderer projection only where existing data permits. Unknown historical outcomes must remain neutral. No new streaming transport or polling.

Phase D: run focused tests, declared type checking and production build; inspect Electron UI where available and record results/limitations. Confirm the xterm drawer and execution/approval contracts have no diff.

## Acceptance and verification

Adapter tests cover exit zero/nonzero/null, running with a returned session ID, timeout, signal termination, cleanup failure, empty output, malformed JSON, unknown status, legacy envelopes, generated status versus misleading output text, tool errors and mixed completion arrays. Cover large output, long unbroken lines, source versus UI truncation and exact displayed-copy values.

Renderer tests cover contextual title and exact command separation, pending/denied approval, no false done checkmark, process error reflected in group state, interrupted/unknown states, manual open-state retention and accessible controls outside triggers. Verify no execution dispatch occurs from the component. Retain non-command/subagent/media behavior.

Lifecycle tests cover a background launch followed by completion, same command text with distinct sessions, ownership isolation, out-of-order/duplicate data, reload without final completion, and replay parity for any added projection. Workflow tests retain every response and orphan output. Test task transcript reuse.

Manual QA covers light/dark themes, narrow layouts, long commands, scrolling, keyboard disclosure/copy behavior, approval while a row is visible, foreground failure, background completion and history after reload. Smoke-test the existing xterm drawer only to confirm it still behaves independently; do not modify it to satisfy terminal-output tests.

Run the repository's current supported typecheck/test/build commands, checking package scripts at implementation time. Record pre-existing failures and unavailable Electron verification rather than claiming passes. No tests need to run merely to add this plan document.

## Deferred follow-up

Continuous live stdout/stderr presentation would be a separate proposal addressing bounded event delivery, throttling, ownership, persistence/replay, cleanup and user-controlled scrolling. This plan neither adds that transport nor couples command execution to the xterm drawer.
