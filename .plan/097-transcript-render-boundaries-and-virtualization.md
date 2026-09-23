# PR97: Transcript render boundaries and measured virtualization

> Status: **COMPLETED (render boundaries); virtualization NOT PURSUED**. Settled transcript rows and the live turn are now separate memoized render boundaries. Profiling after the extraction shows per-delta renderer cost is flat with conversation length, so variable-height virtualization is not justified and is deliberately left out.

## Goal

Prevent streamed deltas from needlessly reconciling the complete settled timeline and make the large conversation component easier to reason about, without destabilizing scrolling or message interaction.

## Analysis findings

### Where the cost was

Before this change, `App.tsx` rendered every settled row inline inside the same component that owns the live turn. Each token delta updates `liveTurns` state, so App rerendered and React reconciled every settled row's full subtree: `MessageScrollerItem`, `Message`, `Bubble`, `ConversationMessageMeta` (including `Intl` timestamp formatting), `ConversationFindText`, `ToolGroup` and its rows, and `ChangedFilesBar`. Only `Markdown` was memoized, so settled Markdown was not reparsed, but everything around it was reconciled.

Three props also defeated any boundary:

- `displayTimeline` was an IIFE producing a new array (`timeline.slice`) on every render while a live turn existed.
- `ChangedFilesBar` received inline arrow callbacks, and the parent's `onOpenHtml`/`onReviewFiles` are themselves recreated on every Shell render.
- `updateLiveTool` rebuilt every tools segment on any tool event, not only the one containing the updated call.

### Profiling

A temporary happy-dom/React `Profiler` probe (removed before merge) mounted a synthetic conversation of repeating user text, two-call tool groups, and assistant Markdown (heading, prose, list, TypeScript fence, table) inside the real `MessageScroller` primitives, then applied 120 streamed deltas to a live turn (tools segment + growing text with periodic fences). The "before" arm reproduced the previous inline App JSX; the "after" arm used the extracted components. Two warmed runs per arm:

| Settled rows | Before (per delta) | After (per delta) | DOM nodes |
| ------------ | ------------------ | ----------------- | --------- |
| 300          | ~23–25 ms          | ~0.8–0.9 ms       | ~6.8k     |
| 1,000        | ~87–89 ms          | ~1.0 ms           | ~22.4k    |

(Wall time around `act()` per delta; React `Profiler` `actualDuration` totals were ~2.1 s vs ~0.08 s at 300 rows and ~7.6 s vs ~0.11 s at 1,000 rows.) The previous cost grew linearly with conversation length; after extraction it is essentially constant and dominated by the live segment's own streaming Markdown parse. These are jsdom-class numbers, not Electron paint timings, and are not a product threshold; they establish the shape of the cost and the size of the improvement.

### Virtualization decision

Not pursued. Remaining costs after the boundary are:

- **Per-delta reconciliation**: flat (~1 ms at 1,000 rows), so virtualization would not improve streaming.
- **Layout/paint of off-screen rows**: already bounded by `MessageScrollerItem`'s `content-visibility: auto` with `contain-intrinsic-size: auto 10rem`, which lets Chromium skip rendering work for off-screen rows while keeping them in the DOM.
- **Mount cost when opening a very long conversation** (~0.3 s at 300 rows, ~1 s at 1,000 rows in the probe): real but one-off per switch, not a streaming problem.

Virtualization would trade these away against concrete regressions: native browser find and the in-conversation find (which queries `[data-conversation-find-match]` across the DOM) would miss unmounted rows; text selection across rows and select-all would break at the window edge; `MessageScroller`'s anchor/`last-anchor` restoration and the settle-time off-bottom preservation would need re-implementing against estimated heights; and expandable tool groups, Mermaid, and code blocks change height after mount. `content-visibility: auto` keeps all of those correct because off-screen content remains in the DOM and remains findable.

