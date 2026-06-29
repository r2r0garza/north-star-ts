# PR14: Context builder — assemble model context from all available sources

> Status: **NOT STARTED**. Evolves the existing `ContextBuilder`
> (`src/main/agent/context/context-builder.ts`), whose own comment already names this work:
> *"later this composes summaries, memories, workspace state, task state, retrieved codebase
> context, etc. before the history walk."* This is the realization of that comment — a structured,
> budgeted, multi-source assembler — **not** a new parallel system.

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

## Open questions to resolve BEFORE building

1. **Summary generation & storage.** Where does the rolling conversation summary live (new
   `conversation_summaries` table? a column on `conversations`?), and when is it (re)generated —
   end of turn, on a size threshold, lazily before build? It costs an LLM call; decide cadence and
   whether it's a durable task (`009`) itself.
2. **Durable memories don't exist yet.** This is a prerequisite sub-feature: a `memories` table, a
   write path (explicit "remember this" tool vs. inferred), scoping (global / per-workspace /
   per-conversation), and retrieval (all small memories inline vs. retrieval-ranked). Likely its
   **own plan** that `014` consumes — decide whether to split it out (recommended) or fold a minimal
   version in.
3. **Dependency on `008`.** The workspace-index and relevant-files sections can't be real until
   `008` ships an index to read. `014` should ship the **framework + the available sources** (recent
   messages, task state, approvals, and summary/memories if those land first), with index/retrieval
   sections as no-ops behind a capability check until `008` exists. Don't block `014` on `008`.
4. **Budget policy.** Fixed per-section shares vs. priority-with-spillover (a section under budget
   donates to the next)? What's the non-droppable core (system + live user turn + enough recent
   messages to be coherent)? Define the drop order explicitly.
5. **Relevance/retrieval ranking** (for relevant-files and memories): embeddings vs. lexical/recency
   first? Lean lexical/recency for v1 (no embedding infra), upgrade later (008 lists embeddings as
   "later").
6. **Per-mode / per-task-kind composition.** Chat (no workspace) vs. North Star vs. a background
   task want different sections (Chat shouldn't pull workspace index). Sections should be
   enable-able by mode/kind — reuse the existing mode gating (`showTodos` pattern).

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
