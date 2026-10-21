# PR114: Adopt shadcn Code Block for code and tool output

> Status: **Proposed — not implemented.** Replace duplicated code/output presentation while retaining current parsing, execution and streaming contracts. Companion: [PR113: Trace adoption](113-shadcn-trace-adoption.md).

## Objective and recommendation

Adopt the installed Code Block shell, content, actions, copy button and footer for Markdown fences, tool arguments/results, approval previews, workflow tool payloads, Git error output and Mermaid source fallback. This complements Trace: Trace owns the activity/disclosure hierarchy; Code Block owns its code/text payloads.

Start with presentation reuse, not a simultaneous highlighter rewrite. Keep settled Markdown's `rehype-highlight` pipeline and the lightweight unhighlighted streaming path in this implementation. The newly installed Shiki helpers are a useful future option, but not required to replace our hand-built shell and copy state. Migrating highlighting at the same time would add language coverage, theme, async loading and performance risks without being necessary for the main objective.

## Evidence and adoption inventory

Paths below are relative to `src/renderer/src/components/`. Line references describe the research snapshot, not permanent anchors.

| Surface | Current behavior | Recommendation |
| --- | --- | --- |
| `markdown.tsx:46–136`, local `CodeBlock` | Hand-built dark shell, sticky Run/Copy rail, wrapped source, local copied timer | Primary replacement using UI primitives and a narrow Markdown fence adapter |
| `tool-group.tsx:366–385` | Raw arguments pre and clipped result inside Bubble/pre | Compact `size="sm"` Code Blocks; wrapped, bounded results; preserve error classification |
| `tool-group.tsx:460–492`, ApprovalCard | Wrapped summary and bounded raw unified-diff preview with stats | Replace payload shells only; preserve approval container/actions/scroll contract |
| `run-detail.tsx:587–598`, StepTranscript | Raw arguments and all paired responses in pre elements | Compact blocks; preserve raw strings and multiple-response pairing |
| `git-actions.tsx:712–739`, ErrorDialog | Bounded wrapped selectable error pre | Destructive compact block, retain dialog behavior |
| `git-branch-switcher.tsx`, ErrorDialog near line 451 | Same error-pre pattern | Same composition, no new generic error-dialog abstraction needed |
| `mermaid.tsx:68–79` | Raw-source fallback during render/failure | Code Block for source, footer for renderability note; SVG path untouched |
| `diff-view.tsx` | Unified-diff parser with old/new gutters, file/hunk metadata, colored lines, truncation | Keep specialized renderer; new single-counter line numbering is not equivalent |
| `files-panel.tsx`, FilePreviewContents | File selection anchors, Git added/modified/deletion gutter, sticky line numbers, syntax markup | Keep specialized viewer in this migration |
| `terminal-drawer.tsx` | Interactive xterm terminal | Keep; Code Block cannot replace a terminal emulator |
| Inline code and ordinary prose/errors | Inline semantics and ordinary message text | Keep; not every monospace string or message should become a code block |

Task transcript and other Markdown consumers inherit the shared Markdown migration without per-screen changes.

## Installed primitive contract and gaps

`ui/code-block.tsx` provides default/destructive variants, normal/small sizes, header/title/actions/footer slots, a focusable LTR pre containing its own code element, optional wrapping, line numbers/startLine, and line variants. It does not parse Markdown, highlight by itself, identify languages, limit output size, execute commands, fetch full results, or render two-column Git gutters.

`CodeBlockContent` already creates `<pre><code>`. Our Markdown adapter must not pass another existing `<code>` element as its child or nest pre elements. Extract the React code child's token/text children into the new content surface. Preserve source separately for Copy and Run; do not reconstruct it from decorated DOM or include headers/status/footer text.

Normalize `cn` to the existing local utility when touching the new component. Verify the imported Shadcn stylesheet supplies scroll-fade and related utilities in the built app; avoid duplicate global CSS. Keep primitive changes narrow and avoid installing anything already present.

