# PR95: Lightweight Markdown rendering while streaming

> Status: **COMPLETED**. Live assistant text now uses an explicit lightweight Markdown mode that retains Markdown/GFM parsing and copyable code-block chrome while deferring syntax highlighting and Mermaid rendering until the turn reconciles into the settled transcript.

## Goal

Keep long, code-heavy assistant streams responsive while preserving the final rendered Markdown, syntax highlighting, copy behavior, and Mermaid output.

## Selected behavior

Add an explicit `mode` to `Markdown`, with `"settled"` as the default and `"streaming"` as the only opt-in lightweight path.

| Capability                               | Streaming mode                                | Settled/default mode  |
| ---------------------------------------- | --------------------------------------------- | --------------------- |
| CommonMark and GFM parsing               | Yes                                           | Yes                   |
| Prose, links, lists, tables, inline code | Existing behavior                             | Existing behavior     |
| Fenced code block chrome and copy action | Yes                                           | Yes                   |
| Syntax highlighting (`rehype-highlight`) | No                                            | Yes                   |
| Mermaid fence                            | Raw fenced source in normal code-block chrome | Rendered by `Mermaid` |

The primary transcript passes `mode="streaming"` only for text segments in the active `LiveTurn`. Persisted assistant messages and every other existing `Markdown` consumer omit the prop and retain the current full renderer.

Do not add a token throttle or debounce in this PR. The remaining ordinary Markdown parse still runs on each changed text segment, but removing the two expensive enrichments addresses the measured hot path without delayed output, timer cleanup, stale commits, or a second text buffer. If later profiling shows ordinary parsing itself is still a bottleneck, bounded scheduling is a separate follow-up backed by new measurements.

## Analysis findings

### Live segment formation and identity

`App.tsx` keeps one `LiveTurn` per conversation. `appendLiveText()` extends the trailing text segment when consecutive token events arrive and creates a new text segment after a tool group. Thus only the trailing text segment changes during an uninterrupted token run; earlier text segments keep their object content and React position, although the parent still rerenders.

The live renderer currently keys segments by their stable array position (`s${index}`). Tool events only append a segment or update calls in place; they do not reorder preceding text. This PR does not need a new segment id or a change to stream protocol/state. The explicit rendering mode is a property of the live transcript call site, not persisted or retryable data.

### Retries and tool interleaving

A `stream_attempt` start stores the current segment array as a checkpoint. Rollback restores that array before a retry; commit retains the streamed segments. Because every text segment under the live-turn branch is rendered in streaming mode, replayed/replaced text receives the same lightweight treatment automatically. Text before and after tools remains in separate bubbles, matching the existing live composition.

Conversation switching also requires no additional state: `liveTurns` retains the active turn by conversation id, and returning to it renders those segments through the same live-only branch.

### Settlement and scroll behavior

While a `LiveTurn` exists, `displayTimeline` truncates persisted rows after the last user message so the live buffer is the sole visible representation of the in-flight response. In `sendMessage()`'s `finally`, the renderer loads persisted rows before clearing the live turn and running state. The existing transcript settlement logic records/restores an off-bottom reading position in a layout effect; the live item is the active scroll anchor for users following the bottom.

Settlement therefore replaces the lightweight live subtree with the persisted, fully rendered Markdown subtree. There is no interval in which the same response is intentionally shown in both modes. Syntax-token spans may appear at that transition, and a Mermaid source block intentionally changes into a diagram. That one-time enhancement is acceptable; manual verification must ensure it does not flash through an empty state, break bottom following, or move an off-bottom reader.

### Markdown component boundary

Removing `rehype-highlight` alone is insufficient. Mermaid is selected independently in the shared `code` override, and the shared `pre` override removes normal code-block chrome for `language-mermaid`. Both overrides must be mode-aware:

- streaming `code` treats `language-mermaid` exactly like any other fenced language and preserves its source and class;
- streaming `pre` always uses `CodeBlock`, including for Mermaid fences;
- settled `code` and `pre` retain the existing Mermaid substitution;
- only settled mode supplies `rehype-highlight`.

Use stable module-level component maps/factories for the two modes rather than constructing a new `components` object inside every render. Keep `CodeBlock` shared so streamed fences retain source-copy behavior. In streaming mode, do not add the `hljs` class as if highlighting had occurred; retain the language class and the existing monospace/block styling.

### Profiling result and decision

A local Node/React server-render probe rendered 240 progressively growing prefixes of a 35,535-character TypeScript response. Repeated parsing with `rehype-highlight` took about 3,758 ms versus 223 ms without it (about 16.9x in that run, after warm-up). This is not an Electron paint benchmark and should not be treated as a product performance threshold, but it confirms that repeated highlighting dominates the representative code-heavy parse and supports explicit mode over update throttling.

