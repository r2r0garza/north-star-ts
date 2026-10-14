# Roadmap — Next up

> **Note (2026-09-26):** the `106.x` plans predate a rename — Initiatives are now **Features**,
> Missions are **Milestones**, and Slices are **User stories**. Each pending `106.x` plan has a mapping note at the top.

> **Review (2026-10-11):** re-prioritized around the product's differentiator. Processes are the main
> attraction today; Mission Control is "Processes v2" — ~90% complete, gated behind `.env.local`, and not
> yet shippable because user-story validation is missing. Users keep the choice of Processes and/or
> Mission Control, so Process UX investment remains worthwhile. `092.1` and `110`
> moved to Deferred; low-value deferred plans were marked *dropped — pending re-review* in their own files.

1. **`112.2` — Live-model scorecard baseline.** A dev-only scenario driver that runs each `112` scenario
   on Autopilot with a real model (N ≥ 3 runs, recorded as rates, costs included) on the `112.1` build,
   before any behavior change; the baseline `112.3`–`112.5` are measured against, under `112`'s stop rule.
   Parent: [`112`](112-app-run-recipes-and-acceptance-validation.md), the last ~10% blocking Mission
   Control from shipping. [Plan](112.2-live-model-scorecard-baseline.md).
2. **`112.3` — Self-verifying recipes and repair.** Recipes that detectors draft, builders complete, and
   the harness verifies by running (`setup`, `prerequisites`, `.env` references, smoke), recipe state per branch, environment-vs-feature failure
   classification, a bounded repair loop with plain-language escalation, and an honest *unverified*
   outcome. [Plan](112.3-self-verifying-recipes-and-repair.md).
3. **`112.4` — Exploratory story proofs.** An app check (`104` phase) before the story `test` step that
   routes environment failures to repair; isolated seat browsers; proof methods that refuse proofs
   resting only on builder tests or code reading; scratch-only QA writes.
   [Plan](112.4-exploratory-story-proofs.md).
4. **`112.5` — Wave gate and durable suite.** `merged` status and a wave acceptance gate where QA writes
   one Playwright suite against the integrated app, with a `webServer` generated from the verified recipe
   so `npx playwright test` works for the user; fix stories with capped rounds; the runnable-skeleton
   rule; worktree-local installs on dependency divergence; overlapping stories serialized at planning
   time. [Plan](112.5-wave-gate-and-durable-suite.md).