The installed Copy button copies its explicit `value` and announces success. Its current handler invokes caller `onClick` and still copies even if the event was prevented, and its timer does not restart on repeated copies while already copied. If the migration relies on these behaviors, make cancellation respected and reset the timer on every successful copy, with unmount cleanup and tests. Never report successful copy on a rejected write; retain non-disruptive failure behavior. Keep caller-provided labels compatible with “Copy code” at Markdown call sites.

Line variants add decorative +/− markers, and line-numbering is one CSS counter. Do not feed raw unified diff lines into those variants and accidentally double their signs. Raw diff previews should remain literal strings initially. Do not label one counter as old/new file numbering.

## Selected visual and interaction contract

Keep current system fonts, compact text sizing, spacing density and semantic colors. Use `size="sm"` for tool/workflow/approval/error payloads. Avoid adding filenames, line numbers, wrap toggles or downloads where no existing use case needs them.

Markdown keeps its existing wrapped, full-height content and sticky action rail; long messages should not suddenly get an internal vertical scroll area or lose always-discoverable Copy/Run controls. Code Block's default absolute, hover-revealed floating actions and root overflow-hidden are not a drop-in replacement for that rail. Compose/override its action placement and root overflow deliberately at the Markdown adapter, leave content min-width constraints intact, and test actual sticky positioning in Electron. Reserve top space so wrapped code does not sit beneath actions.

For the first migration, preserve Markdown's constant dark code surface and existing GitHub-dark highlight.js token palette in both light and dark app themes. Explicitly style controls and base code text for that surface. Code Block's theme-aware default shell alone does not guarantee contrast with the existing globally imported dark hljs theme. Tool/plain-output blocks can use native theme tokens. A later Shiki migration can intentionally adopt dual light/dark code themes; do not accidentally change theme by swapping wrappers.

Use wrap plus `overflow-wrap:anywhere` where existing behavior wraps long unbroken paths/strings. Preserve bounded result surfaces (`max-h-64` for tool results, current approval diff and Git error bounds) and outer approval scrolling. Do not create two competing scroll containers around the same output.

## Markdown adapter design

Rename the local Markdown `CodeBlock` to an explicit name such as `MarkdownCodeFence` and import the UI primitive under its own name. Keep Markdown-specific source extraction, AST offset handling, Run state/reentrancy and any sticky layout customization here. Generic UI primitives must not know about conversations, IPC or executing Bash.

Extract the raw source from the existing React child using the current plain-text traversal, preserving its terminal newline and blank lines. Copy receives that exact source string. Render only token/text children through `CodeBlockContent`; forward language/highlight class metadata to the appropriate code surface through a small supported code-props extension if needed, rather than forwarding AST `node` objects as DOM attributes. Prefer one explicit extension to `CodeBlockContent` over query-selector mutations or duplicated pre/code markup.

Preserve the current settled `rehype-highlight` token children and `hljs` styling. Preserve plain streaming children without invoking any highlighter. Inline code stays in the existing `code` override and must not acquire Code Block chrome. Settled Mermaid still bypasses normal fenced-code rendering; streaming Mermaid remains a normal copyable fence. Handle language-less, indented, empty and incomplete fences through the pre adapter rather than relying solely on the existing language/multiline heuristic. Check one-line language-less code, language tags with punctuation, and no-final-newline source.

Retain exact Run eligibility: only settled, nonempty `bash` fences with an AST source offset and a supplied callback. Do not broaden to `sh`, `shell`, unknown languages or live content. Keep the original offset passed to `onRunBash`, directory tooltip, disabled state, async error toast, and synchronous launching guard that prevents duplicate dispatch. Copy must remain independent of Run.

Retain `splitStreamingMarkdown` block memoization and transcript memo/settlement boundaries. No debounce, extra content buffer, parser replacement, raw HTML enablement or URL/file-link changes. Do not introduce highlighting into the live token path via the installed hook.

## Tool, approval and workflow payload design

For tool arguments, keep JSON pretty printing when parsed args exist and rawArgs otherwise. For result text, preserve the 4,000-character display cap and explicit truncation marker. Put any truncation explanation in a footer only if it retains clear meaning. Do not offer Show more/full result when the component does not actually have a sanctioned full-result loading path.

