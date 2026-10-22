# PR113: Adopt shadcn Trace for agent activity

> Status: **Done.** Renderer-only adoption of the installed Trace primitives for conversation and task activity. Ordered workflow step activity is tracked separately in [PR124: Workflow Trace presentation](124-workflow-trace-presentation.md). Companion: [PR114: Code Block adoption](114-shadcn-code-block-adoption.md).
>
> **Implementation and verification record (2026-10-22):**
> - **Completed:** installed Trace primitives; tool-group and individual tool disclosures; live Thinking/retry/background-command indicators; delegated-agent result summaries; workflow tool-call disclosures retaining the existing response-pairing adapter; shared read-only todo rows for active and historical task transcripts.
> - **Manual verification completed:** conversations in Chat, Interactive, and North Star modes.
> - **Out of scope / follow-up:** ordered workflow step activity presentation is split into PR124. This status records the requested conversation-mode manual verification; it does not claim unrecorded repository test, typecheck, build, or workflow UI verification.

## Objective and recommendation

Use Trace as the common visual grammar for agent actions, not as a replacement for conversations or every collapsible surface. The highest-value migration is `ToolGroup` and its tool rows: they already hand-compose the exact summary → calls → details hierarchy Trace supplies. Follow with live activity indicators, delegated-agent result summaries, workflow tool disclosures and step activity, and read-only todo lists.

Keep application-owned data models, event handling, approval routing, result interpretation, and transcript ordering. Trace is a presentation primitive, not an orchestration engine or a new source of truth. No AI SDK integration is needed.

## Evidence and replacement inventory

All component paths below are relative to `src/renderer/src/components/` unless stated otherwise. Line references describe the research snapshot, not permanent anchors.

| Existing surface | Current implementation | Decision |
| --- | --- | --- |
| `tool-group.tsx:157–191`, `ToolGroup` | Radix Collapsible, hand-built button, Marker, spinner/chevron, count, nested rows | Primary replacement: Trace + summary TraceCollapsible + nested Trace |
| `tool-group.tsx:311–408`, `ToolUseRow` | Second hand-built collapsible and Marker with action label, approval/interrupted/error/success indicators | Primary replacement: TraceLine parts inside TraceCollapsibleTrigger; preserve detail body initially |
| `transcript.tsx`, `LiveTranscriptTurn` | Marker rows for Thinking, connection retry, background-command wait | Replace action/status indicators with noninteractive TraceLine; no fabricated reasoning content |
| `tool-group.tsx:240–309`, `SubagentResults` | Repeated result cards with identity/access/status, output and integration metadata | Replace result summary/disclosure with nested Trace; retain all metadata and transcript navigation |
| `task-transcript-sheet.tsx:130–168` | Reuses ToolGroup | Inherits tool migration without a second implementation |
| `run-detail.tsx:535–606`, `StepTranscript` | Separate native details per tool, raw arguments, paired result arrays | Replace disclosures with Trace but retain its distinct response-pairing logic |
| `run-detail.tsx`, ordered step activity | Native details cards with status, step identity, instructions, result/error and transcript | Adopt Trace inside the existing ordered list and retain the workflow metadata hierarchy |
| `todos-section.tsx:169–200` | Hand-built `[ ]`, `[>]`, `[x]`, `[~]` read-only rows | Adopt noninteractive Trace rows; retain list semantics and multiline content |
| `task-transcript-sheet.tsx:104–126` | Independent historical todo icon/status rendering | Use the same small read-only todo-row composition as TodosSection |
| `tasks-section.tsx`, task management cards | Title navigation plus independent Resume/Cancel controls and inline approval/question gates | Keep management-card layout; not a direct Trace replacement |
| `changed-files-bar.tsx` | Specialized file chips, review and preview behavior | Keep; do not duplicate as a second file activity list |
| Message/Bubble, refocus notices, outcome panels, sidebar section headers, general settings disclosures | Replies, notes, navigation or management surfaces rather than action traces | Keep |

