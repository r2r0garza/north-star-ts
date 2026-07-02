# PR14: Context builder — assemble model context from all available sources

> Status: **FRAMEWORK + AVAILABLE SOURCES BUILT** (2026-07-01) on `feat/workspace-indexing`
> (commit `aff2db5`; not yet merged to `main`). Evolves the existing `ContextBuilder`
> (`src/main/agent/context/context-builder.ts`), whose own comment already named this work. Realizes
> the section framework and wires the sources that exist today; the two sources that need their own
> storage are split into their own plans.
>
> **Shipped:** the `ContextSection` abstraction, one global token budget with an explicit drop order
> (a section-budget share that can never starve the recent-message walk-back), the include/drop log
> (no silent truncation), migration of the old `runAgentLoop` `systemPrompt +=` appends (skills,
> todos, workspace-index summary) into sections, and a new **task-state** section. Also delivered the
> **workspace-index consumption** side alongside `008`: the injected index summary + the
> `index_query_tool` (find-symbol / what-imports / list-files / metadata, advisory with live-fs
> fallback). Verified: `pnpm typecheck`/`build` clean, section-framework + section-renderer tests,
> and live in the app.
>
> **Deferred to their own plans (sections reserved, currently absent):**
> - **`019` — conversation summaries** (Q1): the rolling-summary section. Needs summary storage + an
>   out-of-band generation step.
> - **`020` — durable memories** (Q2): the cross-conversation memories section. Needs a memories
>   store + a gated write path.
> - **`021` — approvals context section**: read-only visibility into what's already granted/denied.
>   An additive section on existing tables (no new subsystem), split to its own plan so it gets a
>   dedicated build session.

## Context

Today context assembly is split across two thin mechanisms:
- **System prompt concatenation** in `runAgentLoop` (`agent/index.ts:321-329`): base prompt (by
  mode) `+= skills prompt` `+= todo-list prompt` — ad-hoc string appends, each added inline.
- **`ContextBuilder.build(conversationId, {systemPrompt})`** (`context-builder.ts`): prepends the
  system message, then does a single-budget, turn-group-aware **walk-back over `messages`** (keeps
  tool-call/result integrity so the API never sees an orphaned tool message).

That's enough for a single live chat, but it leaves real signal on the floor and has no global
budget discipline across sources. As the app grows (durable tasks shipped in `009`, workspace
indexing in `008`, memories TBD), the model should see a **deliberately assembled** context drawn
from every source that matters, each as a labeled section under one token budget — instead of
whatever happens to be in the recent transcript.

## Goal

A `ContextBuilder` that assembles the turn's context from prioritized **sections**, each with a
budget share and a graceful-degradation order, producing the final `ChatMessage[]`. Sources:

1. **Conversation summary** — a rolling summary of older turns that fell out of the recent-message
   window, so long conversations keep their thread without replaying everything. (Needs a
   summarization step + storage — see Open questions.)
