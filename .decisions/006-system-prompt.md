# 006 — Externalized system prompt

**Area:** Main — `src/main/agent/system-prompt.ts`, `prompts/system-prompt.md`
**Status:** Implemented

## What

The agent's base system prompt was moved out of code into an editable file.

- `prompts/system-prompt.md` holds the base prompt; edit it to adjust agent
  behavior without code changes.
- `system-prompt.ts` (`loadSystemPrompt`) reads it via `app.getAppPath()`
  (project root in dev, app bundle when packaged), caches it, and falls back to
  a hardcoded constant if the file is missing/unreadable (so the agent never
  crashes over a bad prompt file).
- The skills section (003) is still appended programmatically after the base
  prompt, fresh each turn.
- Packaged via `build.files` (`prompts/**/*`).

## Why

- Lets the prompt be iterated on directly as text, separate from code.
- A fallback constant keeps the agent functional if the file is absent.

## Trade-offs / notes

- **Cached for the process lifetime** — edits don't apply until the main
  process restarts (in dev, electron-vite reloads main on save). See
  `CONSIDERATIONS.md` #4 for how to make edits apply per-message (drop the cache,
  or cache with fs-watch/mtime invalidation).
- Packaged-build prompt lives in read-only `app.asar` — same caveat as
  app-bundled skills (#2 / 003).