Mermaid has an additional asynchronous cost: each changed `chart` currently triggers `mermaid.render()` and incomplete source can repeatedly fail. Streaming mode must not mount `Mermaid` at all, preventing both lazy import/render work and noisy incomplete-source fallbacks.

## API and architecture

Use a narrow public prop whose default preserves all current consumers:

```ts
type MarkdownProps = {
  content: string
  mode?: "settled" | "streaming"
}
```

Prefer the explicit union over `streaming?: boolean`: it names the rendering contract at both declaration and call site and leaves room for no accidental truthiness inference. `mode` defaults to `"settled"`.

The implementation should maintain two stable plugin/component configurations:

- settled: `remarkGfm`, `rehypeHighlight`, and settled code/pre overrides;
- streaming: `remarkGfm`, no rehype highlighter, and code/pre overrides that never mount Mermaid.

The rest of the component overrides (`a`, `table`, shared code-block shell) should remain behaviorally identical. A small factory that closes over whether Mermaid is enabled is acceptable if it produces the two maps once at module scope.

`memo()` remains useful for settled consumers and unchanged earlier live segments when their props are referentially/equivalently stable. It is not the performance mechanism for the actively growing segment; that segment is reparsed by design.

## Implementation plan

### 1. Split full and streaming Markdown configurations

In `src/renderer/src/components/markdown.tsx`:

- add the optional `mode` prop with a settled default;
- extract stable settled and streaming `Components` maps (sharing handlers where mode does not matter);
- omit `rehypeHighlight` in streaming mode;
- route Mermaid fences to `Mermaid` only in settled mode;
- route streaming Mermaid fences through the same `CodeBlock` wrapper as ordinary fences;
- retain `language-*` classes, readable monospace styling, horizontal scrolling, and exact source extraction/copying in both modes; and
- update the component comment so it no longer claims all renders are highlighted or that memoization makes a changing stream cheap.

Do not modify `Mermaid` to infer whether input is complete. The parent rendering contract should prevent it from mounting during streaming.

### 2. Opt in only at the live transcript call site

In the `loading`/`liveSegments` branch of `src/renderer/src/App.tsx`, render text with:

```tsx
<Markdown content={seg.text} mode="streaming" />
```

Leave `displayTimeline` assistant messages as `<Markdown content={item.content} />`. Do not pass streaming mode based only on `loading` to shared or persisted transcript content, and do not alter secondary consumers such as question bodies, agent/skill views, file previews, or task transcripts.

No changes are required to `LiveTurn`, `LiveSegment`, checkpoint handling, persisted messages, IPC events, or settlement sequencing for this boundary.

### 3. Add focused renderer tests

Extend `src/renderer/src/components/markdown.test.tsx` so its mount helper can render a mode and rerender the same root. Cover:

- default/settled TypeScript fences receive `hljs`/token markup;
- streaming TypeScript fences preserve source and language class but receive no highlight token markup or `hljs` marker;
- copying a streaming fence writes the exact plain source;
- default/settled Mermaid fences mount the mocked `Mermaid` component and have no code-copy control;
- streaming Mermaid fences do not mount `Mermaid`, remain visible in normal code-block chrome, and are copyable;
- rerendering the same Mermaid source from streaming to settled replaces the source block with the Mermaid component;
- ordinary prose/GFM and inline code render equivalently in both modes; and
- omitting `mode` remains equivalent to settled behavior, protecting all existing callers.

Use the Mermaid mock's invocation/DOM output to prove it is not mounted in streaming mode. DOM assertions for absent `hljs` and token classes verify the observable highlighter boundary; avoid timing assertions in unit tests.

### 4. Validate the transcript transition

Manually exercise, in the packaged/dev renderer where streaming events and scroll anchoring are real:

1. Start a long TypeScript-heavy answer and confirm fenced source appears immediately, remains horizontally scrollable, and its copy action returns the current source.
2. While tokens arrive, inspect the DOM or temporary development instrumentation to confirm the live block has no `hljs` token spans.
3. Let the turn settle and confirm the same response becomes highlighted once, with no blank intermediate frame.
4. Stream a Mermaid fence and confirm raw source remains visible and no Mermaid render/error placeholder appears during growth; after settlement, confirm it becomes a diagram (or the existing settled invalid-diagram fallback for malformed source).
5. Repeat with prose and GFM around the fence, and with text → tool calls → text, ensuring each live text segment uses lightweight rendering and settled ordering is unchanged.
6. Trigger or simulate a stream retry and verify rolled-back text disappears, replayed text remains lightweight, and final content enhances once.
7. Switch conversations during a stream and return; confirm the retained live source is still lightweight and settles normally.
8. Test both scroll states: following the bottom and reading above the bottom. Confirm settlement preserves bottom following or the recorded reading position respectively.

