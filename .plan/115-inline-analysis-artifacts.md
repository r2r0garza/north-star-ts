# PR115: Inline analysis artifacts — charts and tables

> Status: **Completed 2026-10-23** (Phases A–D implemented 2026-10-21); qualification limitations recorded below. Chart and table snapshots have validated, bounded contracts, atomic durable tool completion, typed live/historical projection, accessible data views, expanded presentation and immutable revisions. Follow-ups: [PR116: UI concept previews](116-ui-concept-previews.md) and [PR117: sandboxed HTML/React previews](117-sandboxed-html-react-previews.md).

## Objective and recommendation

Let an agent present charts and tables between explanatory prose segments. These are first-class answer content, visible without expanding tool activity, not screenshots or JSON hidden in a tool result. Use validated data specifications rendered by trusted application code; do not generate or execute React to show a chart.

Deliver charts and tables together with a small shared artifact contract. Avoid a generic component registry or a tool per shadcn primitive. Proposed tool names in this document are working API names, not existing capabilities.

An analysis artifact is a snapshot of supplied data. It does not create a dashboard, fetch data, calculate an analysis, install packages, or gain additional access to files or network resources.

## Evidence and current seams

`src/main/agent/tools/dashboard_write.ts` already accepts chart, stat and table widget definitions and stores dashboard data. `src/renderer/src/components/dashboards-screen.tsx` contains chart/table presentation, including line, bar and area charts. `src/renderer/src/components/ui/chart.tsx` wraps Recharts with theme, tooltip and legend support. Reuse compatible presentation, not dashboard refresh semantics.

`src/renderer/src/components/transcript.tsx` has separate live and settled paths that interleave prose with tool groups. `src/renderer/src/lib/timeline.ts` joins tool arguments/results and durable media references. `tool-group.tsx` renders collapsible tool activity and clips visible result text. An artifact must not be reconstructed from that clipped preview or depend on the activity group being open.

The durable tool-image path is precedent for host-validated, invocation-associated content, not an instruction to overload image records with JSON. Inspect the actual tool lifecycle, DB schema, event projection and provider bridges before choosing concrete migration and event names. Preserve [PR97's transcript boundaries](097-transcript-render-boundaries-and-virtualization.md) and [PR109.5's media contracts](109.5-host-images-and-durable-media.md).

## Model-facing presentation contract

Expose narrow `present_chart` and `present_table` tools over one internal artifact service. Each accepts an explicit title, optional concise description and source/data-as-of metadata, plus a bounded specification. Source labels are attribution, not proof of verification; the agent must fetch or calculate data through existing tools first.

Initial chart kinds are `line`, `bar` and `area`. Require an explicit category/x key and one or more numeric series with labels. Support units and a small host-defined number-format vocabulary, not formatter expressions. A proposed call looks like:

```json
{
  "title": "Revenue by segment",
  "chartKind": "bar",
  "xKey": "month",
  "unit": "USD",
  "series": [
    { "key": "enterprise", "label": "Enterprise" },
    { "key": "consumer", "label": "Consumer" }
  ],
  "data": [
    { "month": "Jan", "enterprise": 120, "consumer": 80 },
    { "month": "Feb", "enterprise": 160, "consumer": 82 }
  ]
}
```

Table specifications declare columns with keys, labels and supported value/format types, plus flat rows. Cells contain scalar values or explicit nulls, never React nodes, HTML, arbitrary links or actions. Default row order is the supplied order. Any local sort is a presentation state and does not rewrite the saved dataset.

Optional artifact identity and expected base revision permit explicit revisions within the current conversation. New tool calls create immutable revisions; retries of the same durable invocation return the same outcome. Validate these operations server-side, not just through the advertised tool schema.

Return a bounded textual acknowledgement containing artifact ID, revision, kind, title and row count. Do not repeat all rows in the acknowledgement. State that the artifact was saved for presentation, not that the user saw it or that its conclusions were verified. Invalid input returns actionable validation errors without creating a partial artifact.

## Durable ownership and lifecycle

Define a versioned internal envelope containing kind, schema version, title/description, validated specification, optional source metadata and host-owned conversation, invocation and revision identity. Persist immutable revision content and a typed result-to-revision association transactionally with successful tool completion. Choose the smallest DB representation after auditing existing lifecycle transactions; do not publish a live success event before durable content can be recovered.

Conversation and invocation association come from runtime context. The model cannot select another conversation, provide storage paths, spoof a result owner, or replace another artifact's history. Revision updates require matching conversation ownership and an expected base revision; conflicts fail rather than silently overwriting a concurrent revision.

