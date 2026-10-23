# Roadmap — Next up

> **Note (2026-09-26):** the `106.x` plans predate a rename — Initiatives are now **Features**,
> Missions are **Milestones**, and Slices are **User stories**. Each pending `106.x` plan has a mapping note at the top.

> **Review (2026-10-11):** re-prioritized around the product's differentiator. Processes are the main
> attraction today; Mission Control is "Processes v2" — ~90% complete, gated behind `.env.local`, and not
> yet shippable because user-story validation is missing. Users keep the choice of Processes and/or
> Mission Control, so Process UX investment remains worthwhile. `092.1` and `110`
> moved to Deferred; low-value deferred plans were marked *dropped — pending re-review* in their own files.

1. **`116` — Constrained UI concept previews (IMPLEMENTED — Phases A–D; qualification limitations in plan).** After `115`, render approved declarative shadcn
   compositions with bounded layout tokens, host-defined local interactions and explicit revision-aware
   feedback. Concepts do not execute generated code, edit workspace files or grant action authority.
   [Plan](116-ui-concept-previews.md).
2. **`119` — Electron development-app launch and control.** Give the coding agent managed, approval-aware
   launches of workspace Electron apps, with window inspection, screenshots, UI interaction, bounded
   diagnostics and cleanup. Keep development targets separate from bundled/packaged app support deferred
   to `120`; no general desktop control. [Plan](119-electron-application-control.md).
3. **`125` — Workflow step model effort pickers.** Add capability-aware effort selection beside each
   step's worker and validator model picker, with independent persisted overrides honored at runtime.
   [Plan](125-workflow-step-effort-pickers.md).
4. **`126` — Workflow command steps.** Run Python scripts or ordinary commands directly without an
   agent call, using existing execution policy and durable bounded results for subsequent steps.
   [Plan](126-workflow-command-steps.md).
5. **`127` — Workflow command iteration.** After `126`, run a command sequentially for each item in an
   earlier step's JSON array, with safe argument bindings, bounded per-item receipts and explicit recovery.
   [Plan](127-workflow-command-iteration.md).
6. **`115` — Inline analysis artifacts — charts and tables (IN PROGRESS).** Present validated conversation snapshots
   using existing shadcn/Recharts presentation, with durable revision-scoped storage, inline live/replay
   parity, accessible chart/data-table views and bounded schemas. Keep snapshots separate from live
   dashboard refresh and generated-code execution. [Plan](115-inline-analysis-artifacts.md).
7. **`123` — Google API provider (IMPLEMENTED — live verification pending; PR118 contract tests done).** Wire the reserved `google` provider as an API-key account on
   `@google/genai`, stateless (Interactions API with `store: false`, or `generateContent` if Interactions
   is not GA), replaying thought signatures through the shared native carrier.
   [Plan](123-google-api-provider.md).