Replacing current Marker usages does not justify deleting `ui/marker.tsx`: it remains a useful primitive for notes/dividers, and that cleanup is outside scope.

## Installed component audit

`ui/trace.tsx` exports Trace, TraceLine, TraceIcon, TraceTitle, TraceDescription and three collapsible parts. TraceLine only supports `running`, `error`, `pending`, or an omitted status for finished work. It does not own labels, timing, grouping, result parsing, or state aggregation.

The user linked Base UI documentation, but the installed component imports our local `ui/collapsible.tsx`, which wraps `radix-ui`. Use the installed API as authoritative. Do not paste Base UI `render`/`keepMounted` usage. If mounted content is required, use and test Radix-compatible behavior (`forceMount` where appropriate), with explicit hidden state and resource gating; the normal migration does not require keeping result/media subtrees mounted.

The installed animation uses `data-open`/`data-closed` selectors, while Radix emits `data-state="open|closed"`. During implementation, verify generated CSS and change Trace's own animation selectors to the matching Radix variants if necessary; do not change the shared Collapsible wrapper or add a second UI library. Keep its height variable bridge compatible with the existing accordion animation utility.

Trace uses utility classes for shimmer and modern Tailwind selectors. `globals.css` already imports `shadcn/tailwind.css`; verify compiled shimmer/reduced-motion styles rather than assuming missing styles or adding duplicate global keyframes. Normalize the new file's `cn` import to `@/lib/utils` when touching it, consistent with existing local primitives; do not remove the package as collateral cleanup.

TraceTitle truncates by default; TraceDescription does not. That is appropriate for compact action summaries, but insufficient for long todo prose, instructions, or all subagent metadata. Explicitly allow wrapping at those call sites and keep extensive metadata below the trigger. Avoid fixed-width, nonshrinking description collections that squeeze away the action title.

## Target composition and visual direction

Reuse the existing neutral foreground/muted/border tokens, destructive error color, green success accents where already meaningful, and system sans/mono fonts. No palette or typography redesign. The distinguishing structure is quiet nested action rows with a left detail rail, rather than nested bubbles/cards for every action.

```text
assistant message
  tool activity summary                         count / state
    action title                                state
      arguments / result / media                [PR114 body]
    delegated-agent summary                     duration
      identity, access, output, integration metadata
      Open transcript                           independent button
assistant reply                                  existing Markdown/Bubble
```

The group and tool rows remain closed by default, including while running or awaiting approval. This preserves current density and avoids layout churn; do not automatically open a group just because a tool needs approval. Use explicit controlled state and stable tool IDs so updates do not reset a reader's choice. Preserve the current lifetime semantics when a group is fully collapsed; do not introduce persistent disclosure storage in this migration.

Live Thinking/wait/retry lines are plain text, not buttons. “Thinking…” is an activity placeholder, not a claim that reasoning text or a measured reasoning duration exists. Do not invent sources, elapsed times, token counts, or tool-step histories absent from the current data.

## Status and labeling contract

| Domain state | Trace status | Required visible/accessibility treatment |
| --- | --- | --- |
| Tool actively running | `running` | Existing action icon, running text and one subtle running treatment; avoid a spinner plus shimmer plus extra animated indicator |
| Tool awaiting approval | `pending` | Explicit “Awaiting approval”; not an error and not active execution; approval actions remain above composer/in task card |
| Tool done | omitted | Existing action label and optional success icon; no `success` status extension |
| Tool error | `error` | Explicit “Failed” text plus useful action label; color alone is insufficient |
| Tool interrupted | omitted | Explicit “Interrupted”, muted interrupted icon; no running animation |
| Todo pending / in_progress | `pending` / `running` | Read-only status text/icon and full content |
| Todo completed / cancelled | omitted | Preserve distinct completed/cancelled text and current strike-through conventions |
| Workflow waiting / active / completed / failed | `pending` / `running` / omitted / `error` | Keep workflow domain status visible |
| Workflow paused / cancelled | omitted | Explicit domain label, never perpetual shimmer |

