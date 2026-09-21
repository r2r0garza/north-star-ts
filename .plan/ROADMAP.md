# Roadmap

This file is the compact entry point for planned work. Detailed plan files are numbered by **creation order** and keep stable IDs; never renumber them. Priority and status live in the roadmap files below.

## Status files

- [Next up](ROADMAP-NEXT.md) — ordered implementation priority. Reorder this list freely as needs change; its ordered-list number is the current priority rank, while the backticked number is the stable plan-file ID.
- [Deferred](ROADMAP-DEFERRED.md) — intentionally parked work, including dependencies, activation conditions, and reasons for deferral.
- [Superseded](ROADMAP-SUPERSEDED.md) — historical plans replaced by newer plans or shipped architecture.
- [Completed](ROADMAP-COMPLETED.md) — shipped work and implementation/verification history.

Every numbered plan should appear in exactly one status file. A plan may be split by delivery slice when the slices have different statuses, such as `092.1` in Next up and `092.2`/`092.3` in Deferred; do not also list the unsplit parent as separate work.

## Backlog (not yet planned)

Tracked in `IMPLEMENTED-TOOLS.md` → "Not yet implemented". This is a loose idea pool, not part of the ordered Next up queue; reconcile it against that inventory before promotion.

## How to maintain the roadmap

- Reorder `ROADMAP-NEXT.md` whenever priorities shift; no plan-file renames are needed.
- When a plan starts, keep its implementation status in the plan file itself.
- When work ships, move its roadmap entry to `ROADMAP-COMPLETED.md` and include the merge or commit reference.
- Move replaced work to `ROADMAP-SUPERSEDED.md` and name its replacement.
- Keep deferred reasons and activation conditions in `ROADMAP-DEFERRED.md` so parked work is not promoted accidentally.
- New work gets the next stable plan number and an entry in the appropriate status file.
- Run `pnpm verify:roadmap` after roadmap changes; CI rejects duplicate IDs and plan families assigned across status files.