Historical transcript entries always resolve the exact revision originally referenced, never whichever revision happens to be latest. Duplicate/replayed stream events must not duplicate visible artifacts. Interrupted or failed calls must not expose partially validated content as successful output. Scope reads through main-process checks even when the renderer supplies an ID. Conversation deletion cleans up associated records/blobs; define per-artifact and per-conversation quotas and failure behavior before shipping. Missing content and unknown versions get an honest bounded fallback, not a crash.

Use typed references in the live/persisted projection, or a strictly parsed host-produced tool-result envelope if it fits existing infrastructure better. Do not interpret arbitrary Markdown, model text or unrelated tool JSON as an artifact command. IDs, references and content remain data, not instructions or approvals.

## Validation and visual correctness

Set named, tested limits for rows, columns, series, labels and total serialized bytes. Reject oversize input with guidance to aggregate before presenting; do not silently truncate or downsample. Large-dataset storage/import is a separate extension, not a reason to stuff unbounded data into model context.

Require unique declared keys, valid row shapes and finite numeric chart values. Distinguish missing, null and zero; do not invent zeros or connect missing intervals without an explicit supported policy. Reject unsupported chart kinds and inconsistent formats. Preserve supplied category order and represent units and timestamps without implicit conversion. Empty valid datasets have a readable empty state, not a fictional chart.

The installed chart wrapper interpolates config keys and colors into generated CSS. Map external series keys to host-generated internal identifiers and use approved palette tokens; do not forward model-supplied CSS, selectors, color expressions or raw props. Escape text through React. Do not render raw HTML, functions or arbitrary URLs as executable content.

Charts must have a text description and an accessible data-table alternative. Host-owned axes, legends and tooltips should not clip or obscure units. Label applied sorting and any future transformation. Use ordinary application theme tokens and installed primitives rather than a separate visual theme.

## Conversation UX and ordering

Render artifacts as answer content outside collapsed Trace groups, with a compact title, description/source metadata where supplied, and an expandable view. Preserve an inspectable tool trace without rendering the artifact twice. Basic hover/tooltips, switching to data view and table sorting are local operations; they do not invoke the model or fetch data.

Preserve the event ordering of prose, each presentation call and subsequent prose, including adjacent or parallel calls inside tool batches. Choose a deterministic tool-call order consistent with the existing transcript rather than completion-time reordering. Maintain stable React identities and share the projection/rendering adapter between live and settled paths. A completed artifact must not disappear or move on settlement or reload.

Do not mount expensive charts inside the per-token text path or remount settled charts on unrelated deltas. Preserve bottom-follow and off-bottom reading positions. Expanded views use host-owned dialogs/sheets with normal keyboard focus behavior; narrow chat panels need bounded chart dimensions and readable table scrolling.

## Scope, tool policy and integration

Register the tools through existing tool-definition, availability and effect-policy paths. Presentation writes app-owned conversation state but grants no new source-data access. Decide availability in workspace and attachment-only chats explicitly. Read-only/plan-mode treatment must follow the existing policy rather than being accidentally inherited from filesystem tools.

Document support for live chats, durable tasks, workflow/run readers and provider transports. The initial product acceptance target is live and historical conversation rendering. Other transcript readers must show at least a truthful supported fallback, not claim interactive parity without tests. Add CLI/MCP bridge adapters only through their explicit allowlists; unavailable contexts return a clear error instead of silently dropping output. Test any exposed adapter's identity, permission and result projection.

Prompt guidance should explain when a chart helps, require previously obtained data and honest source labels, and distinguish snapshots from live dashboards. Never auto-refresh on mount or reuse a dashboard recipe. A future explicit “Save to dashboard” integration is not required here.

## Implementation sequence and ownership

### Phase A: Contract and durable vertical slice

Audit DB/tool lifecycle and media seams. Add shared discriminated schemas, validators, bounded storage/read paths and a single chart tool through completion/replay. Test transaction failure, retries and ownership before broadening the renderer. Proposed new module names such as `shared/conversation-artifacts.ts`, an artifact repository and a main-process artifact service are suggestions, not a mandate for parallel infrastructure.

Phase A implementation notes (2026-10-21):

