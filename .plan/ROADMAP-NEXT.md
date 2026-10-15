# Roadmap — Next up

> **Note (2026-09-26):** the `106.x` plans predate a rename — Initiatives are now **Features**,
> Missions are **Milestones**, and Slices are **User stories**. Each pending `106.x` plan has a mapping note at the top.

> **Review (2026-10-11):** re-prioritized around the product's differentiator. Processes are the main
> attraction today; Mission Control is "Processes v2" — ~90% complete, gated behind `.env.local`, and not
> yet shippable because user-story validation is missing. Users keep the choice of Processes and/or
> Mission Control, so Process UX investment remains worthwhile. `092.1` and `110`
> moved to Deferred; low-value deferred plans were marked *dropped — pending re-review* in their own files.

1. **`112.5` — Wave gate and durable suite.** `merged` status and a wave acceptance gate where QA writes
   one Playwright suite against the integrated app, with a `webServer` generated from the verified recipe
   so `npx playwright test` works for the user; fix stories with capped rounds; the runnable-skeleton
   rule; worktree-local installs on dependency divergence; overlapping stories serialized at planning
   time. [Plan](112.5-wave-gate-and-durable-suite.md).
