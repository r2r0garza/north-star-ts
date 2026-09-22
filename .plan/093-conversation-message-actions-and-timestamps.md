# PR93: Conversation message copy actions and timestamps

> Status: **COMPLETED**. The primary conversation now renders a reserved metadata/action row beneath each user and assistant text message. Persisted, optimistic, and live timestamps remain stable and always visible; the latest assistant copy action stays visible; other copy actions reveal immediately on hover or focus with a no-hover fallback; and exact source-copy success/failure behavior is covered by focused tests.

## Goal

Make conversation messages easier to reuse and place in time without permanently adding controls beneath every bubble.

- The latest assistant response always shows a copy button beneath it.
- Every other user or assistant message shows its copy button as soon as the pointer is over that message.
- Every user and assistant message always shows its sent/received date and time.

The requested interaction is ordinary hover behavior, but it must use an immediate CSS state rather than a delayed tooltip, timer, or animated reveal. Keyboard and touch users need equivalent access.

## Current state

- `src/renderer/src/App.tsx` renders the primary transcript from `displayTimeline`. Text items become user or assistant bubbles; tool groups render separately.
- `src/renderer/src/lib/timeline.ts` defines text timeline items with only `key`, `role`, and `content`. `buildTimeline()` receives persisted `Message` rows but currently drops their `createdAt` values.
- Persisted message rows already have millisecond `createdAt` timestamps, populated by `appendMessage()` in `src/main/db/repositories/messages.ts`. No schema migration or new IPC endpoint is required.
- The send path optimistically appends the user text before reloading persisted rows, so optimistic text items need a temporary timestamp to prevent their metadata from appearing only after reconciliation.
- The in-flight assistant turn is rendered separately from `displayTimeline` as streamed text/tool segments. It does not currently carry a renderer timestamp.
- `src/renderer/src/components/ui/message.tsx` already marks the whole message as `group/message` and provides `MessageFooter`, but the conversation does not currently render a footer.
- `src/renderer/src/components/task-transcript-sheet.tsx` also consumes `TimelineItem`. Its read-only task transcript is a separate surface and must continue compiling if the shared timeline type gains metadata.

## Product decisions

1. **Message scope.** In this plan, a message means a rendered user or assistant text message. Tool-call groups are activity associated with an assistant turn, not separately copyable or timestamped messages. Existing per-code-block copy behavior, if any, remains independent.
2. **Latest assistant response.** Find the final assistant text message in the rendered conversation, not merely the final timeline item. Its copy button remains visible even when a tool group or a newer user message follows it. During an active turn, the streamed assistant response becomes the latest assistant response as soon as it has text; the previous assistant message then uses normal reveal behavior.
3. **Copy payload.** Copy the message's complete underlying plain source string exactly as represented by the text timeline item. For assistant messages, copy Markdown source rather than rendered DOM text so links, lists, and code fences are preserved. Do not include the timestamp, role label, tool results, or other message controls.
4. **Immediate reveal.** Use CSS `:hover`/group-hover and `:focus-within` (or equivalent React state only if CSS cannot express the final layout). Do not use a tooltip as the visibility mechanism, add a hover delay, or add an opacity/transform transition that makes the controls lag behind pointer entry.
5. **Footer contents.** Place a compact row directly beneath the bubble. Assistant rows align to the left and user rows align to the right. The row contains the always-visible localized date/time and an icon copy button with an accessible name. The latest assistant's copy button is visible at rest; other copy buttons follow the reveal rule.
6. **Time semantics.** Persisted messages use their existing `createdAt`. An optimistic user message uses one captured `Date.now()` value that remains stable for that item until reconciliation. A streamed assistant response captures a stable received time when its first visible text arrives; the persisted timestamp replaces it after settlement. Do not recompute either timestamp during rerenders.
7. **Date/time format.** Show both calendar date and local time using `Intl.DateTimeFormat`/`toLocaleString`, respecting the user's locale and OS time zone. Include the full machine-readable instant in a `<time dateTime={...}>` element. Seconds are not required.
8. **Copy feedback and failure.** Use `navigator.clipboard.writeText()`. Give immediate, non-layout-shifting success feedback (for example, swapping the icon/accessible label briefly) and report a rejected clipboard write through the app's existing toast pattern. A failure must leave the message and controls usable for retry.
9. **Keyboard and touch parity.** Revealed controls remain visible while focus is within the message, and the copy button has normal tab focus and a visible focus ring. On devices that do not support hover, show the metadata/action row without requiring a synthetic hover gesture; the latest-assistant rule remains naturally satisfied.
10. **Stable layout.** Revealing the row must not cover message content, change bubble width, or cause neighboring messages to jump vertically. Reserve the compact footer line in the message layout and switch hidden content with `visibility`/`opacity` without a transition, while keeping hidden controls out of keyboard and pointer interaction until revealed. If always reserving a line produces unacceptable transcript density during implementation, use an equivalent overlay/gutter treatment only if it remains visually underneath the bubble and does not overlap content.
11. **Accessibility labels.** A copy icon alone must expose `aria-label="Copy message"`. Success feedback should become `aria-label="Message copied"` and/or use the existing polite toast/live-region system. The timestamp remains real text, not tooltip-only content.

