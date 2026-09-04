# PR81: Semantic merge and contradiction resolution for automatic memory

> Status: **PLANNED**. Follow-up to the automatic-memory reliability and write-path work on
> `feat/agent-hardening`. That work made the pipeline stop _losing_ facts; this one makes it stop
> _accumulating_ them. Prerequisite for opening extraction to assistant/tool-derived evidence
> (see Open questions), because that raises fact volume several-fold.

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

## Likely shape (hypothesis — revisit per Open questions)

### Per-fact metadata

The blocker for contradiction resolution is that a category file is an undifferentiated bullet
list. Add bounded per-fact metadata — first seen, last confirmed, source turn/conversation — so a
merge can reason about recency and a poisoned or wrong fact is traceable. This is the same sidecar
`077` item 6 specified and that was never built; do it once, here, and let both features use it.

Storage options: an HTML-comment suffix per bullet (keeps `SKILL.md` a single human-readable file,
survives the existing `^- ` parsing), or a sibling `facts.json` with `SKILL.md` rendered from it
(cleaner, but the skill file stops being the source of truth). Lean sidecar-rendered.

### Merge step

Runs inside `editCategorySkill`, after the deterministic pass, before the write:

- Input: current items (with metadata) + the incoming facts for that category.
- Output: strict JSON — a merged list plus, per output item, which input items it subsumes, so the
  result is checkable rather than trusted.
- Reject and keep the prior file when: the response does not parse, an output item subsumes nothing,
  or the merged list drops more items than the subsumption map accounts for. Port the reference's
  shrink guard and make it explicit rather than a magic tolerance of two.
- The write already goes through `writeFileAtomic`, so a rejected merge cannot leave a torn file.

Cost: one call per affected category per promotion (≤4). Bound it — skip the merge entirely when the
incoming facts deterministically dedup to nothing, which is the common case.

### Scope crossing

The npm/pnpm case is not solvable inside one file: the two facts live in different files at
different scopes. v1 should at minimum **detect** it — when a workspace fact contradicts a global
one, prefer the workspace fact for injection and flag the global one — rather than silently
injecting both. Full cross-scope reconciliation is probably its own plan.

## Open questions to resolve BEFORE building

1. **Merge granularity.** Whole category per merge (simple, but re-litigates 200 settled facts and
   risks drift on every write) versus only the cluster of existing items lexically near the incoming
   facts (cheaper, bounded blast radius, may miss a distant contradiction). Lean clustered.
2. **Delete versus supersede.** Should a merge be allowed to remove a row, or only mark it
   superseded and stop injecting it? Supersede is recoverable and auditable; delete keeps the file
   readable. Interacts with whether `SKILL.md` is source of truth or rendered.
3. **Does the cap survive?** If merge works, is `CATEGORY_ITEM_CAP` still the right backstop, and
   does eviction still go by age once recency metadata exists?
4. **Ordering with assistant-derived extraction.** Assistant/tool evidence multiplies restatement
   volume, which is what makes merge necessary — but merge is also what makes that extraction safe
   to enable. Confirm merge lands first.
5. **Model selection.** The merge runs on the configured memory model, which users may set cheap.
   A weak model rewriting memory wholesale is the risk the shrink guard exists for; decide whether
   merge requires a minimum capability or degrades to deterministic dedup.

## Verification (when built)

- A restatement of a stored fact in different words collapses to one row, keeping the more complete
  phrasing; the row count does not grow.
- A contradicting fact ("the roadmap moved to `docs/ROADMAP.md`") replaces its predecessor rather
  than appending; the superseded row stops being injected.
- A merge whose model call fails, returns unparseable output, or drops unaccounted items leaves the
  category file byte-identical, and the batch is retried on the next sweep.
- The npm/pnpm cross-scope pair is detected and reported; the workspace fact wins injection.
- Existing memory service tests still pass, plus new cases for subsumption accounting and the
  shrink guard.

## Out of scope

- **Assistant/tool-derived extraction** — depends on this, tracked separately.
- **`reference/` retention.** The raw logs grow unbounded (one file is already >100 KB) with no
  rotation or pruning. Real, unrelated to merge, worth its own plan.
- **A memory management UI.** Listing, editing, and deleting memories by hand is the `020` surface
  that was never built; merge reduces the need for it but does not replace it.
