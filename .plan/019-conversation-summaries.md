# PR19: Conversation summaries — a rolling summary so long chats stay coherent

> Status: **SHIPPED** (commit `68066c4` on `feat/conversation-summaries`; not yet merged to `main`).
> Filled the **conversation-summary section** `014` reserved. Built on `runAgentLoop`, the `messages`
> repo + `TokenCounter`, and the `009` task runner (the summarizer runs as a durable task kind so its
> single LLM call never blocks a turn). A prerequisite sub-feature split out of `014` (Q1).
>
> **What shipped** — resolving the open questions: (1) trigger = **post-turn, threshold + debounce**
> (≥10 msgs, and ≥20 fresh turns *or* ≥6k fresh tokens past `covers_through`), deduped against an
> in-flight run; (2) a `009` durable **task** kind (`summarize`, `autoResume:false` — a stale summary
> is harmless), NOT an inline hook; (3) **structured** shape — four sections (Decisions / Constraints
> / Open threads / Key facts); (4) the **conversation's own model** (falls back to the default);
> (5) **additive** to the walk-back (safe overlap, never a gap — no double-count guard needed);
> (6) staleness accepted (a turn may build from a one-generation-old summary; recent messages cover
> the seam).
>
> **Prompt hardening found in live testing** (the interesting part — see "What we learned"): the
> first working summaries were *echoing the transcript* and *truncating*, and *memorizing volatile
> repo facts*. Three fixes landed: fence inputs as data + drop the completion cue; guard on
> `finish_reason==="length"` (retry, never store a truncated digest); strip any preamble before the
> first `##`; and instruct the model to omit — and actively drop from a prior summary — volatile
> repo-state facts the live index section already supplies fresh.

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

## Open questions — RESOLVED
1. **Trigger cadence & threshold.** → Post-turn, in the `chat` IPC handler. Fires only when
   `messages` ≥ **10** (`MIN_MESSAGES` — skip short chats) AND the fresh tail past `covers_through`
   is ≥ **20 turns** (`TRIGGER_TURNS`) *or* ≥ **6000 tokens** (`TRIGGER_TOKENS`) — whichever trips
   first. Deduped against an in-flight `summarize` run for the same conversation.
2. **Task vs inline post-turn hook.** → A `009` **task** kind (`summarize`). The overhead is fine
   because the threshold+debounce means it runs rarely, and the durable/observable/cancellable
   machinery + producer contract (`015`) come for free. The executor is deterministic-`run` (like
   `workspace_index`) but makes **one** bounded, non-streaming LLM call — no agentic loop.
   `autoResume:false`, and deliberately **not** `hasIndependentSurface` (so a leftover run is reaped
   by the `022` orphan sweep — a stale summary is harmless).
3. **Summary prompt & shape.** → **Structured**: four fixed `##` sections (Decisions / Constraints /
   Open threads / Key facts).
4. **Model selection.** → The **conversation's own model** (`resolveLlm` with the conversation's
   account/model; null → default).
5. **Interaction with the walk-back.** → **Additive.** The summary is injected as a section; the
   walk-back is unchanged and may re-include recent turns already folded in — a harmless overlap,
   never a gap. No builder trim, no double-count guard.
6. **Staleness.** → Accepted. A turn builds from whatever summary exists (possibly one generation
   behind); the recent-message walk-back covers the seam.

## What we learned (live testing surfaced 3 prompt/output bugs)
The schema/wiring worked first try, but the *first real summaries were bad* — and debugging them
against the live DB (a real conversation's `conversation_summaries` row) drove three fixes, all in
`summaries/service.ts`:

1. **Transcript echo → budget burn → truncation.** The user prompt rendered the turns as a bare
   `user:/assistant:` log ending in an `UPDATED SUMMARY:` cue — i.e. a *completion to continue*. The
   model dutifully continued the transcript (re-typing turns, even inventing new ones) before
   summarizing, exhausting the output cap and cutting the real digest off mid-section. Fix: fence the
   inputs as data (`<prior_summary>` / `<new_turns>`), drop the completion cue, and end with an
   imperative ("Output ONLY the four `##` sections. Do NOT repeat or continue the transcript").
2. **No truncation guard.** A cut-off digest was being stored verbatim. Fix: check
   `finish_reason === "length"` and return a **retryable** error instead of persisting a partial
   summary (mirrors the main agent loop). Backstop for a legitimately long summary.
3. **Memorizing volatile repo facts.** The digest kept baking in the git branch, file/symbol counts,
   directory listings, importer lists — facts the always-fresh `## Workspace index` section (built
   at call time, plan `008`/`014`) already supplies. It then went **stale** and contradicted the
   live index (a summary asserting `feat/workspace-indexing` while the index showed
   `pr21-approvals-context-section`). Fix: instruct the summarizer to omit those and, overriding
   "carry forward", to **actively delete** them from a prior summary. (The deeper index-summary
   staleness — the branch not refreshing on `git checkout` — is `024`'s scope, untouched here.)
   Plus a `stripPreamble` (drop anything before the first `##`) as belt-and-suspenders for chatty
   lead-ins.

Verified on a clean, non-meta seeded conversation (a Tailwind dark-mode chat): the resulting digest
was complete, non-echoed, faithful (captured a mid-conversation reversal correctly), and carried
conversational conclusions rather than raw repo state.

## Verification
- A conversation long past the recent-message window still answers questions about early decisions,
  sourced from the summary section (visible in the builder's include/drop log). ✓ (live)
- The summarize task runs out of band (turn latency unchanged) and regenerates only past the
  threshold, incrementally (folds prior summary + only-new turns). ✓
- `covers_through` advances as the conversation grows; summary + walk-back cover the transcript with
  no gap and no unbounded growth. ✓
- Cascade: deleting a conversation drops its summary row. ✓ (FK `ON DELETE CASCADE`, repo test)
- `pnpm typecheck` + `pnpm build` clean; new repo + section + service tests (16 service cases incl.
  truncation/preamble/prompt-shape); migration applies over v9 (three "latest `user_version`"
  assertions bumped 9 → 10). ✓

## Out of scope
- **Cross-conversation memory** — that's durable memories (`020`), a different scope.
- **Semantic/embedding-based summary retrieval** — one rolling summary per conversation, injected
  wholesale; no ranking.
- **Summarizing tool-call bodies specially** — treat the transcript uniformly for v1.