2. **Recent messages** — the existing token-budgeted, turn-group-aware walk-back over `messages`
   (reuse as-is; it's the one piece that already works).
3. **Workspace index** — a compact map/symbols digest from `008`'s index (file map, key symbols)
   so the agent orients without re-listing the tree every turn. **Depends on `008`.**
4. **Relevant files** — retrieval: the few files/snippets most relevant to the current request
   (from `008`'s index / search). **Depends on `008`.**
5. **Durable memories** — persisted, cross-conversation facts/preferences the user asked the agent
   to remember. **No storage exists yet** — needs its own table + write path (see Open questions).
6. **Task state** — for a durable task (or a conversation with active tasks), the relevant task's
   status/goal/recent `task_events` so a resumed or background task re-grounds. Reads `009`'s
   `tasks`/`task_events` (shipped).
7. **Approvals** — pending/recent approval decisions (the `approvals` table + allowlist) so the
   agent knows what's already been granted/denied and doesn't re-request. Reads `002`/`009` tables.

## Likely shape (hypothesis — revisit per Open questions)

- **A `ContextSection` abstraction**: `{ name, priority, render(ctx) → string | ChatMessage[], estimateOrBudgetShare }`.
  The builder collects enabled sections, allocates the global token budget by priority (recent
  messages and the live user turn are non-negotiable; index/memories/summary degrade first), renders
  each within its share, and composes the final array: **system prompt + non-message sections folded
  into the system block (or a leading context message) + the recent-message walk-back**. Keep the
  existing walk-back exactly (it guards tool-call integrity); new sources slot in *before* it.
- **Fold non-conversational context into the system block** rather than fake user/assistant turns —
  keeps the transcript honest and avoids confusing the model about who said what. (Decide: one big
  system message vs. a system message + a single synthesized "context" message.)
- **Budget discipline**: one global budget split across sections with a defined drop order, replacing
  today's single history budget (`DEFAULT_TOKEN_BUDGET = 12000`). Each section reports cost via the
  existing `TokenCounter`; over-budget sections truncate or drop per their policy, and the builder
  **logs what it dropped** (no silent truncation).
- **Migration path**: move the `runAgentLoop` ad-hoc appends (skills, todos) into sections too, so
  there's one assembler, not "ContextBuilder + a pile of `systemPrompt +=`". The agent keeps calling
  one `build(...)` and stays unaware of the strategy (preserve today's seam).
- **Used by both paths**: live `runChat` and durable tasks both already funnel through
  `runAgentLoop` → `contextBuilder.build`, so this benefits both with no extra wiring.

## Open questions — how they were resolved

1. **Summary generation & storage.** → **Split to `019`** (conversation summaries). Not built here;
   the section slot is reserved.
2. **Durable memories.** → **Split to `020`** (durable memories). Recommended split taken; not built
   here; the section slot is reserved.
3. **Dependency on `008`.** → `008` landed first (Stages 1+2 + symbols), so the workspace-index
   section is real, not a no-op: this PR shipped both the injected summary and the `index_query_tool`.
   The framework still degrades gracefully (the index section is simply absent when there's no index
   or the "use index for context" setting is off).
4. **Budget policy.** → **Priority with a section-budget cap.** Sections are admitted
   highest-priority-first while their cumulative cost fits a share of the total budget (default 50%),
   so they can never starve the recent-message walk-back. Non-droppable core = base system prompt +
   the walk-back (tool-call integrity preserved) + the live user turn. Drop order (ascending priority
   = dropped first) is centralized in `SECTION_PRIORITY`: index → approvals → task-state → todos →
   skills; summary/memories slot in above these when `019`/`020` land. No spillover in v1 (simple,
   predictable); revisit if sections routinely under-fill.
5. **Relevance/retrieval ranking.** → Not needed yet — no relevant-files section shipped. The index
   is queried on demand via `index_query_tool` (lexical: name/module/path match), not
   retrieval-ranked into context. Embedding-based ranking stays deferred (per `008`).
6. **Per-mode / per-task-kind composition.** → Sections are gated at their call site in
   `runAgentLoop` using the existing `showTodos` (mode ≠ chat) + workspace + setting checks. Chat
   stays tool-light and pulls no workspace/index sections. A blank/empty section is skipped.

## Deferred sections (reserved, not yet built)

- **Conversation summary** → `019`. Priority: above skills (compressed older context outvalues the
  skills catalog under pressure).
- **Durable memories** → `020`. Priority: high (user-stated facts); rank vs summary in build.
- **Approvals section** → **`021`**. Simpler than `019`/`020` (no new subsystem — the `approvals`
  table + `action_allowlist` already exist, `002`/`009`/`012`): a new scoped read
  (`listRules({ workspacePath, conversationId })`; the repo currently only has `findMatch`) + a
  renderer folding granted/pending decisions into a `ContextSection` (slot reserved:
  `SECTION_PRIORITY.approvals = 20`). Split to its own plan/session because it carries real design
  context worth preserving (why it waited: live-chat gates are in-memory/synchronous so there are
  usually no rows on the common path — its value is mainly a **resumed background task** re-grounding
  on what's already granted/denied; pairs with `018`, whose fix loop re-runs gated actions). See
  `021` for the full write-up.

## Verification (when built)
- A long conversation stays coherent past the recent-message window via the summary section, and
  the builder logs which sections it included/dropped and their token costs.
- Task state + approvals sections appear for a durable task / a conversation with active tasks and
  pending approvals; they're absent when irrelevant.
- Index/relevant-files sections activate once `008` is present and are cleanly absent before then
  (capability check), never erroring.
- Recent-message walk-back still preserves tool-call/result integrity (no orphaned tool messages →
  no API 400) — the `009`/existing behavior is unchanged for a plain turn.
- One global budget is respected across all sections with the defined drop order; nothing is
  silently truncated.
- `pnpm typecheck` + `pnpm build` clean; existing context-builder behavior covered by tests; both
  the live `chat` path and durable tasks build context through the one assembler.

## Out of scope (this PR)
- **Building the workspace index** (`008`) or **the durable-memories store** (likely its own plan) —
  `014` consumes them; it doesn't build them.
- **Embedding-based retrieval** — lexical/recency ranking first (embeddings deferred, per `008`).
- **Cross-conversation context bleed** beyond explicit durable memories — sections stay scoped.
- **Changing the LLM streaming layer or the agentic loop** — `014` only changes how the message
  array is assembled before the loop runs.
