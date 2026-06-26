# Decisions

Decision records for Cowork, organized by functional area. Each file captures
**what** was built, **why**, and the **trade-offs** — so the reasoning survives
even as the code changes direction.

These are point-in-time records. They are NOT auto-updated; when a decision is
reversed, add a new record or a "Superseded by" note rather than editing history
away. For live, still-open trade-offs see `CONSIDERATIONS.md` at the repo root.

## Index

- [001 — Chat UI & composer](001-chat-ui.md)
- [002 — Token streaming over IPC](002-streaming.md)
- [003 — Skills system](003-skills.md)
- [004 — Markdown / Mermaid / code rendering](004-markdown-rendering.md)
- [005 — Window chrome & sidebar](005-window-chrome-sidebar.md)
- [006 — Externalized system prompt](006-system-prompt.md)
- [007 — View switcher, Chat mode & file attachments](007-view-switcher-chat-attachments.md)
- [008 — Core file tools, tools-out-of-prompt & per-mode system prompts](008-file-tools-and-per-mode-prompts.md)

## Context

Cowork is an Electron desktop app (electron-vite, React 19, Tailwind v4,
shadcn/ui). The renderer is a chat UI; the main process runs an agentic loop
against a model via the Portkey gateway, with tools confined to a user-selected
workspace directory. The preload bridge (`window.cowork`) is the only surface
between renderer and main.
