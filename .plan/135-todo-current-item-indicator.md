# PR135: Keep the active todo item visible beside the response timer

> Status: Proposal only. No application code changed and no tests or UI verification run. Intended repository document: `.plan/135-todo-current-item-indicator.md`.
>
> Approval scope for this task: create this Markdown document in `.plan/` only. Approval does not authorize implementation of the application changes described below.

## Objective

When an agent is responding and a conversation has a todo list with an item in progress, show that item's content next to the response timer at the bottom of the conversation. This keeps the user's immediate progress context visible without opening the info sidebar. Reuse the same shimmer treatment used for running tools. The info sidebar remains available for the complete list, including previous, current, and future steps.

## Product contract

- Display the active todo item beside the response timer while the agent is responding. The indicator is supplementary; it must not replace, hide, or make the timer harder to read.
- Show the content of the todo whose status is `in_progress`, not a guessed item derived from list position, tool arguments, or the most recent tool call.
- Use the existing running-tool shimmer treatment for the active item. Honor reduced-motion behavior in the same way as the existing treatment.
- Keep the full todo list and its previous/current/future context in the info sidebar. Do not add a second checklist or duplicate the entire list beside the timer.
- When no item is in progress, the todo list is empty, or the agent is not responding, do not show a stale current-item indicator or perpetual shimmer.
- Handle long item text by truncating it within the available footer space, with an accessible way to obtain the full text (for example, the existing tooltip/title pattern). Keep the timer and other footer controls usable at narrow widths.

## Source investigation required during implementation

Trace the existing footer timer and its responding/streaming state to identify the narrowest renderer integration point. Trace how the conversation's todo data is loaded and refreshed, including `todo_write` updates, conversation switches, reloads, and completion of a response. Prefer an existing renderer data source or subscription over new polling or duplicated state. Confirm the existing tool-running shimmer class/component and its reduced-motion behavior; reuse it rather than inventing another animation.

The `todo_write` contract and the existing info-sidebar todo presentation are described in `.plan/003-todo-tool.md`; treat that plan as historical context and verify the current source before implementation.

## Implementation shape

1. Identify the footer timer component and the source of truth for the current conversation's todos. Ensure todo updates reach the footer promptly when an item becomes `in_progress`, changes content/status, or is cleared.
2. Derive the visible label from the current conversation's todo list by selecting the item with status `in_progress`. Keep this derivation aligned with the todo tool's supported status semantics; if malformed or multiple active items are possible, do not silently present a misleading selection—follow the established normalization/ordering contract and document the behavior.
3. Render the label adjacent to the timer only while the assistant is actively responding and an in-progress item exists. Use the established running shimmer treatment and existing design-system primitives.
4. Preserve the info sidebar's full ordered todo list, status markers, and existing interactions. This change is an at-a-glance companion, not a replacement.
5. Add focused renderer tests for display and suppression conditions, updates, and long text. Keep component scope narrow; avoid changes to todo persistence or agent behavior unless source investigation proves they are necessary for the UI to receive current data.

## Acceptance coverage

- During a response with one `in_progress` todo, its content appears beside the timer with the established running shimmer.
- The timer remains visible and legible; the indicator and timer do not overlap at supported narrow widths.
- Marking an item in progress, updating its content, completing it, or clearing/replacing the list updates or removes the indicator without requiring a sidebar open/close or conversation reload.
- No item, an empty list, a non-responding conversation, or a completed response produces no active shimmer or stale label.
- Switching conversations shows only that conversation's active item; historical messages do not inherit a currently responding indicator.
- Long content is bounded in the footer and the full text remains accessible.
- The sidebar continues to show previous, current, and future items with their existing statuses.
- Tests cover relevant rendering and state transitions; run focused tests, typecheck, and build. Manually verify the footer in Electron at narrow and regular widths and with reduced motion enabled.

## Risks and exclusions

The footer has limited horizontal space, especially when other controls are present. Keep the indicator compact and subordinate to the timer, and verify responsive behavior rather than allowing it to crowd out controls. Stale todo state or tying visibility only to tool execution could cause the label to lag or disappear during ordinary response streaming; use the live conversation todo source and assistant-response state.

Do not add a new todo-management interaction, sidebar redesign, persistence model, polling loop, setting, global todo list, or additional animation. Do not alter the semantics or ordering of todo items as part of this UI change. No source analysis, implementation, tests, or runtime verification were performed for this proposal.
