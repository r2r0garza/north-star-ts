# PR21: Approvals context section — the agent sees what's already granted/denied

> Status: **DONE** (built on branch `pr21-approvals-context-section`; commit ref pending merge). Shipped
> **both halves** (allowlist grants + task-approval decisions). The last of the three sections `014`
> (context builder) reserved but did not build. Unlike `019` (summaries) and `020` (memories) — each a
> new subsystem — this was a small **additive section over tables that already exist** (`approvals`
> from `009`/`012`, `action_allowlist` from `002`). Fills the `SECTION_PRIORITY.approvals` slot (= 20)
> already defined in `src/main/agent/context/context-builder.ts`. No schema change, no migration.
>
> **As built:** a `listRules({ workspacePath, conversationId })` read on `action-allowlist.ts`
> (all in-scope matches; unlike `findMatch` it does **not** touch `last_used_at` — a display read must
> not mark rules used); an `approvalsSection({ conversationId, workspacePath?, taskId? })` renderer in
> `context/sections.ts` (allowlist half deduped by kind/identity/scope + capped; task-approval half
> gated on `taskId`, pending shown as "NOT yet granted"); an optional `taskId` threaded into
> `RunAgentLoopOptions` and set by the runner's `runOne`; the section pushed in `runAgentLoop` at the
> existing `showTodos` gate. Verified: `pnpm typecheck` + `pnpm build` clean; 15 unit tests
> (`action-allowlist.test.ts` scope resolution + no-touch; `sections.test.ts` renderer/dedup/gating);
> manual E2E (allowlist line appears on a workspace-scoped grant, absent in a different workspace and
> in bare chat; task half renders on resume). Testing surfaced an unrelated data-lifecycle bug →
> `022`.

## Context

