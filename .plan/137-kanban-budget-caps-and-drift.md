# PR137: Kanban budget caps and upstream drift handling

> Status: proposed 2026-11-19. Not started. Split out of plan 136's slice 136.4 (whose per-column WIP
> limits are built). Open decisions below need settling before building.

## Objective

Finish what 136.4 left open, so an unattended board can't overspend and doesn't keep working on an item
that has changed under it upstream:

1. **Budget caps.** Stop agent work on a card or a board once it has used a set amount.
2. **Upstream drift.** React when an item that is already on the board is untagged, closed, reassigned
   or edited upstream.

## What exists today (checked in the code 2026-11-19)

**Budget**

- The agent loop adds up token usage per turn (`turnUsage` in `src/main/agent/index.ts`: prompt,
  completion and total tokens) and returns it as `usage` on the turn result when the provider reports it.
- Card runs ignore it. `kanban_card_runs` stores no usage, and no table in the app records cost.
  There's no price per model either, so a **dollar** cap would need a price table that doesn't exist.
- Existing limits on spend are only counts: 4 agent runs at once per board (136.8), the per-column WIP
  limit (136.4), up to 3 continuation turns plus one repair turn per run (136.2), and `maxReturns` on
  `goto` (136.3).

**Drift**

- `applySync` (`src/main/db/repositories/kanban.ts`) upserts every matching item, overwriting the card's
  `item` snapshot. A card that no longer matches is deleted if it's in the Inbox with no worktree, and
  otherwise marked `status = 'unmatched'`.
- `unmatched` is only shown: a faded card with a "no longer matches" badge
  (`kanban-screen.tsx`). A running card keeps running, and a card that finishes its column still
  advances and starts the next column's agent.
- The only hard guard is before a tracker write: `KanbanService.stillMatches` replays the intake query,
  and if the item no longer matches, the card goes `blocked` and nothing is written (136.3). This also
  covers reassignment for writes, since the assignee is part of the filter.
- Edits upstream are taken in silently on the next sync. A running turn keeps the prompt it started
  with, but the next column's prompt (or a continuation turn) sees the new text. Nothing tells the user
  the item changed.
- Sync runs each minute in the background for due boards, or while the board screen is open
  (136 Decision 5, revised).
- If a card's item comes back into the filter, the next sync sets it `active` again.

## Proposed shape

### Budget caps

- **Unit: tokens**, not dollars (no price data exists). Total tokens as the provider reports them.
  A run whose provider reports no usage counts as 0 and the card shows "usage unknown".
- **Record usage.** Add `tokens` to `kanban_card_runs` (additive migration), summed from each turn's
  `usage` in the card run (main turn, repair, continuations). The card and its run history show it.
- **Two caps, both optional (empty = no cap):**
  - **Per card**: total tokens across all the card's runs on this board. Stops a card that loops (rerun,
    send back, `goto`) from eating the budget.
  - **Per board per day**: total tokens across the board's card runs since local midnight. Stops a burst
    of auto-promoted items.
- **Where it's checked:** before a card run starts (queued runs included), and between turns of a run
  (before each repair or continuation turn). A turn in flight is never cut off.
- **When a cap is reached:** the card goes `blocked` with "budget reached (N tokens)", the same "needs
  you" state as other obstacles. Nothing is written upstream. For the daily board cap, runs that would
  start wait as *Queued* with that reason and start the next day, or when the user raises the cap.
- **Override:** Rerun on a card blocked by its per-card cap asks once ("this card has used N tokens;
  run anyway?") and then allows one more run.
- **Settings:** both caps in the board settings sheet ("Running cards"). `kanban_write` can't set them,
  like the approval level. Board export/import carries them.
- **Command columns** don't count: a user's command uses no model tokens.

### Upstream drift

Settle the three cases the 136 brief named:

| Change upstream | Detected by | What the card does |
|---|---|---|
| No longer matches the filter (untagged, closed, a state outside the filter) | sync → `unmatched` | **Pause**: no new run starts; a running run finishes its current turn, then the card waits as "changed upstream" |
| Reassigned away (assignee filter is `me` or a person) | sync → `unmatched` (assignee is in the filter) | Same pause, and its tracker writes stay blocked (already true) |
| Edited (title, body, tags, state still matching) | sync: snapshot differs | Badge "changed upstream" with what changed; the work goes on |

- **Pause = a new run state, `paused`** ("changed upstream"). The card keeps its column, worktree and
  pending continuation. Card actions: **Resume** (go on anyway: the next step proceeds; tracker writes
  still need the item to match), **Remove**, or any normal move. If the item matches again on a later
  sync, a paused card shows that ("matches again") but stays paused until the user resumes it. A
  person decides, because work may have gone on upstream meanwhile.
- **Safe point** for a running agent run: after the current turn, before the next repair or
  continuation turn, and before advancing to the next column. A running command run is left to finish
  (it may be mid-deploy); its outcome is recorded, and the card then pauses instead of advancing.
- **Edits are not injected into a running turn** (136's original proposal). Keep a `seenItem` snapshot:
  the item as of the card's last run start. The badge compares the current item to it on the fields
  that matter (title, body, tags, state, assignee, custom fields), and clears when a new run starts with
  the new item. The run history records which snapshot each run used.
- **Inbox cards** are unchanged: a dropped Inbox card with no worktree is still deleted.
- **Notification:** a card pausing for drift raises a desktop notification when the board's
  notifications are on (136.8), since the board runs unattended.

### Storage (additive migration)

- `kanban_card_runs.tokens INTEGER` (null = unknown).
- `kanban_boards.budget_card_tokens`, `kanban_boards.budget_day_tokens` (null = no cap).
- `kanban_cards.seen_item TEXT` (JSON snapshot at the last run start).
- Run state `paused` added to the repository's `RUN_STATES`.

## Open decisions

1. **Unit for budgets:** tokens (proposed, works today) or dollars (needs a price table per provider and
   model, and subscription providers have no per-token price).
2. **Daily board cap reset:** local midnight (proposed) or a rolling 24 hours.
3. **Drift on a running agent run:** pause at the next safe point (proposed) or stop it at once like
   the Stop button.
4. **Edits:** badge only (proposed) or also pause when specific fields change (e.g. the body was
   rewritten).
5. **Item matches again:** stay paused until the user resumes (proposed) or resume on its own.

## Out of scope

Dollar pricing (unless Decision 1 picks it), per-column budgets, webhooks (drift is only seen on sync),
and moving cards based on upstream state changes (136's out-of-scope list still applies).

## Tests

- Usage: a card run sums the turns' `usage` (main, repair, continuations) into `tokens`; a provider with
  no usage stores null.
- Per-card cap: a run past the cap is refused before it starts and between turns; the card is `blocked`
  with the reason; Rerun's one-time override allows exactly one more run.
- Daily cap: runs past it wait as *Queued*; raising the cap starts them; the next day's count starts
  at 0.
- `kanban_write` can't set either cap; export/import carries them.
- Drift: a running card whose item drops out pauses after its current turn and doesn't advance; a
  waiting or idle card pauses on the sync; a command run finishes and then pauses; Resume goes on;
  matching again doesn't resume by itself; tracker writes on a paused card still need the re-check.
- Edits: a changed title or body shows the badge; a new run clears it; a running turn's prompt is
  unchanged.
- Inbox: a dropped Inbox card without a worktree is still deleted.

## Manual checks

- Set a small per-card cap, run a card through a column, and see it stop with "budget reached".
- On a live tracker (GitHub via `gh` is enough to start): remove the tag from an item mid-run and see the
  card pause after its turn; reassign one and confirm no write happens; edit the title and see the badge.
