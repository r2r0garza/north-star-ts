# PR81: Semantic merge and contradiction resolution for automatic memory

> Status: **COMPLETED**. Follow-up to the automatic-memory reliability and write-path work on
> `feat/agent-hardening`. That work made the pipeline stop _losing_ facts; this one makes it stop
> _accumulating_ them. Unblocks opening extraction to assistant/tool-derived evidence
> (see Out of scope), which raises fact volume several-fold.

## Context

`editCategorySkill` merges new facts into a category by concatenating and de-duplicating on
`clampMemoryFact(item).toLowerCase()` — byte equality after whitespace normalization. Nothing else.
There is no contradiction resolution, no semantic dedup, and no notion of a fact going stale. The
reference implementation this system was modeled on (`agent-memory/v2/plugins/memory.js`,
`editCategorySkill`) used a model call to merge with explicit rules — _"keep the more complete
version of semantically identical items"_, _"when old and new conflict, replace old with new"_ —
guarded by a shrink check that rejected a merge losing more than two items. We did not port it.

The consequences are visible in this repo's own memory after ~130 recorded turns:

- **Cross-scope contradiction.** Global `memory-preferences` holds _"Required verification commands
  are `npm test` and `npm run build`"_ while workspace `memory-knowledge` holds _"This project uses
  pnpm as its package manager; npm must not be used."_ Both are injected. Neither wins.
- **Near-duplicate clusters.** Six consecutive `memory-knowledge` rows restate the same
  process-template IPC surface in slightly different words. Exact-match dedup cannot see them.
- **No supersession.** A fact that was true and is now false stays forever. Six such rows were
  pruned by hand during the `feat/agent-hardening` work; hand-pruning is not a mechanism.

This interacts badly with the item cap. `CATEGORY_ITEM_CAP` is 200 and eviction now drops the
oldest, so once a category fills, restatements evict genuine facts. Duplicate pressure sets the
date at which memory starts actively losing information.

## Goal

1. Merge new facts into a category **semantically**: collapse restatements into the more complete
   phrasing, and replace a superseded fact rather than appending its contradiction.
2. Never lose a fact to a merge failure — a bad or unavailable model leaves the prior file intact.
3. Make supersession expressible, which today it is not: a flat bullet list carries no ordering or
   provenance, so "newer wins" cannot even be evaluated.

## Shape as built

### Per-fact metadata

Each `memory-<category>` directory gains a `facts.json` sidecar (`src/main/agent/memory/facts.ts`).
A fact carries `firstSeenAt`, `lastConfirmedAt`, `confirmations`, bounded `sources` (the
conversation ids the claim came from), and a `status` of `active` or `superseded` with
`supersededBy`/`supersededAt`. `SKILL.md` is rendered from the store, so the store is the source of
truth — but a bullet present in `SKILL.md` and unknown to the store is adopted back on load, which
is both the migration path from the flat-list format and the recovery path for a hand edit that got
past the tool-layer refusal. An unreadable sidecar is treated as absent, not as empty.

Provenance reaches the store because the staging heading now carries the conversation:
`### 10:00 - Durable user-stated facts (conversation <id>)`. Promotion parses staged bullets per
section instead of grepping every `- ` line, so the attribution survives the batch.

### Merge step

Runs inside `editCategorySkill`, after a deterministic pass, before the write:

- The deterministic pass first: an incoming fact that byte-matches a stored one is a **confirmation**
  — it bumps `lastConfirmedAt`/`confirmations` and adds no row, at no model cost.
- Whatever is left is clustered against the stored facts. **No lexical neighbour means no model
  call**: there is nothing to collapse or contradict, so the facts are appended. With the incoming
  batch already deduplicated, this is the common case, and it is what bounds cost to ≤1 call per
  affected category per promotion.
- The merge returns strict JSON: a merged list plus, per output item, the input numbers it subsumes.
  `validateMerge` accepts it only when **every input index is claimed exactly once** (nothing is
  dropped unaccounted for), no survivor absorbs more than `MERGE_MAX_SUBSUMED` inputs, every survivor
  is lexically similar to each input it claims, and no survivor's text is forbidden.
- That similarity requirement _is_ the shrink guard, made explicit rather than a tolerance of two:
  collapse is bounded by how alike the items actually are, so a weak model can neither summarize a
  category away nor invent a survivor unsupported by what it claims to subsume.