`014` built a section-based `ContextBuilder`: each turn's context is assembled from budget-ranked
`ContextSection`s folded into the system block, with an explicit drop order centralized in
`SECTION_PRIORITY` (index 10 → **approvals 20** → task-state 30 → todos 40 → skills 50). The
task-state section shipped; the approvals slot was reserved but left empty, deliberately (see "Why
it waited").

The goal of an approvals section: give the agent visibility into **what the user has already
granted or denied**, so it doesn't re-request an action that's already been allowlisted, and doesn't
re-attempt something the user explicitly denied. Reads are advisory — the section informs the
agent's *planning*; the real approval gate (`src/main/agent/approval`) is still the authority at
execution time. This never bypasses a gate.

### Why it waited (carry this context into the build session)
- **Live-chat gates are in-memory and synchronous.** In a normal `runChat` turn, an approval is
  requested and resolved within the same turn via the in-memory gate promise (`resolveApproval`);
  nothing durable is written for the *live* path. So on the common path there are **no approval rows
  to show** — the section would usually be empty. (The `approvals` **table** is written only by the
  **runner** for durable tasks — `009`/`012` dual-write a task's gate so it survives a restart —
  because `approvals.task_id` is `NOT NULL`.)
- **Its real value is a resumed / background task re-grounding.** A durable task that was blocked on
  a gate, or that ran gated actions across a restart, benefits from seeing "these actions were
  already approved/denied" so it doesn't loop or re-prompt. That scenario is exercised most by `018`
  (agentic goal mode), whose fix loop re-runs gated actions — so this section pairs naturally with
  `018`.
- It's **cheap and low-risk** (one scoped read + a formatter), so it's worth having as its own small
  PR rather than folding half-heartedly into `014`.

## Two data sources (decide how to combine — see Open questions)

1. **`action_allowlist`** (`002`) — remembered "always allow" rules. Scoped `global` / `workspace` /
   `conversation` (also `agent`/`once`, not persisted/relevant here). This is the durable "what's
   been granted" set and is **not task-scoped**, so it's meaningful for a **live chat too** — the
   most useful half of this section. Schema:
   ```
   action_allowlist(id, tool, kind, identity, scope, workspace_path, conversation_id,
                     agent_id, created_at, last_used_at)
   ```
   Repo (`db/repositories/action-allowlist.ts`) currently exposes only `addRule`, `findMatch`,
   `touchLastUsed` — **no list-by-scope read**. This PR adds one:
   `listRules({ workspacePath?, conversationId? }): ActionAllowlistRule[]` returning the `global` +
   matching `workspace` + matching `conversation` rules (mirror `findMatch`'s scope logic, but return
   all matches instead of the first).
2. **`approvals`** (`009`/`012`) — per-task gate decisions (`pending`/`approved`/`denied`),
   `task_id NOT NULL`. Repo exposes `listApprovals({ taskId?, status? })`. Relevant when the turn is
   (or belongs to) a durable task — surface recent decisions + any still-`pending` gate so a resumed
   task re-grounds. In a plain live chat there are typically none.

## Likely shape (hypothesis)

- **`approvalsSection(ctx): ContextSection | null`** in `src/main/agent/context/sections.ts`
  (alongside `taskStateSection`), returning `{ name: "approvals", priority:
  SECTION_PRIORITY.approvals, content }` or null when there's nothing to show. Inputs it needs:
  `workspacePath`, `conversationId`, and — for the task half — the current `taskId` if this turn is a
  durable task (thread it in, or derive from the conversation).
- **Content** = a compact digest: the in-scope allowlist rules ("already allowed: `<kind>` `<identity>`
  [scope]") + any recent/pending task approvals ("approved/denied: `<summary>`"). Capped like the
  other sections; advisory framing ("you've already been granted these — don't re-ask"). No raw JSON.
- **Wiring**: push it in `runAgentLoop` next to the task-state section, mode-gated the same way
  (interactive/north_star; skip chat). Gate it on there being a workspace and/or a task so it's
  absent for a bare chat turn.
- **No schema change, no migration** — both tables exist. The only new persistence-layer code is the
  `listRules` read.

## Open questions to resolve BEFORE building
1. **Which source(s) to include, and when.** Allowlist rules are useful for **every** non-chat turn
   (they're the durable grants). Task approvals only matter for durable-task turns. Ship both, gated
   independently? Or start with just the allowlist half (broadest value) and add the task-approval
   half with/for `018`? Lean: allowlist half always (when workspace present), task-approval half when
   a `taskId` is in play.
2. **Threading the `taskId`.** The live `runChat` path doesn't have a task; the runner's `runOne`
   does. How does `runAgentLoop` know it's inside a task so the section can query `listApprovals`?
   (An optional field on the loop opts, set by the runner — check what's already threaded for
   task-state.)
3. **Content shape & cap.** How many rules/decisions to inline; ordering (recency? by kind?);
   dedup (the allowlist can hold several rules for one identity at different scopes). Keep it short —
   this is orientation, not an audit log.
4. **Relevance filtering.** Inline *all* in-scope allowlist rules, or only ones plausibly relevant to
   the current turn? All-in-scope is simplest while the set is small (mirror `020`'s "all inline +
   cap" stance); revisit if it grows.
5. **Interaction with `018`.** If `018` lands first, its fix loop is the prime consumer — coordinate
   so the section surfaces exactly what a re-running gated action needs (don't re-request an
   already-approved action, don't retry a denied one).

## Verification (when built)
- With a `workspace`-scoped "always allow" rule present, a non-chat turn's context includes an
  "already allowed" line for it (visible in the builder's include/drop log); a bare chat turn does
  not.
- A durable task that had an approval decision surfaces it on a resumed turn; a live chat with no
  task and no allowlist rules produces **no** approvals section (null, not an empty block).
- The section respects its budget slot and drop order (dropped before task-state under pressure);
  nothing silently truncated.
- Reads are advisory only — presence of the section never bypasses the real gate; a still-`pending`
  decision is shown as pending, not treated as granted.
- `pnpm typecheck` + `pnpm build` clean; a `listRules` repo test (scope resolution: global + matching
  workspace + matching conversation, excludes non-matching) + an `approvalsSection` renderer test.

## Out of scope
- **Any change to the approval gate / policy engine** — this is read-only context; enforcement is
  unchanged (`src/main/agent/approval`).
- **A schema change** — both tables already exist; only a new read is added.
- **Auto-granting or auto-denying based on the section** — the model may plan around it, but every
  gated action still goes through the live gate.
- **Cross-conversation approval visibility** beyond the existing allowlist scopes — scoping matches
  `action_allowlist` (`global`/`workspace`/`conversation`), nothing wider.
