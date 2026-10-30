# PR121: Specialized terminal rendering for command tools

> Status: **Complete (2026-10-21), at the user's direction following manual Electron verification.** Command presentation uses existing Trace and Code Block primitives connected to bounded runtime session updates. Active conversation command launches appear outside tool-use groups, then fold back into their local group on process completion. The dated follow-ups below supersede the original renderer-only/no-streaming and disclosure/scrolling restrictions. Related: PR113 Trace adoption, proposed PR114 Code Block adoption, and PR74/75 command completion retention/UI.

## Objective

Adopt the [shadcn Terminal pattern](https://ui.shadcn.com/docs/ai-elements/base/terminal) as a specialized renderer for agent command tools. Trace owns the activity row, disclosure and status; Code Block owns the exact command and bounded plain-text output. This is not a new execution engine, interactive shell or terminal emulator.

The existing xterm drawer serves a different purpose and must remain untouched: no changes to its component, terminal sessions, IPC, keyboard behavior, mounting, dependencies or backend. Do not route agent commands through xterm or substitute this component for the drawer.

The documented Terminal is a composition of Trace and Code Block, not a required new package. Reuse installed primitives; do not add an AI SDK dependency or its data-part transport.

## Original implementation brief

The brief through “Deferred follow-up” records the initial snapshot-only design, not the complete current contract. The dated implementation and user-requested follow-up sections below take precedence where they change transport, disclosure defaults, scrolling or conversation grouping. Earlier verification counts describe their respective implementation stages, not a single cumulative test run.

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

## Implementation and verification — 2026-10-21

Added pure renderer adapters for structured command snapshots, individually validated completion entries and the exact legacy provenance envelope/generated status line. The shared command payload uses installed Code Block primitives for literal command/output, displayed-only copy, independent 4,000-character UI clipping, source-loss metadata, cleanup diagnostics, bounded output height and an initial five-event limit with explicit expansion. Original argument strings and bounded raw results remain in a secondary disclosure. ToolGroup and workflow disclosures reuse this payload; generic tools, media and workflow response pairing remain intact.

Available tool snapshots and wait completions project terminal outcomes by conversation/session identity across live/replayed chat groups and task history. Original results are never rewritten or concatenated. Conflicting final snapshots remain neutral; identical command text is not a join key. The projection does not use a global cache or wall-clock precedence.

Limitation: automatic completion notifications are persisted as hidden runtime system context and do not reach live transcript segments through the current event contract. They remain hidden on replay and in workflow transcripts. This implementation deliberately does not project these hidden-only events, avoiding replay/live divergence or new transport. A launch without a visible authoritative tool snapshot retains “Running when reported” and “Final outcome unavailable in this snapshot.” Workflow calls likewise retain their individual response snapshots rather than merging sessions across calls. Continuous output, output fetching and execution controls remain deferred.

Verification: 78 focused adapter/lifecycle/renderer/timeline/workflow tests pass; `pnpm typecheck` and `pnpm build` pass. The repository-wide `pnpm test` attempt reports 2,521 passed, 2 failed and 77 skipped, plus nine worker-exit errors. Both failed assertions are in the unchanged main-process `tool-error-feedback.integration.test.ts` Chat attachment/read_document cases; the full suite is not green, and these failures have not been baseline-qualified. Existing transcript tests emit React act-environment warnings. No main-process, preload, execution contract, dependency or xterm drawer file was modified. Interactive Electron light/dark/narrow-layout, keyboard and independent drawer smoke qualification was not performed in this session and remains pending.

## User-requested live-output follow-up — 2026-10-21

The original snapshot-only scope did not meet the expected running-command experience. This follow-up supersedes the no-streaming restrictions above: the existing command session producer emits an immediate session snapshot, cumulative bounded output at most once per 200 ms, and an immediate final snapshot (clearing any pending timer). Delivery uses a dedicated `command_output` ChatEvent through the existing event bridge, associated with the launching tool-call ID; no execution gate, process lifetime, model result format, dependency or xterm drawer changes. Task live ticks are ephemeral rather than repeatedly persisted in the event log.

At this stage, chat command blocks used current session output and status together, opened running command disclosures by default, and retained the user's disclosure state on updates. The standalone-running-command follow-up below replaces that chat disclosure default with a directly visible active surface and closed command details after folding. Original arguments/results stay in raw details. Workflow disclosures also receive live task command events. No cursor-delta concatenation is performed: each live update is a producer-owned cumulative bounded snapshot. Existing source truncation metadata and the separate UI output cap remain visible.

Hidden persisted background completion envelopes are parsed only as data and projected by conversation/session identity on replay, without surfacing runtime context as human prose. The final output replaces the empty launch snapshot in the main block rather than showing a completed heading above an obsolete running body. Unknown historical sessions still remain neutral. Live updates are not a full terminal emulator, do not interpret ANSI/HTML, and do not add stdin/rerun/terminate controls. Reopening a workflow reader mid-command relies on subsequent updates; there is no new session fetch/reconnect API.

Verification: 210 tests pass across nine command-session, completion-inbox, presentation, command-renderer, timeline, workflow-renderer/service and task-runner test files. `pnpm typecheck`, `pnpm build` and `git diff --check` pass. Regression tests cover output before foreground return, background output coalescing, immediate final flush, no post-settlement duplicate tick, approval denial, same-block final output, raw snapshot preservation, hidden-completion replay and workflow live updates. Interactive Electron visual/keyboard qualification remains pending; the full repository suite was not rerun for this follow-up.

## User-requested output auto-follow — 2026-10-21

Command output Code Blocks now follow new displayed output while the reader is at the bottom. Scrolling up pauses following; returning within 24 pixels of the bottom resumes it. Initial output opens at the bottom, and the final output update follows the same rule rather than overriding manual scrollback. Only output panels follow: command text and original raw-result disclosures do not. This behavior lives in the shared payload, so chat and workflow output use the same implementation. The existing 4,000-character UI clipping policy remains unchanged; auto-follow does not fetch or expose omitted output.

Verification: 46 focused command-output, workflow-renderer, command-presentation and command-outcome tests pass, including three output-scrolling regressions; TypeScript checks pass. These are DOM-level tests, not visual Electron qualification.

## User-requested standalone running commands — 2026-10-21

### Conversation presentation contract

Active `exec_command` and legacy `run_shell_tool` launches render directly in the conversation outside the “X tool uses” disclosure. Their contextual activity heading, exact command and bounded live output are visible without expanding the group. Before the first snapshot arrives, the surface shows the command and “Waiting for output…” without inventing a session ID, exit code or other process metadata. The standalone heading is noninteractive rather than an extra disclosure users must open.

When the process completes, exits nonzero, times out or terminates, the standalone surface disappears and its original call returns to the ordinary local tool group. Completion means the process reached a final state, not merely that the launching tool returned: a background launch remains standalone while its live session snapshot is running. Final output and error details remain inspectable after folding. Group counts exclude active standalone calls and include them again after folding; every tool call appears once.

Ordinary calls form contiguous runs around active launches. Once a launch finishes, adjacent ordinary runs coalesce within the same artifact-bounded tool segment. Preserve original call order and the preceding group's user-selected open/closed state; folded command details default closed. If no preceding group exists, the completed call returns to the existing single-call disclosure or joins adjacent ordinary calls. Do not merge across assistant/user text, chart/table artifacts or existing timeline boundaries. Multiple active commands each retain a separate surface and stable identity while other commands finish.

### Lifecycle and interaction safeguards

The extraction predicate requires a command launch that is still in flight or has a current live running snapshot. Final projected outcomes, interrupted/error tool states and pending/denied approvals take precedence. Historical “Running when reported” results without live execution evidence stay in normal groups and must not become perpetual active terminals after reload. Approval waits keep the existing approval presentation rather than appearing as process execution.

`poll_command`, `write_stdin`, `terminate_command` and `wait_for_events` remain ordinary tool calls; they do not create duplicate standalone surfaces for the launching session. Apply conversation/session outcome projection before extracting active launches. Keep original arguments and results, source-loss metadata, output limits, copy semantics and output auto-follow/manual scrollback behavior unchanged.

When a focused standalone terminal folds, focus returns to a local tool disclosure without scrolling the page. Do not steal focus from the composer or any other element outside the removed surface. Preserve message-scroller anchors and existing memoized transcript boundaries.

### Implementation surfaces and scope

`src/renderer/src/lib/command-tool-segments.ts` provides pure active-launch classification and ordered group/command segmentation. `transcript-tools.tsx` applies it inside the existing deduplicated artifact segments, after outcome projection, so live and settled transcript consumers share the same presentation entry point. Canonical timeline data is not rearranged or rewritten.

`ActiveCommand` in `tool-group.tsx` reuses the command row/payload rendering with an explicitly visible standalone mode; normal grouped command details default closed. `command-output.tsx` supports a pending pre-snapshot launch without fabricating process state. Changed-file pills still consume the original calls. Workflow run-detail grouping remains unchanged; only the shared output auto-follow applies there. No execution, event transport, persistence/schema, dependency or xterm drawer changes were needed for this follow-up.

### Verification and manual qualification

The latest focused run passes 90 tests across nine files: command segmentation, transcript-tools integration, transcript render boundaries, command output, workflow run detail, timeline, command outcomes, command presentation and transcript scrolling. Coverage includes background return before process completion, concurrent command identity, completion folding and final-output inspection, preserved prior-group disclosure state, failure summaries, approval waits, historical snapshots, artifact boundaries/deduplication and focus preservation. Existing transcript render-boundary tests still emit React act-environment warnings. TypeScript, formatting and `git diff --check` pass. The full repository suite and production build were not rerun for this presentation-only follow-up.

Manual Electron qualification completed by the user on 2026-10-21: “I've manually verified Electron, it's working as designed.” This closes the pending manual qualification for the implemented experience. The user did not provide a per-scenario checklist; this confirmation should not be read as separate evidence for every theme, layout, lifecycle edge case or independent drawer smoke test described in the original QA guidance. Earlier pending-verification notes above record the state at those implementation stages and are superseded by this user confirmation.