- A rejection leaves the category file **byte-identical** — sidecar included — and returns `retry`,
  so the batch replays on the next sweep. Replay is safe because it is idempotent: facts already
  stored come back as exact restatements and are confirmed in place. A provider outage returns
  `unavailable` and burns no attempt, matching the classifier's existing semantics. On the final
  attempt the batch is stored deterministically rather than dropped.

Two smaller fixes fell out of the same code. `editCategorySkill` now takes a **per-category-file
lock**: the swap lock is per recent dir, which never protected the two global categories from two
workspaces promoting at once. And a promotion that changes nothing no longer rewrites the files,
which kept workspace memory churn out of dev-server reloads.

### Scope crossing

Detected, not reconciled. After a workspace category gains facts, they are checked against the
global categories. Lexical similarity is the wrong filter here — the npm/pnpm pair shares one token
and scores far below the merge floor — so a shared distinctive token decides only _what the model is
asked about_, and the model decides only what is recorded; the same token test then re-validates the
pair it reports, so an invented pairing is discarded.

A confirmed conflict is recorded in the **workspace** sidecar and rendered as a `## Scope overrides`
section in the workspace `SKILL.md`, naming the global fact it overrides. The global file is never
edited from inside a workspace: it is shared by every workspace, so a fact that is wrong here is not
wrong there. Fact parsing stops at the first `## ` heading, so the override note is never read back
as a fact.

## Questions resolved during the build

1. **Merge granularity — clustered.** A merge sees only the existing rows lexically near the incoming
   facts (`clusterForIncoming`, Dice ≥ `MERGE_SIMILARITY_FLOOR`, capped at `MERGE_CLUSTER_CAP`),
   never all 200. Bounded cost, bounded blast radius; a distant contradiction is missed, which is the
   accepted trade.
2. **Delete versus supersede — supersede.** A merged-away row keeps its text in `facts.json` with
   `status: "superseded"`, `supersededBy`, and `supersededAt`, and stops being rendered into
   `SKILL.md`. Auditable and recoverable without making the skill file unreadable, because the skill
   file is rendered from the sidecar rather than being the source of truth.
3. **Does the cap survive — yes, as a backstop, with recency-aware eviction.** `CATEGORY_ITEM_CAP`
   stays at 200 active rows, but eviction now drops the least-recently-confirmed fact rather than the
   oldest-inserted one: a fact restated across months outlives one mentioned once. Superseded rows
   have their own retention cap so the sidecar cannot grow without bound.
4. **Ordering with assistant-derived extraction — merge landed first.** Extraction is unchanged and
   still user-origin only.
5. **Model selection — no capability floor; guards do the work.** The merge runs on whatever memory
   model is configured. A response that fails the subsumption accounting is rejected and the batch is
   retried; on the final attempt the batch is stored deterministically instead of being dropped, so a
   persistently weak model degrades to the old append-and-dedup behaviour rather than losing facts.

## Verification

Covered by `src/main/agent/memory/facts.test.ts` (20 cases, pure guards) and the new
`semantic merge` suite in `src/main/agent/memory/service.test.ts` (8 end-to-end cases):

- A restatement in different words collapses to one row keeping the fuller phrasing; the row count
  does not grow, and an exact restatement is confirmed in place with no model call at all.
- A contradicting fact ("the roadmap moved to `docs/ROADMAP.md`") replaces its predecessor; the
  superseded row keeps its provenance in `facts.json` and stops being rendered.
- A merge that fails to parse, drops an unaccounted input, claims one twice, subsumes nothing,
  points out of range, or collapses unrelated facts is rejected — the category file stays
  byte-identical and the batch is retried; a provider outage retries without burning an attempt;
  the fifth attempt stores deterministically instead of dropping the batch.
- The npm/pnpm cross-scope pair is detected, logged, and rendered as a workspace scope override; the
  global file is left untouched, and the override note is not adopted as a fact on the next write.
- Recency-aware eviction keeps a still-restated fact over a stale one at the cap.
- Existing memory service tests (16) still pass unchanged. `pnpm typecheck` and `pnpm build` clean;
  the two other failing suites in the repo (`read_file_tool`, container docker/podman) fail on
  `main` as well and are unrelated.

## Out of scope

- **Assistant/tool-derived extraction** — depends on this, tracked separately.
- **`reference/` retention.** The raw logs grow unbounded (one file is already >100 KB) with no
  rotation or pruning. Real, unrelated to merge, worth its own plan.
- **A memory management UI.** Listing, editing, and deleting memories by hand is the `020` surface
  that was never built; merge reduces the need for it but does not replace it.
