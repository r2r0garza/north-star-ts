# 004 — Markdown / Mermaid / code rendering

**Area:** Renderer — `src/renderer/src/components/markdown.tsx`,
`src/renderer/src/components/mermaid.tsx`, `globals.css`
**Status:** Implemented

## What

Assistant messages render as formatted markdown (user messages stay plain text).

- **Stack:** `react-markdown` + `remark-gfm` (tables, task lists,
  strikethrough, autolinks) + `rehype-highlight` + `highlight.js` (synchronous
  syntax highlighting) + `mermaid` (diagrams) + `@tailwindcss/typography`
  (`prose` styling).
- **`markdown.tsx`:** custom `code` handler distinguishes inline code, fenced
  blocks, and **mermaid** fences (routed to the diagram renderer). Styled `pre`
  (constant dark `#0d1117` background), scrollable `table`, external-opening
  `a`. Memoized so streaming re-renders stay cheap.
- **`mermaid.tsx`:** renders diagrams from fenced `mermaid` blocks.
  `securityLevel: "strict"` (untrusted model output). **Streaming-safe** — while
  tokens arrive the source won't parse, so it shows raw source / keeps the last
  good render instead of flashing an error.
- **`globals.css`:** imports the `github-dark` hljs theme and registers the
  typography plugin (Tailwind v4 `@plugin` syntax).

## Why

- `rehype-highlight` is **synchronous**, which matters under token streaming
  (no async highlight flicker per delta).
- Mermaid is **lazy-loaded** on first diagram use — it's ~1MB and most messages
  have none. This dropped the initial renderer bundle from 2.58MB to 1.50MB
  (mermaid core moved to its own chunk). Mermaid's per-diagram-type renderers
  were already code-split by the bundler.
- `securityLevel: "strict"` because diagram source comes from the model.

## Trade-offs / notes

- **Code blocks use a constant dark background** in both light and dark UI
  (standard for chat apps; avoids dual-theme hljs conflicts). Switching to a
  theme-aware setup is possible but was deliberately deferred.
- Inline vs block detection: a fenced block without a language has no
  `language-*` class, so block detection also treats multiline content as a
  block.