Where adding Copy to a tool block, copy exactly the displayed payload, including its explicit truncation indication; label the action accordingly for clipped content. Do not silently expose a full tool result through Copy while showing only a clipped preview. Preserve empty-result versus undefined-running distinction. Structured subagent results retain their rich renderer rather than being replaced by a JSON block. Media remains outside Code Block and stays lazily mounted under Trace/tool disclosure.

Keep interrupted explanatory prose in its existing message treatment rather than presenting it as machine output. Use the destructive variant only for genuine error payloads (`isErrorResult` in ordinary tool output); row error status and result payload classification remain distinct inputs.

Approval summaries and raw diff previews are presentation changes only: retain reasons, shell/browser details, additions/deletions, preview-truncated notice, all approval options/scopes, keyboard shortcuts, and the fixed action area. Do not parse a new trust decision from text. Preserve `approval-details` and `approval-actions` test hooks/behavior.

Workflow arguments remain the exact original argument string. Retain every matching response plus orphan/unlinked output, as documented in PR113. Do not consolidate them into a single Code Block if that loses response identity. PR114 owns payload composition; PR113 owns replacing the native disclosure, so the two changes must not independently rewrite StepTranscript's adapter.

Mermaid uses Code Block only for raw source fallback; loading/failure information belongs outside the code text or in a footer so copying returns only chart source. Retain strict Mermaid sanitization, cancellation handling and successful SVG rendering. Do not import Markdown back into Mermaid and create a render cycle.

## Highlighter decision and future opportunity

The new `hooks/use-highlighted-code.ts` and `lib/highlighter.tsx` are currently unconnected helpers. They lazy-load a singleton Shiki core, JavaScript regex engine, GitHub light/dark themes and a finite language set; aliases and ANSI are handled explicitly. The hook caches complete lines and retokenizes a changing tail. These are useful capabilities, not proof that all current language/stream behavior is equivalent.

Leave them intact but unused in the presentation-only migration. Do not remove `highlight.js` or `rehype-highlight`: Markdown still uses both indirectly and FilesPanel imports highlight.js directly. Dependency removal is neither safe nor authorized as collateral cleanup.

A future separately approved highlighter phase should first compare current Markdown and file-language coverage with the installed Shiki language table (which omits several FilesPanel languages), decide dual-theme behavior, and add tests for unknown-language fallback, aliases, async language changes/unmount, import failure, multiline grammar state, trailing and blank lines, ANSI semantics, replacement/retry rollback, and CSP/production chunk loading. Profile representative settled blocks before adoption. Keeping streaming highlighting disabled remains the default unless separately measured and approved. No claim of a performance win is justified by the helper's presence alone.

## Implementation sequence and ownership

### Phase A: Primitive audit and Markdown fence adapter

Audit the primitive and build the narrow Markdown fence adapter. Preserve settled highlight.js and lightweight streaming mode; replace duplicated copy state with the shared copy button. Add code props only if necessary for correct language/token metadata. Keep sticky controls and exact-source behavior before migrating other callers.

### Phase B: Tool arguments and results

Replace tool argument/result payloads, with existing ToolGroup or migrated Trace as the parent. Keep this phase small and regression-test clipping, media laziness, malformed args and error handling.

### Phase C: Approval and workflow payloads

Adopt blocks for ApprovalCard summaries/raw diff previews and workflow tool payloads. Coordinate StepTranscript changes with PR113 so only one implementation owns each shell/body seam. Preserve all approval/pairing contracts.

### Phase D: Secondary plain-output surfaces

Replace the two Git error pre surfaces and Mermaid source fallback. Do not introduce a generic error-dialog refactor or broaden to ordinary prose.

### Phase E: Integration verification and limited cleanup

Verify cross-surface layout, clean only imports/state/chrome made redundant by these changes, and update old structure-specific tests to the new primitive slots without weakening their behavioral assertions.

