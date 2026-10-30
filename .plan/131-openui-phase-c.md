# PR131 Phase C — opt-in durable static visual answers

Status: implemented and qualified with synthetic input on macOS Electron. Phase D live generation comparison remains pending. No default rollout, removal of existing tools, or historical snapshot migration.

## Temporary contract

Set `NORTH_STAR_OPENUI_SPIKE=1` in the application environment and restart the application to offer `present_visual` to native agent providers. With the flag absent it is neither offered nor executable. Plan mode and existing custom-agent/read-only filters still apply. This change does not set the flag automatically. Already saved artifacts remain readable when the flag is disabled.

Tool input: `title`, optional description/source/dataAsOf, `library: "north-star-static-v1"`, `document`, and `datasets: [{id,snapshot}]`. Chart/table dataset snapshots use the existing kind/schemaVersion 1 contracts, not a new data language. Revision updates use the existing artifactId/expectedBaseRevision pair. No concept or design-choice support is added to this tool; present_ui continues to own those behaviors.

The static document supports Stack, Row, Text, Card, Metric, Chart, DataTable, Tabs and Tab with frozen positional signatures. Example:

```
root = Stack([Text("Synthetic evidence"),Metric("Completion",0.75,"percent"),Chart("rates")]);
```

The supplied datasets array must include a `rates` chart snapshot for that example. Metrics are already calculated by the caller. Percent values remain fractions. Nulls, source/data-as-of, units, supplied order, chart data view and local table sorting retain existing semantics. All content is a snapshot, not a dashboard or verified finding.

## Trust and replay

Shared pre-parser admission continues to reject references, expressions, state bindings, objects, extra statements and generated actions/tools before OpenUI sees source. Existing 64 KiB document, syntax depth, values/text/component budgets apply. The Phase C frozen library additionally validates exact scalar/child types, registered names, Tab parentage, dataset kind references, 200 nodes/depth 12, eight datasets, 2,000 rendered rows and total 256 KiB artifact bytes.

Uses OpenUI's exported core `parse` with a fixed parameter catalog, not createParser's telemetry wrapper or the React entry point. No call registry is installed. Even if an unsupported call were parsed, complete-result admission rejects errors, unresolved/orphaned names, dynamic props, state and query/mutation declarations. `north-star-static-v1` is a compatibility identity: do not change these positional meanings silently. Future incompatible libraries must keep a replay implementation for this identity or visibly report it unsupported. Unknown identities currently fail visibly without changing saved meaning.

Rendering uses parsed OpenUI ElementNodes and reviewed North Star components. It intentionally does not import react-lang Renderer: that avoids auto-mounted development CDN devtools, general action dispatch, last-good-child fallback and duplicate reactive state/evaluation machinery. Components explicitly read vetted fields; there is no generic prop spreading, generated HTML/styles/URLs, application context/IPC, network, clipboard or tool provider. Runtime render exceptions replace the answer with a visible error. The adapter is custom maintenance cost, not a demonstrated reduction in bespoke code. Local tabs/data views reset on page reload or revision change, and are not persisted or sent to the model.

`visual` is an additional existing-envelope artifact kind. Validation occurs during tool staging, successful-settlement persistence, database reads and transcript reads. Reuses conversation ownership, quotas, transactional rollback, immutable revisions, conflict receipts and invocation idempotency; no database migration was needed. Chart/table/UI validators and historical payloads are unchanged. Saved references travel through the same transcript mechanism as current presentation artifacts. Inline and expanded rendering use existing host controls.

Core parser and Zod are now runtime dependencies for packaged persistence/replay. React-lang remains development-only for Phase B. Zod 4 optional peer-resolution cost remains as documented in Phase B. The application renderer bundle excludes React-lang/devtools; the qualification fixture asserts this in its emitted module graph. Application main renderer chunk grew from the measured Phase B build's 6,625.13 kB to 6,804.34 kB (uncompressed; build-output comparison, not a controlled total-bundle benchmark).

## Verification

171 focused tests across twelve files passed with real Node SQLite enabled, covering visual admission/tool cancellation/flag/plan-mode checks, artifact revisions, conflict receipt, repeated settlement, exact old revision reads, conversation isolation, failed/malformed settlement without writes, message reference replay, legacy quotas/artifacts, native provider schema transport and unchanged external MCP behavior. Transcript tests render composed content and reject unknown library identities. Existing shared lifecycle tests cover retries and quota rollback.

`node scripts/build-openui-durable.mjs` builds an isolated qualification host in `.cowork/.tmp/openui-phase-c`. Launch its `main.cjs` through electron_launch and run `scripts/fixtures/openui-durable.check.json` through electron_run. The host uses a disposable profile, real conversation repository/tool invocation/settlement and SQLite storage, then closes/reopens the database before serving the saved artifact. Preload exposes only a scoped fixture read, not general application APIs. Remote requests, permissions and new windows are denied.

The saved 11-step Electron check passed: exact saved evidence, percent metric, underlying null observation, page reload preserving content while resetting local display state, expanded dialog and Escape/focus return. Screenshot is retained in conversation tool evidence. An initial fixture navigation policy blocked page reload; it was corrected to allow only same-document reload and the complete check rerun successfully. No claim that the initial failed check passed.

Application typecheck/build passed; fixture build passed with no React-lang/devtools/CDN assertion. First full-suite attempt had worker exits; rerun with `--maxWorkers=4` completed: 279 files passed, 2 failed, 6 skipped; 2,869 tests passed, 3 failed, 96 skipped. The three failures are the same attachment prompt expectations (two) and turbo effort expectation (one) observed in Phase B. No clean-base comparison was done. Local logs: `.cowork/.tmp/phase-c-regressions.log`, `phase-c-full-bounded.log`, `phase-c-app-build.log`.

## Provider and product limits

Native API/subscription schema transport tests include present_visual. External CLI MCP bridge deliberately remains unchanged: its existing tests verify it does not expose presentation tools. CLI sessions do not gain the experimental tool; they retain textual output. No model/provider calls were made or accounts changed. Actual model generation and correction rates, streaming, app-shell live-model interaction, packaged replay and Windows/Linux remain unqualified. Completed artifacts only; no progressive preview or preview host interactions were added.

Phase C proves the real durable path with fixed synthetic input, not live generation quality. Next is Phase D: repeated representative prompts through approved providers, cost/token/error measurements and an adoption decision. Keep the flag opt-in and existing presentation tools in place until that decision.

## Initial live feedback: contract corrections

User-reported team comparison attempted a descriptive percent unit, then malformed document nesting without a final semicolon; Text also included unsupported role arguments. Reproduced the exact document failure at offset 462. Clarified exact Text arity, tab nesting, mandatory terminator and percent units (omit or `%`, including table columns) in the tool description and field-level schema guidance. Added a complete minimal two-tab example. Admission remains strict; no automatic bracket/unit repair or silent argument dropping. Syntax failures now explain the terminator/nesting requirement, and complete-parse failures include up to three bounded parser diagnostics so excess arguments can be corrected. Regression tests reproduce the reported sequence, the latent Text arity error and a corrected two-tab answer. Forty-six focused tests and typecheck passed. This validates contract/error feedback, not a measured live-generation success-rate improvement.
