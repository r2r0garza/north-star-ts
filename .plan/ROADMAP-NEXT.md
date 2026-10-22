# Roadmap — Next up

> **Note (2026-09-26):** the `106.x` plans predate a rename — Initiatives are now **Features**,
> Missions are **Milestones**, and Slices are **User stories**. Each pending `106.x` plan has a mapping note at the top.

> **Review (2026-10-11):** re-prioritized around the product's differentiator. Processes are the main
> attraction today; Mission Control is "Processes v2" — ~90% complete, gated behind `.env.local`, and not
> yet shippable because user-story validation is missing. Users keep the choice of Processes and/or
> Mission Control, so Process UX investment remains worthwhile. `092.1` and `110`
> moved to Deferred; low-value deferred plans were marked *dropped — pending re-review* in their own files.

1. **`113` — shadcn Trace adoption (IN PROGRESS).** Standardize agent activity presentation across tool groups,
   individual calls, live indicators, delegated results, workflow activity and read-only todos while preserving
   orchestration, approval routing, transcript semantics and workflow response pairing. Existing implementation
   and remaining work are tracked in the [plan](113-shadcn-trace-adoption.md).
2. **`115` — Inline analysis artifacts — charts and tables (IN PROGRESS).** Present validated conversation snapshots
   using existing shadcn/Recharts presentation, with durable revision-scoped storage, inline live/replay
   parity, accessible chart/data-table views and bounded schemas. Keep snapshots separate from live
   dashboard refresh and generated-code execution. [Plan](115-inline-analysis-artifacts.md).
3. **`116` — Constrained UI concept previews.** After `115`, render approved declarative shadcn
   compositions with bounded layout tokens, host-defined local interactions and explicit revision-aware
   feedback. Concepts do not execute generated code, edit workspace files or grant action authority.
   [Plan](116-ui-concept-previews.md).
4. **`122` — Anthropic API provider.** Wire the reserved `anthropic` provider as an API-key account on the
   official SDK, translating the loop's chat-completions shape to Messages API content blocks. Replay
   thinking signatures only over an unchanged prefix, with a `drop_block` safety net; record each model's
   context window. Claude subscription unchanged. [Plan](122-anthropic-api-provider.md).
5. **`123` — Google API provider.** Wire the reserved `google` provider as an API-key account on
   `@google/genai`, stateless (Interactions API with `store: false`, or `generateContent` if Interactions
   is not GA), replaying thought signatures through the shared native carrier.
   [Plan](123-google-api-provider.md).
6. **`118` — In-turn context compaction.** Bound a single long agent turn's request at the model-round
   boundary: clear old tool-result bodies first, then fall back to a work-state summary and rebuild. The
   persisted transcript stays complete; instructions are pinned and a tool-record work ledger survives
   compaction. Blocked on `122` and `123`.
   [Plan](118-in-turn-context-compaction.md).
7. **`119` — Electron development-app launch and control.** Give the coding agent managed, approval-aware
   launches of workspace Electron apps, with window inspection, screenshots, UI interaction, bounded
   diagnostics and cleanup. Keep development targets separate from bundled/packaged app support deferred
   to `120`; no general desktop control. [Plan](119-electron-application-control.md).