Revisit only with a new measurement showing conversation-open mount time or memory is a real problem in the packaged app; a first step there would be deferring settled-row mounting (e.g. mounting an initial tail and expanding on scroll-up) rather than full windowing.

## Implementation

### New `src/renderer/src/components/transcript.tsx`

- `SettledTranscript` (memo): maps `TimelineItem`s to rows; computes each row's `scrollAnchor` (last row only when `anchorLast`) and `copyAlwaysVisible` (latest settled assistant key).
- `SettledTranscriptRow` (memo): one persisted text or tools row, identical markup to the previous inline JSX. Row-level memo means a list-level change (anchor moving, latest-assistant key changing) rerenders only the affected rows.
- `LiveTranscriptTurn`: the in-flight turn — interleaved segments, "Thinking…"/retrying/command-wait markers, and the live copy/timestamp footer. Rerenders per delta by design.
- `LiveTranscriptSegment` (memo): one live text or tools segment, so unchanged earlier segments (preamble text, completed tool groups) skip reconciliation while the trailing text grows. Text segments keep `mode="streaming"` from plan `095`.
- `LiveSegment` type moved here from `App.tsx`.

### `App.tsx`

- `displayTimeline` is `useMemo` on `[hasLiveTurn, timeline]` — the boolean, not the turn — so its identity is stable across deltas.
- Stable `openTranscriptHtml` / `reviewTranscriptFiles` wrappers read the latest parent callbacks from refs.
- `updateLiveTool` only copies the tools segment that contains the updated call; other segments keep their identity.
- The transcript JSX is replaced by `<SettledTranscript … />` and `{loading && <LiveTranscriptTurn … />}`. Scroll handlers, `MessageScrollerProvider`/`Viewport`/`Content`, the scroll-to-bottom button, find-in-conversation effects, and settlement sequencing are unchanged.

Anchor semantics are preserved exactly: previously the last settled row was the anchor when `!loading && !suppressSettledAnchor`; that expression is now `anchorLast`, and the live item is always an anchor while loading.

### Tests

`src/renderer/src/components/transcript.test.tsx` (happy-dom) counts renders at row leaves via mocked `Markdown`, `ConversationFindText`, and `ToolGroup`:

- streamed live-text updates do not rerender any settled row;
- unchanged earlier live segments (text and tools) are not rerendered when the trailing text grows;
- live segments render in streamed order, all text in streaming mode;
- the scroll anchor moves between the live turn and the last settled row, and moving it rerenders only the affected row;
- find-query changes still propagate to settled and live rows;
- waiting markers (thinking / retrying / command wait);
- the latest settled assistant copy action stays always visible.

## Acceptance

- Live deltas do not rerender unchanged settled message rows. ✅ (tested; profiled)
- Autoscroll, scroll-to-bottom, anchors, selection, copy controls, tool expansion, approvals, and conversation switching: markup, anchor expressions, and scroll handlers are unchanged; tool expansion state lives in `ToolGroup` and survives because row keys are unchanged. Approvals and questions render above the composer, outside the transcript, and are unaffected.
- The virtualization decision is backed by before/after measurements with explicit accessibility/browser-find tradeoffs (above).
- `App.tsx` decomposition follows the settled/live behavior boundary, not line counts.

## Verification

```sh
pnpm test -- src/renderer/src/components/transcript.test.tsx
pnpm typecheck
pnpm test
pnpm build
```

Focused suite (7 tests), `pnpm typecheck`, Prettier checks, and `pnpm build` pass. The ordinary suite passes except the four pre-existing CLI parser tests whose ignored `cli_probes` fixtures are absent from this checkout.

Manual verification in the running app (long stream with follow and off-bottom reading, tool expansion during a stream, settle transition, conversation switch mid-stream, find during a stream) is still recommended before merge; this implementation was verified by tests and profiling only.

## Out of scope

- Changing transcript data persistence or stream protocol.
- Virtualizing merely to reduce source-file length.
- Deferred mounting of very long conversations on open (see decision above).