## Architecture

### Timeline metadata

Extend text timeline items with their timestamp:

```ts
export type TimelineItem =
  | {
      kind: "text"
      key: string
      role: "user" | "assistant"
      content: string
      createdAt: number
    }
  | { kind: "tools"; key: string; calls: ToolUse[] }
```

`buildTimeline()` should copy `m.createdAt` onto every emitted user/assistant text item. If one persisted assistant row emits both text and tools, only the text item receives the message footer; the tools item continues to render as activity.

The optimistic user append in `App.tsx` must capture a timestamp once alongside the new timeline item. Renderer-only error messages currently inserted by `pushError()` also need a stable timestamp if they remain represented as assistant text messages; alternatively, make their non-message status explicit rather than weakening the timeline type with an optional timestamp.

### Live assistant metadata

Add a nullable timestamp to `LiveTurn` (for example, `firstTextAt`). Set it once when the first non-empty assistant text delta is accepted for that conversation. Preserve it across additional deltas, tool calls, retries, approvals, and conversation switching. Reset it when a new live turn is seeded and discard it when the turn settles.

Do not stamp a response while the UI shows only “Thinking…” or tool activity: there is no copyable assistant text message yet. Once text exists, render one footer for the complete live assistant response, not one footer per internal streaming segment. The copy payload should concatenate the live response's text segments in display order using the same semantics that produce the settled assistant content. If the current segment model cannot guarantee a lossless whole-response string, derive and test a small helper rather than reading text back from the DOM.

### Message metadata/action component

Introduce a focused renderer component, such as `ConversationMessageMeta`, rather than embedding clipboard state and visibility classes throughout the transcript map. Suggested props are:

```ts
type ConversationMessageMetaProps = {
  content: string
  createdAt: number
  align: "start" | "end"
  copyAlwaysVisible: boolean
}
```

The component owns date formatting, copy success/failure state, button labeling, and the immediate reveal classes. Mount it through `MessageFooter` beneath each text bubble. Keep determination of “latest assistant response” in the transcript composition layer because it depends on sibling timeline/live-turn state, not on one message in isolation.

Use a small pure helper to locate the latest assistant text item and another helper for date formatting if that makes boundary behavior directly testable. Do not infer latest-assistant status from DOM order or CSS selectors spanning tool groups.

## Implementation plan

### 1. Preserve timestamps in rendered text items

Add required `createdAt` metadata to the text branch of `TimelineItem` and propagate persisted message timestamps in `buildTimeline()`. Update optimistic user messages and local assistant/error items to capture a stable timestamp at creation. Fix all timeline consumers intentionally rather than making the field optional.

Add focused `buildTimeline()` tests covering user and assistant timestamps, an assistant row containing both text and tool calls, empty-content rows, and message ordering.

### 2. Track the live assistant response time and copyable content

Extend `LiveTurn` so the first visible text establishes one received timestamp. Ensure retry checkpoints and conversation switching do not reset it. Add or extract a helper that returns the complete visible assistant text in order for the live copy action.

Cover a text-only stream, text split around tool activity, retries/replayed deltas, tool-only progress before first text, and reset between turns. Verify that an empty “Thinking…” state has no message footer.

### 3. Build the reusable metadata/action row

Add a compact component near the conversation/message UI that:

- renders a semantic localized `<time>` value;
- copies the supplied source string with `navigator.clipboard.writeText()`;
- gives short success feedback and recoverable failure feedback;
- supports start/end alignment;
- keeps timestamps visible while independently controlling copy-button visibility; and
- applies immediate pointer/focus reveal with no delay or reveal animation.

