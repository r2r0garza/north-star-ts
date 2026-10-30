# PR124: Workflow Trace presentation

> Status: **Done.** Completed 2026-10-23 at the user's direction. Complete the workflow step-activity portion split from [PR113: shadcn Trace adoption](113-shadcn-trace-adoption.md). PR113 covers conversation and task activity; this plan focuses on ordered workflow steps and their existing lifecycle behavior.
>
> **Implementation and verification record (2026-10-23):**
> - Tool-call disclosures already used Trace (PR113) with the response-pairing adapter, stable per-call open state and existing coverage for reversed/multiple/missing/orphan/unlinked responses and refresh while open.
> - The ordered step list (`nav ol`) renders each step as a TraceLine: waiting → `pending`, active → `running`, completed → none, failed → `error`; paused/cancelled/interrupted → none with their explicit domain label. Titles wrap. The muted status label carries the running shimmer (title shimmer was invisible on foreground text) and honors reduced motion.
> - Follow-ups from the user's manual run: every workflow tool call now uses the conversation `deriveLabel` labels instead of raw tool names. From a self-review workflow run: an unanswered call on a stopped step is labeled interrupted (e.g. "Write interrupted unfinished.ts"), never as a success; it shows as running only while the step is active.
> - Tests: `run-detail.test.tsx` asserts the Trace status for every step state and adds a regression test for unanswered `write_file_tool`/`apply_patch_tool` calls across active, interrupted, paused, cancelled and completed steps (confirmed failing without the fix). Typecheck and build passed; the full suite had 3 pre-existing main-process failures (`tool-error-feedback.integration`, `conversations` reasoning effort) that also fail without this change.
> - Manual: the user ran workflows in Electron and reported the shimmer and label issues fixed above. The full manual checklist under Verification (keyboard/focus, reduced motion, narrow widths, themes, every state) is not recorded as passed.

## Objective

Use the installed Trace primitives to present workflow step activity consistently with the rest of agent activity. Preserve the ordered workflow hierarchy and all application-owned metadata, transcript behavior, response pairing and run controls. This is a renderer-only presentation migration, not a workflow orchestration change.

## Scope

Migrate the ordered activity in `run-detail.tsx` to Trace presentation while retaining step identity/title, domain status, instructions, account/model/skill context, result/error text and live output. Preserve `StepTranscript`'s existing response-pairing adapter and its per-tool disclosures; do not replace it with `buildTimeline()` or `ToolGroup`.

Retain all matching responses for a call, raw argument strings, orphan/unlinked tool messages and existing message order. Missing responses during active or polled work must not be shown as interrupted. Preserve the current one-second polling/event-tail behavior, run outcome/error precedence and run controls.

Map workflow states explicitly: waiting to pending, active to running, completed to finished, failed to error, and paused/cancelled to a non-animated explicit domain label. Keep the domain status visible and avoid treating pause/cancellation as perpetual activity.

## Open-state and refresh behavior

Use stable step and call IDs for controlled disclosure state. Preserve the existing active-step open-state policy initially, while ensuring manual toggles survive status refreshes. Refresh must retain user-open call disclosures, and updates must not reset a reader's choice. Preserve existing closed-content resource behavior; do not keep result/media subtrees mounted solely to match native `<details>` DOM behavior.

## Constraints

Keep the ordered step list and existing transcript boundaries. Do not change workflow state machines, polling cadence, event ordering, tool pairing, result/error precedence, approvals, run controls, or persisted schemas. Keep Trace generic and free of workflow/IPC dependencies. Use Radix-compatible installed collapsible behavior; do not copy Base UI-only APIs or introduce another UI library.

## Verification

Add or update `run-detail.test.tsx` coverage for reversed response arrival, multiple responses per call, missing responses during active work, structured errors, orphan/unlinked tool messages, refresh while disclosures are open, every workflow step state, and unchanged run outcome/control behavior. Update selectors to assert user-visible content and pairing after opening the intended disclosure.

Run targeted run-detail and relevant Trace tests, then repository typecheck, full tests and build. Manually verify active/completed workflow runs, waiting/paused/cancelled/failed states, reload/interrupted behavior, refresh while open, keyboard disclosure activation, visible focus, accessible expanded state, reduced motion, narrow widths, long content, and light/dark themes in Electron. Record any qualification limitation rather than inferring it from component tests.

## Acceptance

Workflow steps and tool disclosures use Trace without loss or reordering of workflow information; response pairing remains exact across refresh and replay; open-state choices remain stable; domain statuses are understandable without color; and workflow orchestration, run controls and transcript semantics are unchanged.