`shared/conversation-artifacts.ts` defines the version-1 chart envelope/reference and strict validator. Bounds are 1,000 rows, 12 series, 64-character safe keys, 200-character labels/metadata, 2,000-character descriptions, 500-character categories and 256 KiB serialized snapshots. Numeric observations must be finite numbers or explicit nulls; missing observations are errors. Only number/integer/percent formats are supported, with percent values represented as fractions. Colors, executable formatting, recipes, ownership input and revision-update input are rejected.

Migration 77 adds SQLite-only `conversation_artifact_revisions` and typed `tool_result_artifacts` associations. The existing `markToolCallSettled` transaction writes validated content, invocation association and the bounded success acknowledgement together. Invocation retries reuse the original immutable revision; no pre-completion content is exposed. Conversation deletion cascades, and quotas reject writes without eviction or truncation (100 revisions and 8 MiB per conversation). Infrastructure failures roll back settlement; quota exhaustion becomes a durable recoverable tool error. Scoped exact-revision reads recheck successful lifecycle/assistant ownership and return bounded missing/corrupt/version fallbacks. The preload read API is guarded by main-frame sender and identifier checks.

`present_chart` is registered as a sequential mutation, offered alongside dashboard writes in interactive modes with or without a workspace, withheld in plan mode and subject to existing custom-agent allowlists. Runtime contexts without host staging fail closed. Chart staging travels through the scheduler rather than writing during tool execution; failed/interrupted calls do not commit it. Equivalent chart retries deliberately use the artifact repository's atomic invocation deduplication rather than generic side-effect reconciliation. No CLI/MCP adapter is allowlisted in Phase A. Shared inline projection, renderer integration, table contracts/tools, explicit revision updates, broader mode/prompt/provider qualification and manual Electron checks remain in Phases B–D. Until then the acknowledgement is the truthful text fallback in conversation/task/workflow readers; the tool description explicitly discloses that inline rendering is not available.

### Phase B: Shared inline projection and chart renderer

Add typed artifact references to the appropriate live and persisted tool/timeline contract. Introduce an artifact presentation adapter near `transcript.tsx`, not inside Markdown parsing. Extract a narrowly reusable chart renderer from `dashboards-screen.tsx` only where it preserves existing dashboard behavior. Keep snapshot validation independent of permissive legacy dashboard JSON.

Phase B implementation notes (2026-10-21):

Persisted messages and live tool-done events now carry typed artifact references from the host repository, not parsed Markdown or acknowledgement JSON. Historical timeline reconstruction joins those references to tool calls. The shared `TranscriptTools` adapter renders a chart at its declared tool-call position outside collapsed Trace groups, preserving adjacent call order and keeping the trace inspectable. Live repeated start events are ignored, duplicate tool IDs are filtered by the adapter, and enriched result events retain prior reference/message/media identity. Missing references produce an inline unavailable note rather than disappearing into Trace.

`ConversationArtifact` reads the exact revision through the scoped preload API, checks returned ownership/version/reference, revalidates snapshot data and renders escaped metadata plus bounded loading/empty/unavailable states. Memoized tool segments and chart leaves isolate charts from unrelated token deltas; requests are keyed by conversation/artifact/revision and stale responses are ignored. React identities are stable within each live or settled subtree; settlement retains content/order but uses the existing separate subtree transition (not a claim of cross-subtree component-instance continuity).

`CartesianChart` is extracted from dashboard chart presentation without changing legacy inference, colors, animation or axis defaults. Snapshot adaptation uses only generated `category`/`seriesN` keys and host palette tokens; supplied keys never enter chart CSS/config. Snapshots disable animation, retain category order and explicit null gaps, show markers for isolated observations, wrap legends and display supported numeric formats/units. No source-data access, refresh recipe or lazy-loading dependency was added. Expanded views, accessible chart data view, tables and revisions remain Phase C; task/workflow readers retain their textual acknowledgement fallback pending Phase D qualification.

Verification: `pnpm typecheck`, `pnpm build` and 64 targeted renderer/timeline/repository/message/scheduler tests pass. The full suite reports 2,538 passing tests, 77 skipped and the same two unrelated attachment-prompt assertions failing; the real agent-loop chart test passes with live/reload reference parity assertions. An isolated browser preview using the real component and app CSS was inspected at a 360px content width; this caught and fixed hidden isolated observations after null gaps. Full Electron scroll/focus/theme/accessibility qualification remains pending; no claim of Phase C data-view accessibility is made.

### Phase C: Tables, accessibility and revisions

Add `present_table`, accessible chart data view, expanded presentation and explicit revision conflict behavior. Use installed `ui/table.tsx` and host-owned sorting if included; a full data-grid package is not a prerequisite. Retain text/error fallback and source attribution in all supported readers.

