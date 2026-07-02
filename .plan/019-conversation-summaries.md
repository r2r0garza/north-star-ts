# PR19: Conversation summaries — a rolling summary so long chats stay coherent

> Status: **NOT STARTED**. A prerequisite sub-feature split out of `014` (context builder, Q1).
> `014` shipped the section framework; this fills the **conversation-summary section** it reserved.
> Builds on `runAgentLoop` (the shared agent core), the `messages` repo + `TokenCounter`, and the
> `009` task runner (the summarizer runs as a durable task so the LLM call never blocks a turn).

## Context

`014`'s `ContextBuilder` assembles a turn from budget-ranked sections and does a token-budgeted
**walk-back over recent messages** (`context/context-builder.ts`). When a conversation grows past
that window, the oldest turns simply fall off — the model loses the early thread (decisions made,
constraints agreed, what was already tried). `014` reserved a **conversation-summary section** for
exactly this but shipped it as a no-op: there's no summary storage and no generation step yet.

This PR adds a **rolling conversation summary**: a compact, periodically-regenerated digest of the
turns that have dropped (or are about to drop) out of the recent-message window, injected as a
high-priority context section so a long conversation keeps its thread without replaying everything.

**Deterministic where it can be, one cheap LLM call where it can't.** Summarization is inherently a
model task, but it must never make the *user's* turn wait: it runs **out of band** (a `009` durable
task, or a post-turn hook), reads the transcript, and writes the summary for the *next* turn to pick
up. A turn always builds context from whatever summary currently exists (possibly one turn stale —
acceptable; the recent messages cover the gap).

## Goal

1. **Storage** for a per-conversation rolling summary that records which message range it covers, so
   regeneration is incremental and the builder knows the summary + walk-back don't overlap or gap.
2. **A generation step** that (re)summarizes on a size/age threshold, out of band, at bounded cost.
3. **Wiring into `014`**: a `summarySection(conversationId)` renderer that returns a
   `ContextSection` (high priority — it's compressed older context, dropped only under severe
   budget pressure), enabled by mode like the other sections.

## Likely shape (hypothesis — revisit per Open questions)

### Schema (new migration — append to `db/migrations.ts` + a new `SCHEMA_V<n>`)
A dedicated table (not a column on `conversations`) so it carries the covered range + token cost and
stays off the hot conversation row:
```sql
CREATE TABLE conversation_summaries (
  conversation_id  TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary          TEXT NOT NULL,        -- the rolling digest (prose/bullets)
  covers_through   INTEGER NOT NULL,     -- highest messages.seq folded into `summary`
  message_count    INTEGER NOT NULL,     -- turns summarized (for the threshold check)
  token_estimate   INTEGER,              -- cost via the shared TokenCounter
  updated_at       INTEGER NOT NULL
);
```
One row per conversation (the summary is rolling, not versioned — history lives in `messages`).
`covers_through` is the seam: the builder includes the summary **plus** the walk-back over messages
with `seq > covers_through` is not required (the walk-back is newest-first and budget-bounded), but
`covers_through` lets the summarizer regenerate incrementally (summarize the old summary + the new
turns since `covers_through`, not the whole transcript).

### Generation (out of band)
- **Trigger:** after a turn completes, if `messages` for the conversation exceeds a threshold
  (turn count or token estimate) beyond `covers_through`, enqueue a summarize task.
- **Runner:** a new `009` task kind (e.g. `summarize`, `registerKind` with `autoResume: false` — a
  stale summary is harmless, no need to resume across restart) whose executor reads the transcript,
  calls the LLM once with a summarize prompt (prior summary + new turns → new summary), and upserts
  the row. Deterministic-first isn't possible here (summarizing is the model's job), but the call is
  **single-shot and bounded** — no agentic loop.
- **Cost control:** incremental (fold prior summary + only-new turns), debounced (don't re-summarize
  every turn — only past the threshold), and never on the critical path.

### Wiring into 014
- `context/sections.ts` gains `summarySection(conversationId)`: reads `conversation_summaries`,
  returns `{ name: "summary", priority: SECTION_PRIORITY.summary, content }` or null.
- Add `summary` to `SECTION_PRIORITY` **above** skills (compressed older context is more valuable
  than the skills catalog under pressure) — decide the exact rank in build.
- `runAgentLoop` pushes the section (mode-gated like the others).

## Open questions to resolve BEFORE building
1. **Trigger cadence & threshold.** Turn-count vs token-estimate threshold; debounce interval. What's
   the smallest transcript worth summarizing (don't summarize a 3-message chat)?
2. **Task vs inline post-turn hook.** A `009` task (durable, observable, cancellable, reuses the
   producer contract) vs a lighter fire-and-forget post-turn call. Lean task for consistency with the
   producer contract (`015`), but confirm the overhead is acceptable for something this frequent.
3. **Summary prompt & shape.** Prose vs structured (decisions / open threads / constraints)?
   Structured is more useful to the model and cheaper to keep stable across regenerations.
4. **Model selection.** Use the conversation's own model, or a cheaper/faster one for summaries?
   (Reuses the `agent/providers` routing either way.)
5. **Interaction with the walk-back.** Does the summary *replace* the dropped turns (builder trims
   the walk-back to `covers_through`), or is it purely additive (summary + whatever recent messages
   fit)? Additive is simpler and safe; replacing reclaims budget but risks double-counting. Lean
   additive for v1.
6. **Staleness.** A turn may build from a summary one generation behind (the summarize task hasn't
   finished). Acceptable? (Yes — recent messages cover the gap — but state it.)

## Verification (when built)
- A conversation long past the recent-message window still answers questions about early decisions,
  sourced from the summary section (visible in the builder's include/drop log).
- The summarize task runs out of band (the user's turn latency is unchanged) and regenerates only
  past the threshold, incrementally (not re-reading the whole transcript each time).
- `covers_through` advances as the conversation grows; the summary + walk-back cover the transcript
  with no gap and no unbounded growth.
- Cascade: deleting a conversation drops its summary row.
- `pnpm typecheck` + `pnpm build` clean; new repo + section tests; migration applies over the
  current version.

## Out of scope
- **Cross-conversation memory** — that's durable memories (`020`), a different scope.
- **Semantic/embedding-based summary retrieval** — one rolling summary per conversation, injected
  wholesale; no ranking.
- **Summarizing tool-call bodies specially** — treat the transcript uniformly for v1.
