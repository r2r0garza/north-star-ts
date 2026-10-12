# Roadmap — Next up

> **Note (2026-09-26):** the `106.x` plans predate a rename — Initiatives are now **Features**,
> Missions are **Milestones**, and Slices are **User stories**. Each pending `106.x` plan has a mapping note at the top.

> **Review (2026-10-11):** re-prioritized around the product's differentiator. Processes are the main
> attraction today; Mission Control is "Processes v2" — ~90% complete, gated behind `.env.local`, and not
> yet shippable because user-story validation is missing. Users keep the choice of Processes and/or
> Mission Control, so Process UX investment remains worthwhile. `092.1` and `110`
> moved to Deferred; low-value deferred plans were marked *dropped — pending re-review* in their own files.

1. **`112` — Trustworthy app launch and acceptance validation.** The last ~10% blocking Mission Control
   from shipping. Rethink of the work preserved on `backup/qa-109-110-before-rethink-2026-10-04`: port its
   proven app-launch harness, seat browser, proof methods, bundled Playwright runner (workspace browser →
   Chrome → consented download) and wave-level acceptance suite; fix its weak point — recipes reviewed and
   authored by the user — with recipes that builders maintain and the harness verifies by running, an
   environment-vs-feature failure split with a bounded repair loop, and an honest *unverified* outcome.
   Sliced `112.1`–`112.4`. [Plan](112-app-run-recipes-and-acceptance-validation.md).
2. **`104` — Deterministic command phases.** A phase that runs a reviewed command (tests, Playwright,
   build) with exit status as the result and no LLM interpretation. Must work in both standalone Processes
   and Mission Control playbooks (playbooks run on the Process engine). Also a building block for item 1.
   [Plan](104-process-command-phases.md).
