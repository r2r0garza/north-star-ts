# PR133: Cache-stable system prompt — move live state to the user turn

> Status: Proposal only. Source analysis completed 2026-10-31. Done alongside it, outside this
> plan: index-summary counts and file-type list removed (`src/main/index/summary.ts`), memory skill
> descriptions made stable, and the approvals section (plan 021) deleted — see
> `ROADMAP-SUPERSEDED.md`.

## Problem

Every `ContextSection` is folded into one system text block
(`src/main/agent/context/context-builder.ts`), and the Anthropic provider puts a single
`cache_control` breakpoint on it (`src/main/agent/providers/anthropic.ts`). Sections are built once
per turn, so the tool loop inside a turn caches fine — but any byte that differs on the next turn
invalidates the cached system block **and the entire message history behind it**. Only the tool
definitions survive.

The sections that change turn to turn are live state, not instructions:

| Section | Changes when |
|---|---|
| `browser_state` | page navigates, title changes, loading flag flips, user opens/closes the tab |
| `electron_state` | an app launches, exits, crashes, or its window count changes |
| `task_state` | a background task is queued, starts, waits, finishes |

## Change: Live state moves to the user turn, and only when it applies

### Rule: emit only what is live

| State | Emit when | Otherwise |
|---|---|---|
| Browser | a page is open → URL, title, loading | see "closed once" below |
| Electron | at least one session launched by this conversation is running → one line per session | see "closed once" below |
| Background tasks | at least one active task (queued, running, waiting_for_approval, paused, interrupted) | nothing — completed tasks are never listed (already true today) |

No block at all when nothing applies. A conversation that never touched the browser or Electron
never sees either.

### "Closed once"

Today the browser section always prints "No page is open… do NOT report it as open" because a
model otherwise reports a page from history as still open after the user closed it. That guard is
still needed, but only on the turn the state changes, not forever after.

Because the live-state block is persisted with each turn (see below), the previous state is
readable from history — no new storage:

- Emit the "closed" line when nothing is open now **and** either the latest persisted live-state
  block showed an open page, or a `browser_*` tool call appears after that block (the agent opened
  a page during the last turn, after its block was built).
- Next turn, the latest block has no browser line and no browser calls follow it, so nothing is
  emitted.

Same rule for Electron with `electron_*` calls and the latest block's session lines.

### Where the block goes

Append one block to the turn's user message, wrapped in the existing `renderContextEnvelope` with
`trust: "system", channel: "runtime"` provenance (as the sections are today), headed so the model
reads it as "state at the start of this turn".

**Persist it with that user message and replay it verbatim.** If it is attached only in memory, the
next turn replays that user message without it, the history no longer matches the cached prefix,
and the cache is lost from that point — the opposite of the goal. Stale blocks in older turns are
small and each is labelled as the state at that turn's start; the newest wins.

It must not appear in the visible transcript. Store it beside the user message (a separate column
or message metadata — check the `messages` schema and `appendMessage` during implementation) and
have `ContextBuilder.build` append it when replaying. The existing
`persistedUserContent` / `modelUserContent` split in `runAgentLoop` is the nearest precedent.

### Static guidance that currently rides on the live sections

`electronStateSection` also carries tool-usage guidance ("To run or verify a workspace Electron app,
use the electron_* tools, not … exec_command …"). That is instruction, not state, and must not
disappear with the section. Move it to the electron tool descriptions (part of the cached tool
prefix) or to a stable system section emitted whenever `electron_*` tools are offered. The browser
"open page" text names `browser_snapshot` / `browser_screenshot` / `browser_close`; that can stay in
the block since it only appears when a page is open.

### Work

- Replace `browserStateSection`, `electronStateSection`, `taskStateSection` (all in
  `src/main/agent/context/sections.ts`) with a single `liveStateBlock(...)` returning a string or
  null, applying the rules above.
- Stop pushing those three into `sections` in `runAgentLoop`; build the block once per turn and
  attach it to the turn's user message as described.
- Remove `browserState`, `electronState`, `taskState` from `SECTION_PRIORITY`.
- Persist and replay the block in `ContextBuilder` (and anywhere else that rebuilds history from
  stored messages — in-turn compaction, plan 118, rebuilds with `baseSystemPrompt`; check it
  carries the block).
- Tests: block present/absent per rule; "closed once" fires exactly one turn; replay is
  byte-identical across turns; no block in the rendered transcript.

## Open questions

1. **Durable-task resumes** pass no `userMessage`, so there is no new user turn to attach to. Do
   they need live state at all? Electron is off by default for non-chat runs (plan 130 opts in per
   workflow step) and `task_state` is only shown with `showTodos`. Options: skip the block on
   resume, or append it as a trailing user-role note. Decide after checking which resume paths
   actually offer browser/Electron tools.
2. **Non-Anthropic providers** (Portkey/OpenAI, Google, CLI providers) also rely on prefix caching
   or receive the system prompt differently. Confirm the block survives each provider's message
   conversion, especially where a user message's content is rewritten (images, forced skills).
3. **Block position vs. attachments note and forced-skill rewrite.** The user message already gets
   an "Attached files (…)" note and may be replaced by `forcedSkills.modelMessage`. Fix the order
   (block last) so the persisted form is deterministic.

## Out of scope

- Memory skill descriptions. Already done alongside this plan: descriptions no longer carry fact
  counts, derived topics (plan 107's `deriveTopics` is removed), or memory-recent's keywords and
  record count; `memory-*` skills are hidden from the agent when memory is off.
- Todos: already skipped while a `todo_write` result is in history; leaves the system block only at
  summarization, which rewrites the prefix anyway.
- Summary section: changes only at summarization, unavoidable.
