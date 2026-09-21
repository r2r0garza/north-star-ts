# PR97: Transcript render boundaries and measured virtualization

> Status: **DEFERRED**. First isolate settled transcript rendering from live-turn updates; add variable-height virtualization only if profiling still demonstrates a material long-conversation problem.

## Goal

Prevent streamed deltas from needlessly reconciling the complete settled timeline and make the large conversation component easier to reason about, without destabilizing scrolling or message interaction.

## Activation condition

Activate after `095` and the overlapping message-composition work in `093` settle. Capture a reproducible long-transcript profile showing remaining renderer cost. Virtualization is required only if component boundaries and memoization are insufficient.

## Required plan/analysis pass

Re-profile reconciliation, DOM node count, memory, scroll anchoring, text selection, browser find, expandable tool groups, approvals/questions, and code/diagram height changes. Decide and document whether the implementation ends at component extraction or proceeds to a specific virtualization library/strategy.

## Expected first slice

Extract a memoized settled-message list/item boundary and a separate live-turn renderer from `App.tsx`. Stabilize props and callbacks so live token updates do not rerender settled rows. Preserve `MessageScroller` anchoring and the ordering of text/tool segments.

If profiling justifies virtualization, design for variable-height rows, dynamic content, restoration when switching conversations, keyboard accessibility, selectable text, browser find expectations, and expansion-induced measurements before choosing a library.

## Acceptance

- Live deltas do not rerender unchanged settled message rows.
- Existing autoscroll, scroll-to-bottom, anchors, selection, copy controls, tool expansion, approvals, and conversation switching remain correct.
- Any virtualization decision is supported by before/after measurements and has explicit accessibility/browser-find tradeoffs.
- `App.tsx` decomposition follows behavior boundaries rather than arbitrary line-count targets.

## Likely files

- `src/renderer/src/App.tsx`
- New focused transcript/live-turn components and tests
- Message-scroller utilities if measurement proves changes are needed

## Out of scope

- Changing transcript data persistence or stream protocol.
- Virtualizing merely to reduce source-file length.
