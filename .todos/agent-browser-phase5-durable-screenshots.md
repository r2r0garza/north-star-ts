# TODO: agent browser Phase 5 — durable in-transcript screenshots

## Status: deferred (Phases 1–4 shipped)

The agent browser (branch `feat/agent-browser`) shipped Phases 1–4: navigate/
snapshot/screenshot, click/type/back, element pick, tabbed per-conversation
browser + visibility setting, plus `browser_close` / `browser_handoff` and a
sidebar "needs you" indicator. Phase 5 is the only remaining piece from the
original plan.

## The problem

`browser_screenshot` today shows the model the image but does NOT persist it.
The screenshot is injected as a **transient** user message (a `data:` image
content part) right before the next model round-trip, so:
- it never renders in the chat transcript in the UI, and
- it's gone on conversation reload (only the tool's text result — "Screenshot
  captured (WxH)…" — remains).

This was the user's very first Phase 1 observation ("I don't see the screenshot
IN the conversation itself"). Phase 5 makes screenshots durable and visible
inline.

## Why it was deferred

It's the most invasive phase: it changes the tool-result contract, DB message
storage, and the context builder — whereas the transient approach kept
`Tool.execute`'s `string` return contract intact. Everything else worked without
it (the model still SEES screenshots), so it was punted to last.

## Implementation shape (from the plan)

Widen the path that stores/replays tool results so an image can ride along and
be rebuilt on reload, instead of being injected transiently:

1. **Tool return contract** (`src/main/agent/tools/types.ts`) — allow a tool to
   return an image alongside text (today it's `string`; the transient path uses
   the `emitImage` / `ToolImage` side-channel added in Phase 1). Decide: keep
   `emitImage` but ALSO persist, or fold images into the tool result shape.
2. **Message storage** (`appendMessage` in `src/main/db/repositories/messages.ts`
   + the `messages` schema) — persist image content parts (or a reference to a
   stored image file) on the tool/user message. `content` is `string | null`
   today; needs a place for image parts. Consider storing the JPEG on disk under
   userData and persisting a path (avoid bloating the SQLite row with base64).
3. **Context builder** (`src/main/agent/context/context-builder.ts`, ~the tool-
   message reconstruction, was ~L210-216) — on replay, rebuild the message with
   its `image_url` content part so a reloaded conversation still feeds the image
   to the vision model.
4. **Renderer** — render the stored screenshot inline in the transcript
   (`src/renderer/src/App.tsx` timeline / `tool-group.tsx`), so the user sees it
   too, not just the model.

## Files (expected)
- `src/main/agent/tools/types.ts` — tool return / image contract.
- `src/main/agent/index.ts` — the tool-result push site (~L882-901) where the
  transient image message is injected today; change to persist instead.
- `src/main/db/repositories/messages.ts` + message schema — durable image storage.
- `src/main/agent/context/context-builder.ts` — rebuild image parts on replay.
- `src/main/agent/tools/browser/screenshot.ts` — may stay as-is (still produces
  the JPEG via the handle); the change is downstream in storage/replay.
- `src/renderer/src/App.tsx` / `tool-group.tsx` — inline transcript rendering.

## Verification (when picked up)
- Take a screenshot, reload the conversation → the image still shows in the
  transcript AND is still fed to the model on the next turn.
- Bounded payload: stored images downscaled/compressed (Phase 1 caps ~1280px,
  JPEG q70) so the DB/prompt don't bloat.
- `pnpm typecheck`, `pnpm test`, `pnpm build` green.

## Provenance
Split out 2026-08-01 from the agent-browser work (branch `feat/agent-browser`,
14 commits, Phases 1–4 done) so the remaining phase is tracked outside my
scratch plan (`~/.claude/plans/i-ve-pushed-and-merged-woolly-peacock.md`). Not
recorded in `.plan/` (the numbered `001`–`024` docs) — the browser feature has
no `.plan/` doc; next number would be `025` if one is wanted.
