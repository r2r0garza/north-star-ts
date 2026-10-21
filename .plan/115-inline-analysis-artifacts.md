# PR115: Inline analysis artifacts — charts and tables

> Status: **Proposed — not implemented.** Next up, after the existing PR112 delivery sequence. Establish the smallest durable conversation-artifact slice needed to present analysis visually. Follow-ups: [PR116: UI concept previews](116-ui-concept-previews.md) and [PR117: sandboxed HTML/React previews](117-sandboxed-html-react-previews.md).

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

### Phase B: Shared inline projection and chart renderer

Add typed artifact references to the appropriate live and persisted tool/timeline contract. Introduce an artifact presentation adapter near `transcript.tsx`, not inside Markdown parsing. Extract a narrowly reusable chart renderer from `dashboards-screen.tsx` only where it preserves existing dashboard behavior. Keep snapshot validation independent of permissive legacy dashboard JSON.

### Phase C: Tables, accessibility and revisions

Add `present_table`, accessible chart data view, expanded presentation and explicit revision conflict behavior. Use installed `ui/table.tsx` and host-owned sorting if included; a full data-grid package is not a prerequisite. Retain text/error fallback and source attribution in all supported readers.

### Phase D: Registration, compatibility and qualification

Complete availability/prompt/provider adapters, integration tests and Electron verification. Add only the components or dependencies an observed requirement needs. Do not refactor dashboard CRUD, approvals, media or Markdown as collateral work.

## Verification and acceptance

Validator tests cover malformed JSON/shapes, undeclared and duplicate keys, null/missing/zero, non-finite numbers, oversize data, injection-like keys/colors/text, empty datasets and unknown schema versions. Repository/service tests cover conversation scoping, transaction failure, exact historical revisions, concurrent revision conflict, deletion, quota handling and durable-invocation retry idempotency.

Tool and transport tests cover validated success acknowledgements, failed/aborted calls, unavailable runtime contexts, allowlisted provider bridges and no implicit data fetching. Timeline/renderer tests cover duplicate events, adjacent/parallel presentation calls, prose ordering, live-to-settled parity, reload, unknown/missing artifacts, trace collapse and no duplicate display. Retain existing Markdown, tool-media, approval and transcript regression assertions.

Acceptance scenarios include a prose/chart/prose analysis, a null-containing time series, a sortable result table whose saved order remains unchanged, a requested revision with its original preserved, restart/reload, and a deliberately invalid spec that yields a recoverable tool error. Manual Electron checks cover narrow widths, large bounded tables, theme contrast, keyboard/focus, text selection, tooltip legibility and scroll anchoring. Profile repeated large bounded artifacts to choose final budgets.

In implementation, run targeted new/modified tool, repository and renderer suites, then `pnpm typecheck`, `pnpm test` and `pnpm build`. Verify packaged lazy loading if introduced. Accepted when valid snapshots are durable and readable inline, historic/live output agrees, failures are honest, and no additional code execution or data access is introduced.

## Explicit non-goals

No arbitrary JSX/HTML, generic UI DSL, live dashboard creation/refresh, calculation engine, arbitrary source-file ingestion, automatically installed components, interactive business forms, automatic exports, real actions from chart/table content, or replacing Mermaid for diagrams. PR116 builds declarative concepts on this foundation; executable previews remain deferred in PR117.

## Sources and research limitations

Research inspected the tool, dashboard, chart, transcript and timeline sources above and the [shadcn component catalog](https://ui.shadcn.com/docs/components). Installed source is authoritative for component APIs. DB/event/module names beyond inspected seams are proposed and require implementation-time confirmation. This is a future implementation plan; no artifact tools, migrations, runtime UI, tests or performance claims were implemented or verified by writing it.