Optional temporary profiling may count/mark `Markdown` commits and Mermaid mounts, but remove instrumentation before merging. Compare responsiveness in a long code-heavy response rather than setting a brittle wall-clock acceptance threshold across machines.

## Design constraints

- The streaming/settled distinction is explicit at the call site; do not infer it from timing, fence completeness, content shape, or whether a parent currently happens to be loading.
- Final settled messages use the existing highlighted and Mermaid rendering.
- Streaming code fences remain readable, horizontally scrollable, and copyable as exact source.
- Mermaid fences render as inert normal code blocks while live and become diagrams only after settlement.
- No global timers, debounce, idle callback, deferred duplicate buffer, or second source of truth for streamed text.
- `Markdown` defaults to settled so non-streaming consumers remain unchanged.
- Do not change current sanitization/link behavior or enable raw HTML.
- Preserve the existing settlement and scroll-restoration sequence; solve any observed transition issue at that boundary rather than masking it with a rendering timer.

## Acceptance criteria

- Growing live responses never invoke `rehype-highlight` output or mount `Mermaid` for their text segments.
- Live CommonMark/GFM remains readable, including inline code, tables, links, lists, and incomplete/complete fenced blocks.
- Live ordinary and Mermaid fences use the existing code-block shell and copy exact source text.
- Once persisted and settled, the response uses normal syntax highlighting and Mermaid behavior without a blank or duplicated response frame.
- Tool-interleaved segments, retries, conversation switching, stop/error terminal text, and rare final content with no prior token all use the live lightweight mode until reconciliation.
- Existing `Markdown` call sites that do not specify a mode retain settled behavior.
- Bottom-following and off-bottom reading positions remain correct across the final enhancement transition.
- Focused renderer tests cover both modes and their transition.

## Verification commands

Run the narrow test first, then the repository checks:

```sh
pnpm test -- src/renderer/src/components/markdown.test.tsx
pnpm typecheck
pnpm test
pnpm build
```

The package script is named `typecheck` (not an implicit `pnpm typecheck` binary), and all four commands should exit successfully before merge.

## Likely files

- Modify: `src/renderer/src/components/markdown.tsx`
- Modify: `src/renderer/src/components/markdown.test.tsx`
- Modify: `src/renderer/src/App.tsx` (one explicit live-call-site opt-in)

A dedicated live-Markdown component is not justified: it would duplicate a thin prop boundary and obscure that the same parser has two intentional modes.

## Coordination with plan 093

Plan `093` also changes primary transcript composition and the live assistant rendering area. Implement this rendering boundary first when practical. If the plans land together, preserve these ownership rules:

- each live text segment passes `mode="streaming"` regardless of where plan `093` places its whole-response metadata/footer;
- persisted assistant text remains settled/default Markdown;
- plan `093` may aggregate live text for one copy action, but must not introduce another rendered Markdown copy or another stream buffer; and
- test the final live-to-settled replacement once with both the renderer enhancement and metadata footer present.

## Risks and mitigations

- **Accidental Mermaid mount in streaming mode.** Mitigate with separate mode-aware `code` and `pre` behavior plus a mocked-Mermaid non-invocation test.
- **Streaming code loses block chrome because `pre` still special-cases Mermaid.** Mitigate with a direct assertion for `data-slot="markdown-code-block"` and the copy button in streaming Mermaid tests.
- **Default behavior regresses for secondary consumers.** Mitigate with settled-by-default API and a test that omitting `mode` highlights/renders Mermaid.
- **Final Mermaid layout changes scroll position.** The diagram necessarily differs in height from source; manually validate both scroll-follow states against the existing settlement restoration logic.
- **Ordinary Markdown parsing remains expensive for extreme prose/tables.** Keep this PR timer-free; capture a new profile before considering throttling, worker parsing, or incremental Markdown in a follow-up.

## Out of scope

- Transcript virtualization or broad `App.tsx` decomposition; tracked separately.
- Replacing the Markdown parser/highlighter stack.
- Incremental AST parsing, worker-based parsing, or throttled token display.
- Changing persisted assistant content, live segment identity, retry checkpoints, or stream protocol semantics.
- Changing Mermaid's settled error UI or sanitization.
- Changing message-level copy/timestamp behavior covered by plan `093`.