Likely modifications are `ui/code-block.tsx`, `markdown.tsx`, `tool-group.tsx`, `run-detail.tsx`, `git-actions.tsx`, `git-branch-switcher.tsx`, `mermaid.tsx`, with a narrow Markdown adapter file only if extraction improves testability. Keep FilesPanel, DiffView, terminal emulator, highlighter helpers, dependency manifests and main-process code unchanged for this scope. Global/typography CSS changes require an observed integration need, not a speculative rewrite.

## Verification and acceptance

Add `ui/code-block.test.tsx` for exact value copying, success/failure announcements, cancellation if supported, timer reset/cleanup, strings versus explicit lines, empty and blank lines, line-number/startLine behavior and escaped text. Render text safely; no raw HTML is required for code payloads.

Extend `markdown.test.tsx` for one pre/code pair, exact clipboard text including final newline and blank lines, settled token classes, unhighlighted streaming output, Mermaid transitions, language-less/indented/empty/incomplete fences, long unbroken strings, and all existing Run eligibility/source-offset/reentrancy/disabled/error behaviors. Preserve find/link/prose behavior. Replace assertions tied to `markdown-code-block` / `markdown-code-scroll` with intentional new selectors, while retaining the sticky-rail-outside-content requirement rather than deleting that regression test.

Tool tests cover clipped displayed-copy semantics, malformed JSON, undefined versus empty results, destructive output, subagent and media preservation. Approval tests retain large summary/diff and fixed-action behavior. Workflow tests retain multiple-response pairing and refresh behavior. Extend the existing Git action/branch-switcher suites for visible output and close/focus behavior. Add focused Mermaid fallback/copy tests with a mocked renderer.

Run targeted modified/new renderer suites, then the repository checks in the implementation session:

```sh
pnpm test -- src/renderer/src/components/ui/code-block.test.tsx src/renderer/src/components/markdown.test.tsx src/renderer/src/components/tool-group.test.tsx src/renderer/src/components/tool-media-preview.test.tsx src/renderer/src/components/approval-card.test.tsx src/renderer/src/components/run-detail.test.tsx src/renderer/src/components/git-actions.test.tsx src/renderer/src/components/git-branch-switcher.test.ts
pnpm typecheck
pnpm test
pnpm build
```

Include the new Mermaid/adapter suites and any other modified tests in the targeted run. Check production lazy-loading only if a later highlighter phase actually uses Shiki.

Manual Electron verification is required for sticky Run/Copy on very long wrapped Markdown, keyboard-accessible content scrolling, selection/clipboard text, reduced motion, action focus/hover visibility, narrow panels, theme contrast, approval viewport bounds, live-to-settled layout and bottom-follow/off-bottom reading positions. CSS-counter selection and wrapped-line copying need real Chromium verification; happy-dom alone cannot prove them.

Accepted when all identified general-purpose code/output surfaces share the primitive, no nested pre/code elements are introduced, source Copy and Bash execution remain exact, streaming stays lightweight, approval/task/media behavior is unchanged, and specialized file/diff/terminal features remain intact. Roll back by surface if needed, without introducing a long-term parallel renderer.

## Explicit non-goals

No highlighter engine switch, dependency removal, file-viewer or dual-gutter diff migration, interactive-terminal replacement, default line numbers on every fence, download controls, automatic language guessing, full-result retrieval, terminal ANSI reinterpretation, new code execution permissions, raw HTML rendering or streaming protocol changes. Revisit file/diff integration only through a dedicated parity plan with selection/gutter tests and a clear reason the simpler primitive improves those specialized surfaces.

## Sources and research limitations

Upstream references are [Code Block](https://ui.shadcn.com/docs/components/base/code-block) and [Trace](https://ui.shadcn.com/docs/components/base/trace). Local source is authoritative for the installed API. Relevant existing constraints are [PR95](095-streaming-markdown-rendering.md), [PR97](097-transcript-render-boundaries-and-virtualization.md), current Markdown/media/approval/workflow regression tests, and PR113 for activity/disclosure ownership.

Research inspected source and existing tests; it did not execute the proposed migration, tests, build, or runtime UI verification. The Code Block documentation exceeded the fetch size limit and was read through the browser. The existing uncommitted component/helper additions and package changes belong to the user and must be preserved. This document records future implementation work, not completed behavior.
