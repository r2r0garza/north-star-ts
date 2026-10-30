# Roadmap — Next up

> **Note (2026-09-26):** the `106.x` plans predate a rename — Initiatives are now **Features**,
> Missions are **Milestones**, and Slices are **User stories**. Each pending `106.x` plan has a mapping note at the top.

> **Review (2026-10-11):** re-prioritized around the product's differentiator. Processes are the main
> attraction today; Mission Control is "Processes v2" — ~90% complete, gated behind `.env.local`, and not
> yet shippable because user-story validation is missing. Users keep the choice of Processes and/or
> Mission Control, so Process UX investment remains worthwhile. `092.1` and `110`
> moved to Deferred; low-value deferred plans were marked *dropped — pending re-review* in their own files.

1. **`126` — Workflow command steps.** Run Python scripts or ordinary commands directly without an
   agent call, using existing execution policy and durable bounded results for subsequent steps.
   [Plan](126-workflow-command-steps.md).
2. **`127` — Workflow command iteration.** After `126`, run a command sequentially for each item in an
   earlier step's JSON array, with safe argument bindings, bounded per-item receipts and explicit recovery.
   [Plan](127-workflow-command-iteration.md).
3. **`123` — Google API provider (IMPLEMENTED — live verification pending; PR118 contract tests done).** Wire the reserved `google` provider as an API-key account on
   `@google/genai`, stateless (Interactions API with `store: false`, or `generateContent` if Interactions
   is not GA), replaying thought signatures through the shared native carrier.
   [Plan](123-google-api-provider.md).
4. **`128` — Qualify Electron app control on Windows.** Run PR119's qualification on Windows 11 and fix
   what it requires: owned process-tree teardown, pipe transport, test-profile paths, child env and
   path handling. [Plan](128-electron-app-control-windows-qualification.md).
5. **`129` — Qualify Electron app control on Linux.** Run PR119's qualification on X11, Wayland and Xvfb
   and fix what it requires: display detection, Chromium sandbox failures as actionable errors (never
   `--no-sandbox`), child env and teardown. [Plan](129-electron-app-control-linux-qualification.md).
6. **`130` — Browser and Electron tools in workflow steps (IMPLEMENTED — manual verification pending).** Per-step opt-in to the agent browser and
   Electron app control for unattended runs (self-verification, black-box URL testing), with per-step
   origin allowlists, consequential actions blocked despite auto mode, owned tab/app lifecycle and
   observation-only validator access. [Plan](130-workflow-browser-and-electron-tools.md).