Derive group summary status from children with a documented precedence: actual running work, then pending approvals, then failures, otherwise settled. Include failure, awaiting-approval and interrupted counts in accessible/visible summary wording even when another state takes precedence. Do not flatten mixed outcomes into an unconditional success label. Keep the tool count discoverable.

Use `ToolUse.label` as the action description. Many existing `deriveLabel` cases do not encode failure; add a small presentation formatter/status suffix instead of rewriting every tool label or changing persisted data. Unknown tools retain the generic icon and raw-name fallback. Test pending approval separately from ordinary running status.

## Behavioral constraints and edge cases

Maintain text → tools → text interleaving, `MessageScrollerItem` boundaries, settled/live memo boundaries, scroll anchors, and changed-file chips. Do not collapse the entire assistant turn into one new Trace, regroup tools across prose, or introduce virtualization/timing changes.

Retain the 4,000-character tool result display cap and error-prefix detection, malformed-argument fallback, structured subagent interpretation, read-only interrupted note, and all media provenance IDs. An unopened group or unopened tool must not fetch media. Closing the row must unload its media subtree as today. Moving the shell to Trace must not change approval callbacks, scopes, keyboard shortcuts, or whether a gate is actionable.

Subagent result status is not simply completed versus error: map known active/pending/failed states explicitly and leave unknown states visible without falsely assigning an error. Keep identity, access, duration, usage, files/commits, branch, mergeability, integration status/branch and Open transcript behavior. Navigation is a separate button in expanded content, never a button nested inside the disclosure button.

Workflow `StepTranscript` is a particularly important boundary. It preserves all matching responses as arrays and also displays orphan/unlinked tool messages. `buildTimeline()` instead retains only the last matching result, drops unmatched tool rows, and marks missing results interrupted on replay. Therefore do **not** replace the workflow adapter with `buildTimeline()` or blindly reuse ToolGroup. Retain its current pairing model and replace only its presentation. Missing results in an active/polled step must not be mislabeled interrupted. Keep raw argument strings, all responses, message ordering, and the current one-second polling/event-tail behavior.

Native details currently keeps workflow response DOM mounted while closed; Radix normally does not. Preserve information and resource behavior, not incidental DOM counts. Update tests to open the intended disclosure and assert observable content and correct pairing. Refresh must preserve user-open state by stable call/step IDs. Outer workflow step open-state policy should follow existing active-step behavior initially, and manual toggles must survive a status refresh. Avoid changing run controls or result/error precedence.

## Implementation sequence

### Phase A: Primitive compatibility and core tool activity

Establish primitive compatibility and migrate ToolGroup/ToolUseRow with existing detail bodies untouched. Add focused tool-group tests and run media/approval/transcript regressions before expanding scope. Keep the `ToolGroup({ calls })` public API unchanged.

### Phase B: Live indicators and delegated results

Migrate live activity placeholders and SubagentResults. Preserve transcript memo boundaries and side-effect-free rendering. This phase is independent of Code Block.

### Phase C: Workflow activity and tool disclosures

Migrate workflow step disclosures and StepTranscript tool disclosures while retaining their current adapters. Keep the ordered list, titles, status, instructions, account/model/skill context, result/error text and live output. Add refresh/pairing tests before removing old native disclosures.

### Phase D: Read-only todo presentation

Migrate active and historical read-only todos. A small shared `TodoTraceList` is justified to eliminate the two status/icon implementations; accept only normalized content/status/identity data, with no fetching or handoff logic. Keep `ul`/`li` semantics, long wrapping content and the existing Run all in background button/race protections.

### Phase E: Coordinate payload presentation

Coordinate with PR114 to put compact Code Blocks inside Trace details. PR113 must remain independently mergeable with the old detail bodies; PR114 owns code/output chrome, copy behavior, and code-specific tests.

