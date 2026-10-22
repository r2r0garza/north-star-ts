# PR124: Workflow Trace presentation

> Status: **Proposed.** Complete the workflow step-activity portion split from [PR113: shadcn Trace adoption](113-shadcn-trace-adoption.md). PR113 covers conversation and task activity; this plan focuses on ordered workflow steps and their existing lifecycle behavior.

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
