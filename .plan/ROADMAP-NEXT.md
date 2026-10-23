# Roadmap — Next up

> **Note (2026-09-26):** the `106.x` plans predate a rename — Initiatives are now **Features**,
> Missions are **Milestones**, and Slices are **User stories**. Each pending `106.x` plan has a mapping note at the top.

> **Review (2026-10-11):** re-prioritized around the product's differentiator. Processes are the main
> attraction today; Mission Control is "Processes v2" — ~90% complete, gated behind `.env.local`, and not
> yet shippable because user-story validation is missing. Users keep the choice of Processes and/or
> Mission Control, so Process UX investment remains worthwhile. `092.1` and `110`
> moved to Deferred; low-value deferred plans were marked *dropped — pending re-review* in their own files.

1. **`119` — Electron development-app launch and control.** Give the coding agent managed, approval-aware
   launches of workspace Electron apps, with window inspection, screenshots, UI interaction, bounded
   diagnostics and cleanup. Keep development targets separate from bundled/packaged app support deferred
   to `120`; no general desktop control. [Plan](119-electron-application-control.md).
2. **`126` — Workflow command steps.** Run Python scripts or ordinary commands directly without an
   agent call, using existing execution policy and durable bounded results for subsequent steps.
   [Plan](126-workflow-command-steps.md).
3. **`127` — Workflow command iteration.** After `126`, run a command sequentially for each item in an
   earlier step's JSON array, with safe argument bindings, bounded per-item receipts and explicit recovery.
   [Plan](127-workflow-command-iteration.md).
4. **`123` — Google API provider (IMPLEMENTED — live verification pending; PR118 contract tests done).** Wire the reserved `google` provider as an API-key account on
   `@google/genai`, stateless (Interactions API with `store: false`, or `generateContent` if Interactions
   is not GA), replaying thought signatures through the shared native carrier.
   [Plan](123-google-api-provider.md).
