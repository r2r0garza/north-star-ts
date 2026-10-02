# PR107: Content-derived descriptions for automatic-memory skills

> Status: **IMPLEMENTED** on `feat/process-revamp`. Step 1 of a possible memory-retrieval revamp. Follow-up to `081` (semantic
> merge). `081` fixed how facts are _stored_; this plan fixes how the model decides to _read_ them.
> A topic-split layout (one index plus rendered per-topic files) is the possible step 2, and is
> deferred until we have evidence that categories get too large to load whole (see Out of scope).

## Context

Automatic memory is exposed to the agent as managed skills: `memory-identity` and
`memory-preferences` (global), and `memory-knowledge`, `memory-lessons`, and `memory-recent`
(workspace). Only each skill's name and `description` go into the system prompt
(`buildSkillsPrompt`, `src/main/agent/skills/prompt.ts`). The model must decide from that one line
whether to call `read_skill`, and that call loads the whole category body, up to
`CATEGORY_ITEM_CAP` (200) active facts.

So the description is the entire retrieval signal, and today it carries almost nothing:

- **The "when to load" guidance is lost after the first write.** `skillScaffold` writes
  `CATEGORY_DESCRIPTIONS[category]` (e.g. _"Load when prior failures, gotchas, or decisions may
  affect the task"_). Once the category holds facts, `renderCategorySkill`
  (`src/main/agent/memory/service.ts`) replaces it with `${heading}. Currently N records.`. So
  every non-empty category is described only as, e.g., _"Lessons & Insights. Currently 47
  records."_ This is a regression: the categories that matter most give the weakest hint.
- **Nothing says what a category contains.** A `memory-lessons` file holding Python venv gotchas
  looks identical to one holding Electron IPC pitfalls. The model either loads it for every task
  (wasting context) or never does (losing the memory).
- **Scope overrides are invisible.** When workspace `knowledge` overrides a global fact
  (`store.conflicts`), that is rendered in the body only. The model has no prompt-level reason to
  load the workspace skill, so the global fact it _does_ see wins by default.
- `memory-recent` already does a crude version of this (`extractKeywords` plus a record count in
  `buildRecentFrontmatter`), so the pattern exists in the codebase, just not for the four
  category skills.

Skills are re-read every turn (`loadSkills` inside `runAgentLoop`, `src/main/agent/index.ts`), so
a description rewritten at promotion time takes effect on the next turn without any cache
invalidation.

## Goal

1. Every category skill's description says **when** to load it (restoring the lost guidance) and
   **what** is in it (a short list of topics derived from its active facts).
2. Empty categories say so, so the model never spends a `read_skill` call on them.
3. Workspace scope overrides of global memory are visible at prompt level.
4. Deterministic and bounded: no new model calls, a fixed character budget, and no file churn when
   the facts haven't changed.

## Proposed shape

### Description format

Rendered by `renderCategorySkill`, one line per item, inside the existing `description: |` block:

```
Lessons & Insights — load when prior failures, gotchas, or decisions may affect the task.
Topics: python venv, electron ipc, portkey retries, vitest mocks, pnpm workspace.
47 active facts. 2 override global memory — load before relying on global preferences/identity.
```

- **Line 1**: `CATEGORY_HEADINGS` plus the `CATEGORY_DESCRIPTIONS` "load when" clause (reworded
  to sit after a dash). Always present.
- **Line 2**: `Topics:` followed by up to N derived terms (see below). Omitted when no term clears
  the threshold. Better no topic line than a noisy one.
- **Line 3**: the active fact count. The override clause appears only when the workspace store has
  live conflicts.
- **Empty category**: `<Heading> — empty; no need to load.`

Budget: the whole description is capped at **400 chars** (well under the loader's
`MAX_DESCRIPTION` of 1024). There are four or five memory skills and they sit in the system prompt
on every turn, so their combined cost stays around 2 KB at most. Topics are dropped from the end of
the list until the description fits.

### Topic derivation (pure, in `facts.ts`)

`export function deriveTopics(facts: MemoryFact[], limit: number): string[]`, kept beside
`factTokens` so it stays Electron-free and directly testable.

- **Candidates.** Unigrams from `factTokens` plus adjacent-token bigrams (`electron ipc`,
  `python venv`). Bigrams win when they recur, since they read as topics while unigrams read as
  noise.
- **Score.** Document frequency (number of distinct facts mentioning the term), weighted by
  `log2(1 + confirmations)` so heavily re-confirmed facts pull their terms up.
- **Filters.**
  - Drop terms that appear in only one fact (that's a fact, not a topic).
  - Drop a small generic-word list layered on `STOPWORDS`: `project`, `uses`, `use`, `should`,
    `must`, `always`, `never`, `file`, `files`, `prefer`, `prefers`, `workspace`, `repo`, and
    similar. Keep this list separate from `STOPWORDS` so similarity scoring (`081`) is unaffected.
  - Drop a unigram that only ever appears inside a selected bigram.
- **Order.** Score descending, then alphabetical, so equal inputs always render byte-identical
  output. This matters: `editCategorySkill` only writes when `changed`, and a description that
  flickered between runs would churn workspace files (the dev-server-reload problem `081` already
  guards against).

This is deliberately lexical. A model-written summary ("python environment gotchas") would read
better, but it adds a model call per promotion and a failure mode. Revisit only if the lexical
topics prove too noisy in practice (see Open questions).

### Scaffold vs render

`skillScaffold` (used before any fact exists) and `renderCategorySkill` should produce the same
description shape, which means routing the scaffold through the same function with an empty store.
That removes the scaffold/render drift that caused the lost-guidance regression in the first place.

### YAML safety

The frontmatter is hand-concatenated (`description: |\n  ${description}`). Fact-derived terms
come from `factTokens`, which splits on `[^a-z0-9]+`, so they can't contain `:`, `#`, newlines, or
quotes. Even so, build the multi-line block by indenting each line explicitly and add a test that
round-trips the rendered frontmatter through `parseSkill`.

## Files touched

| File | Change |
| --- | --- |
| `src/main/agent/memory/facts.ts` | `deriveTopics`, the topic stoplist, bigram helper |
| `src/main/agent/memory/service.ts` | `renderCategorySkill` description builder; `skillScaffold` routed through it; reword `CATEGORY_DESCRIPTIONS` to fit after a heading |
| `src/main/agent/memory/facts.test.ts` | `deriveTopics` unit tests |
| `src/main/agent/memory/service.test.ts` | Update the exact-frontmatter fixtures (lines ~422, ~598, ~660); add new cases |

There are no IPC, preload, or renderer changes. `seat-memory` (`src/main/mission-control/`) is a
separate store and is not touched.

## Tests

- `deriveTopics`:
  - a recurring bigram outranks its own unigrams
  - single-fact terms are excluded
  - generic words are excluded
  - output is deterministic under input reordering
  - `limit` is respected
  - an empty input gives `[]`
- Render:
  - an empty category gives the "empty; no need to load" line
  - a non-empty category always contains the "load when" clause (regression test for the lost
    guidance)
  - the override clause appears only with live conflicts
  - the description is ≤ 400 chars with 200 long facts
- Round-trip: the rendered `SKILL.md` parses through `parseSkill` with the expected name and
  description.
- No churn: promoting an exact restatement (confirmation only) whose topic ranking doesn't move
  produces a byte-identical `SKILL.md`.

## Out of scope

- **Step 2, topic-split layout.** Add a `topic` field on `MemoryFact`, a placement step after
  classification, and render `SKILL.md` as an index plus per-topic files read with `read_file`.
  Only worth doing if categories regularly approach the cap or if loaded memory is mostly
  irrelevant to the task. Collect evidence after this ships before planning it.
- Changing `memory-recent`'s keyword scheme. It could adopt `deriveTopics` later for consistency.
- New categories, or changing what the classifier extracts.

## Open questions

1. **Are lexical topics good enough?** After a week or two of real use, read the generated
   `Topics:` lines in this repo's own memory. If they're mostly noise, the fallback is a bounded
   model-written topic line generated only when the active set changes, with `deriveTopics` as the
   fallback when the model is unavailable.
2. **Topic count.** Is 5 to 8 enough without crowding the prompt? Start at 6 and tune from what
   we observe.
3. **Hiding empty skills.** Should empty memory skills be left out of the catalog entirely? That
   saves a few tokens, but it hides the fact that memory exists at all, which may matter for
   "do you remember…" questions. Leaning no.

## Implementation notes

- `deriveTopics` matches the plan, with one refinement. A unigram scores only on its occurrences
  *outside* a recurring bigram. So a word that only ever appears inside a bigram drops out, and a
  bigram outranks its own words unless the word also recurs on its own. Scores are rounded before
  sorting so summation order (which follows input order) can't reorder ties.
- The override clause names the overridden global skills, for example `load before relying on
  global memory-preferences`, rather than a fixed "preferences/identity".
- **Added beyond the plan:** existing files would otherwise keep the old description until a new
  fact arrived. The per-turn `ensure*MemorySkills` now calls `refreshCategorySkill`, which rewrites
  a category skill only when its *body* already equals the render. That limits the rewrite to the
  frontmatter, so a bullet the store hasn't adopted is never dropped. Old empty scaffolds get the
  "empty; no need to load" line on the next turn.
- `editCategorySkill` skips the `SKILL.md` write when the render is byte-identical. A
  confirmation-only promotion now updates `facts.json` but leaves the skill file and its mtime
  alone.