Phase C implementation notes (2026-10-21):

`present_table` uses the same generalized staging, scheduler and atomic settlement path as charts. Strict table snapshots support 1–24 unique typed string/number/boolean columns, flat scalar/null cells and explicit missing-value rejection. Existing 1,000-row, 500-character text-cell, 256 KiB snapshot and conversation quotas apply; numeric formats/units are limited to numeric columns. Tables are registered alongside charts in interactive workspace and attachment-only contexts, withheld in plan mode, and retain bounded acknowledgements for other readers. No source fetching, links, executable cell content or refresh recipes are introduced.

Both tools accept paired `artifactId`/`expectedBaseRevision` inputs. Settlement revalidates these inputs and checks the conversation-owned latest revision and artifact kind within the existing transaction. Distinct stale/concurrent, foreign, missing and cross-kind updates settle as recoverable `artifact_conflict` errors with no revision/association written. Successful updates append immutable revisions; exact historical reads remain unchanged. Durable invocation retries reuse the original outcome before conflict checking, including identical equivalent invocations under the existing identity policy.

The shared transcript adapter recognizes both tools. Charts expose a local accessible data view; tables start in data view. Installed table primitives provide captions, scoped headers, labelled keyboard-scrollable bounded regions and explicit null text. Header buttons apply stable typed sorting with nulls last, `aria-sort`, an announced sorting label and reset to supplied order without changing saved rows or fetching data. Host-owned Radix dialogs expand either kind with title/description, source/data-as-of attribution and local chart/data controls. Existing app typography, theme tokens and chart styling are retained.

Verification: `pnpm typecheck` and `pnpm build` pass. All 76 focused contract/repository/tool/renderer tests pass, including exact old revisions, competing updates, owner checks, scalar bounds, numeric sorting/reset, chart data alternatives, dialog labels and mixed presentation-call ordering. Full suite: 2,566 passing, 77 skipped, and the same two pre-existing attachment-prompt assertion failures in `tool-error-feedback.integration.test.ts`. Both real agent-loop chart/table completion/replay tests pass with live/reload reference parity. A temporary browser preview using actual components/app CSS was inspected at 360px content width; table numeric sorting and expanded chart dialog were exercised, and preview files were removed. Full Electron keyboard/focus, scroll anchoring, theme contrast, large-table profiling and provider/task/workflow qualification remain Phase D; browser/component checks are not a claim of that broader qualification.

### Phase D: Registration, compatibility and qualification

Complete availability/prompt/provider adapters, integration tests and Electron verification. Add only the components or dependencies an observed requirement needs. Do not refactor dashboard CRUD, approvals, media or Markdown as collateral work.

Phase D implementation notes (2026-10-21):

Native Chat, Interactive and North Star now offer both presentation tools independently of workspace/attachments; plan mode and read-only runtime filters withhold them, and unoffered calls fail before executing. Restricted custom agents explicitly opt in through the new `presentation` category, independently of dashboard/source-data permissions. Conditional mode-prompt guidance requires previously obtained data, honest attribution and prose explanation, distinguishes immutable snapshots from live dashboards, explains revisions, and requires text/Markdown alternatives when tools are unavailable.

Task transcripts reuse `TranscriptTools`; workflow step readers render host-typed exact revisions beside, not inside, their collapsed tool traces. Reader tests verify scoped conversation/revision forwarding, a single visible presentation and preserved inspectable acknowledgements. Native OpenAI-compatible, Codex subscription and Claude subscription conversions are tested with the actual presentation schemas and saved acknowledgements. CLI Claude Code/Codex sessions deliberately remain unsupported: their explicit MCP bridge allowlists do not admit presentation tools, and real SDK client tests confirm both transports return unknown-tool errors rather than silently dropping data. No new bridge grants, source access, dependency or lazy-loaded package was added.

Qualification exposed faint light-theme series and low-contrast dark-theme axes. Snapshot-only host palette tokens now provide at least 3:1 series/surface contrast in both themes (tested), with theme-aware axis text. Legacy dashboard colors, axes and animation defaults are unchanged. Light/dark 360px content-width screenshots confirmed chart/null-gap legibility, prose order and bounded horizontal/vertical table scrolling.