## File and ownership map

Modify `ui/trace.tsx`, `tool-group.tsx`, `transcript.tsx`, `run-detail.tsx`, `todos-section.tsx`, `task-transcript-sheet.tsx`; add a narrow todo presentation component only if needed for the two consumers. Keep generic Trace free of ToolUse, Todo, workflow and IPC dependencies. Add `tool-group.test.tsx` and primitive tests where needed; extend `transcript.test.tsx`, `run-detail.test.tsx`, `todos-section.test.tsx`, and media regressions. A dedicated historical todo/subagent test file is appropriate if clearer than extending unrelated suites.

No database, provider, main-process, IPC, approval policy, or persisted message schema changes. `lib/timeline.ts` behavior remains intact.

## Verification and acceptance

Unit/component coverage must prove summary counts and mixed-state precedence; running/done/error/interrupted/pending approval transitions; unknown tools and invalid raw arguments; disclosure updates without losing open state; group and row lazy media loading/unloading; 4,000-character clipping; retained subagent metadata/navigation; no nested interactive controls; and todos with all four statuses and long content.

Workflow tests must cover reversed response arrival, multiple responses for one call, missing responses during active work, structured errors, orphan/unlinked tool messages, refresh while opened, all step statuses, and unchanged run outcome/control behavior. Retain the existing pairing regression in `run-detail.test.tsx` while replacing native-details-specific selectors.

Run targeted suites (`tool-group`, `transcript`, `tool-media-preview`, `approval-card`, `run-detail`, `todos-section`, plus new primitive/todo tests), then the repository checks in a later implementation session:

```sh
pnpm test -- src/renderer/src/components/tool-group.test.tsx src/renderer/src/components/transcript.test.tsx src/renderer/src/components/tool-media-preview.test.tsx src/renderer/src/components/approval-card.test.tsx src/renderer/src/components/run-detail.test.tsx src/renderer/src/components/todos-section.test.tsx
pnpm typecheck
pnpm test
pnpm build
```

Include any newly added primitive/todo suites in the targeted run as well.

Manual Electron checks must exercise live and historical chat, task transcripts, active/completed workflow runs, approval waits, interrupted reloads, delegation, retries, conversation switching and long output. Check narrow chat/sidebar widths, light/dark themes, long titles, bottom following/off-bottom reading, Enter/Space disclosure activation, visible focus, accessible expanded state, and reduced motion. Inspect actual computed animation/shimmer behavior because happy-dom cannot validate CSS/layout or screen-reader announcements.

Accepted when direct action surfaces use Trace without losing data, approvals stay actionable in their current location, status is understandable without color, collapsed media remains lazy, workflow pairing stays correct, and no orchestration changes are necessary. Roll back by phase if a behavior regression appears; do not ship parallel legacy/new renderers or a permanent feature flag merely to migrate presentation.

## Deferred opportunities and non-goals

Do not add synthetic reasoning streams, source extraction, timer telemetry, test-result parsers, stack-frame parsing, command streaming infrastructure, or new subagent transcript fetching. Those upstream Trace examples are compositions supported by other data contracts, not features this migration obtains automatically. Keep task management cards, the specialized file tree, changed-file chips, outcome panels and general notes/navigation unchanged.

## Sources and research limitations

Upstream references are [Trace](https://ui.shadcn.com/docs/components/base/trace) and [Code Block](https://ui.shadcn.com/docs/components/base/code-block). Installed `ui/trace.tsx` and `ui/collapsible.tsx` govern local API behavior. Related design constraints are [PR95](095-streaming-markdown-rendering.md) and [PR97](097-transcript-render-boundaries-and-virtualization.md); current source and tests take precedence over historical plan descriptions.

Research inspected source and existing tests; it did not execute the proposed migration, tests, build, or runtime UI verification. The existing uncommitted component/helper additions and package changes belong to the user and must be preserved. This document records future implementation work, not completed behavior.