Use existing button primitives and icon sizing where they fit. Avoid a new preload/main-process clipboard API unless Electron's current renderer permissions prove `navigator.clipboard` unusable in the packaged application.

### 4. Integrate the footer into the primary conversation

Before rendering, identify the key of the latest settled assistant text item. If the active live turn contains assistant text, treat the live response as latest and do not keep the prior settled assistant copy button permanently visible.

Mount one metadata row beneath every user/assistant text bubble in `displayTimeline`. Mount one metadata row beneath the complete live assistant response when it has text. Keep tool groups, pending markers, approvals, and changed-file bars unchanged.

Pay particular attention to assistant turns whose visible output is split into multiple streamed segments around tool calls: the footer belongs to the overall response and must not appear repeatedly after each segment.

### 5. Keep secondary timeline consumers compatible

Update `task-transcript-sheet.tsx` for the required timeline timestamp shape. The requested product surface is the primary conversation transcript; either reuse the metadata row in the task sheet if that is a natural no-risk extension, or deliberately leave task transcript rendering unchanged while retaining the metadata in its timeline items. Do not accidentally introduce copy visibility rules based on the primary conversation's live state into the task sheet.

### 6. Verify interaction, accessibility, and regressions

Add component tests using the project's existing renderer test conventions. Mock the Clipboard API and fake timers only for resetting success feedback. Verify success and rejection paths without depending on real system clipboard state.

Manually exercise long Markdown responses, multiline user messages, code fences, a conversation with interleaved tool calls, an actively streaming response, switching away and back during streaming, light/dark themes, narrow windows, keyboard navigation, and a hover-capable pointer. Use browser/device emulation or an equivalent CSS check for the no-hover fallback.

Run focused renderer tests, then `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Acceptance criteria

- Every rendered user and assistant text message in the primary conversation has a date/time and copy action beneath its bubble.
- The final assistant text response's copy button is visible without pointer hover or keyboard focus.
- Copy buttons for all other messages become visible immediately when the pointer enters the corresponding message; no timer, tooltip delay, or reveal animation is involved.
- Every message's date and time remain visible without pointer hover or keyboard focus.
- Moving the pointer away hides non-latest copy actions; focus within the message keeps its copy action available.
- No-hover devices expose the controls without requiring hover emulation, and keyboard users can reach every copy button with a visible focus indicator.
- Copying an assistant message preserves its Markdown source; copying a user message preserves its exact multiline text. Timestamps and tool activity are not included.
- Copy success is announced or visibly confirmed without shifting the transcript. Clipboard rejection produces a bounded error and permits retry.
- Persisted timestamps survive reload, optimistic user timestamps appear immediately, and a live assistant timestamp remains stable throughout one streamed response.
- Timestamp formatting includes both date and local time and respects the user's locale/time zone.
- Tool groups do not receive duplicate message footers, and a response split around tool activity receives one coherent copy action.
- Showing or hiding metadata does not overlap bubble content, change bubble width, or cause neighboring messages to jump.
- Existing autoscroll, scroll anchors, Markdown rendering, tool activity, approvals/questions, changed-file controls, and task transcript rendering continue to work.

## Likely files

- Modify: `src/renderer/src/lib/timeline.ts`
- Add: focused timeline tests beside `timeline.ts`
- Modify: `src/renderer/src/App.tsx`
- Add: `src/renderer/src/components/conversation-message-meta.tsx` (exact name may follow local conventions)
- Add: component/helper tests for metadata visibility, formatting, clipboard success, and clipboard failure
- Possibly modify: `src/renderer/src/components/ui/message.tsx` if `MessageFooter` needs a small accessibility/layout refinement
- Modify: `src/renderer/src/components/task-transcript-sheet.tsx` for the required timeline metadata shape and deliberate secondary-surface behavior

## Out of scope

- Copying tool-call inputs/results or whole assistant turns that contain no text.
- Editing, deleting, retrying, reacting to, quoting, or branching from a message.
- Per-code-block copy controls or changes to Markdown rendering.
- Relative-time labels that update on an interval; this plan uses the stored absolute local date/time.
- New timestamp persistence, database migrations, or IPC APIs—the required persisted timestamp already exists.
- Changing the semantic creation time stored by the main process.
- Retrofitting message controls into Process monitors, approval cards, notifications, or every transcript-like surface in the application.