Repeatable isolated Electron qualification is available with `node scripts/qualify-inline-artifacts-electron.mjs`. It builds the real components and app CSS, uses temporary user data (not the user's app DB), exercises 1,000 rows × 24 columns within the byte quota, numeric sorting/reset, local data-view switching without additional reads, Escape dismissal, dialog initial focus/return, selectable attribution, theme tokens, off-bottom reading preservation and bottom-follow during stable live-turn growth. Three simultaneous maximum tables (72,000 cells) are profiled; observed on Electron 37.10.3: initial fixture mount about 0.60 seconds, sorting 0.46 seconds, two additional maximum tables about 0.91 seconds. Existing row/column/byte budgets are retained; these local measurements are not a latency guarantee for a quota-full conversation. Fixture output and user data are cleaned up automatically.

Final verification: `pnpm typecheck`, `pnpm build`, `git diff --check` and the Electron qualification script pass. The focused permissions/provider/bridge/reader/contrast group passes 52 tests; the final agent-loop snapshot and chart regression subset passes 18 tests. Full suite: 2,587 passing, 77 skipped, and the same two pre-existing Chat attachment-prompt string assertions failing in `tool-error-feedback.integration.test.ts`; no new failure is introduced. Final Electron repeat: 0.71-second initial fixture mount, 0.47-second sort and 0.97 seconds for two additional maximum tables.

Qualification limitations: this is an isolated real-Electron component/scroller check plus repository/IPC/agent-loop coverage, not a full packaged-app restart or live authenticated-provider campaign. Native Enter/Tab event injection did not reliably reach the fixture in this environment, so full physical-keyboard focus trapping remains a manual release check; initial focus/return and DOM Escape behavior do pass. Tooltip layout retains existing component tests but pointer-driven Electron tooltip legibility is not certified here. No claim of CLI inline-artifact parity is made. Remaining broad release checks should not be inferred from the automated results.

## Verification and acceptance

Validator tests cover malformed JSON/shapes, undeclared and duplicate keys, null/missing/zero, non-finite numbers, oversize data, injection-like keys/colors/text, empty datasets and unknown schema versions. Repository/service tests cover conversation scoping, transaction failure, exact historical revisions, concurrent revision conflict, deletion, quota handling and durable-invocation retry idempotency.

Tool and transport tests cover validated success acknowledgements, failed/aborted calls, unavailable runtime contexts, allowlisted provider bridges and no implicit data fetching. Timeline/renderer tests cover duplicate events, adjacent/parallel presentation calls, prose ordering, live-to-settled parity, reload, unknown/missing artifacts, trace collapse and no duplicate display. Retain existing Markdown, tool-media, approval and transcript regression assertions.

Acceptance scenarios include a prose/chart/prose analysis, a null-containing time series, a sortable result table whose saved order remains unchanged, a requested revision with its original preserved, restart/reload, and a deliberately invalid spec that yields a recoverable tool error. Manual Electron checks cover narrow widths, large bounded tables, theme contrast, keyboard/focus, text selection, tooltip legibility and scroll anchoring. Profile repeated large bounded artifacts to choose final budgets.

In implementation, run targeted new/modified tool, repository and renderer suites, then `pnpm typecheck`, `pnpm test` and `pnpm build`. Verify packaged lazy loading if introduced. Accepted when valid snapshots are durable and readable inline, historic/live output agrees, failures are honest, and no additional code execution or data access is introduced.

## Explicit non-goals

No arbitrary JSX/HTML, generic UI DSL, live dashboard creation/refresh, calculation engine, arbitrary source-file ingestion, automatically installed components, interactive business forms, automatic exports, real actions from chart/table content, or replacing Mermaid for diagrams. PR116 builds declarative concepts on this foundation; executable previews remain deferred in PR117.

## Sources and research limitations

Initial research inspected the tool, dashboard, chart, transcript and timeline sources above and the [shadcn component catalog](https://ui.shadcn.com/docs/components). Installed source is authoritative for component APIs. Phase A subsequently audited and implemented the concrete lifecycle/schema seams described above; later-phase UI and transport behavior remains proposed.

Phase A verification: `pnpm typecheck` and `pnpm build` pass. Targeted contract, repository, tool, IPC, lifecycle, scheduler and migration suites pass (101 tests), as does the real agent-loop `present_chart` completion/replay test. The full suite run reports 2,519 passing tests, two unrelated Chat attachment-prompt assertions failing in `tool-error-feedback.integration.test.ts`, 77 skipped tests and an intermittent temporary Python-script cleanup rejection in `command_session_tools.test.ts`. No Electron visual verification was performed; Phase A adds no inline renderer.
