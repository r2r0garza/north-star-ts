# PR95: Lightweight Markdown rendering while streaming

> Status: **PLANNED**. Avoid repeatedly syntax-highlighting and diagram-rendering the entire growing assistant response on every streamed delta, then render full Markdown when the response settles.

## Goal

Keep long, code-heavy assistant streams responsive while preserving the final rendered Markdown, syntax highlighting, copy behavior, and Mermaid output.

## Current state

- `Markdown` always enables `rehype-highlight`.
- The live assistant path at `src/renderer/src/App.tsx` renders growing text segments through `Markdown` on every stream update.
- `memo()` does not help the changing live segment because its `content` prop changes.
- Settled transcript messages are stable and should continue to receive the complete renderer.
- Incomplete Mermaid source can also trigger repeated expensive work or noisy failures while streaming.

## Required plan/analysis pass

Before implementation, trace how text deltas form `LiveTurn.segments`, how a live turn reconciles into the settled timeline, and how retries or tool-interleaved text affect segment identity. Profile or instrument representative long code and Mermaid responses enough to choose between an explicit lightweight streaming mode and a bounded update throttle. Update this plan with the selected behavior before editing production code.

The default direction is explicit mode rather than time-based debouncing: settled content remains fully rendered, while live content parses ordinary Markdown but skips syntax highlighting and Mermaid rendering until settlement. Analysis must confirm that this avoids flicker, preserves readable code fences, and does not break scroll anchoring.

## Design constraints

- The streaming/settled distinction must be explicit at the call site; do not infer it from timing or content shape.
- Final settled messages must use the existing highlighted rendering.
- Streaming code fences remain readable and copyable as source.
- Mermaid fences render as inert code while incomplete and become diagrams only after settlement.
- Avoid global timers, idle callbacks with stale commits, or a second source of truth for streamed text unless measurement shows they are necessary.
- Keep `Markdown`'s default behavior unchanged for non-streaming consumers.

## Verification and acceptance

- Growing live responses do not invoke syntax highlighting or Mermaid rendering on each delta.
- Once settled, the same source receives normal highlighting and Mermaid behavior.
- Plain prose, GFM, links, inline code, fenced code copy, tool-interleaved segments, retries, and conversation switching retain their behavior.
- Add focused renderer tests for streaming versus settled code and Mermaid fences.
- Manually exercise a long code-heavy stream and check responsiveness, scroll following, and the final transition.
- Run focused renderer tests, `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Likely files

- `src/renderer/src/components/markdown.tsx`
- `src/renderer/src/components/markdown.test.tsx`
- `src/renderer/src/App.tsx`
- Possibly a small dedicated live-Markdown helper/component if analysis justifies it

## Coordination

Plan `093` also changes primary transcript composition. Implement this performance boundary before or deliberately alongside `093` to minimize conflicting edits and preserve one coherent live-message rendering contract.

## Out of scope

- Transcript virtualization or broad `App.tsx` decomposition; tracked separately.
- Replacing the Markdown parser/highlighter stack.
- Changing persisted assistant content or stream protocol semantics.
