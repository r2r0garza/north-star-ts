# PR131 containment and Phase B — 2026-10-29

Status: isolated static comparison implemented and exercised on macOS Electron. Phase C remains pending, not cancelled. The earlier Phase A stop is superseded for this restricted fixture only; the unmodified language/runtime is still not approved for application integration.

## Containment implemented

`src/shared/openui-static-admission.ts` checks the source before calling any OpenUI parser. Its deliberately small grammar admits one complete root assignment with registered inline components, JSON strings, finite numbers, booleans, nulls and arrays. It rejects references (including the repeated-reference amplification probe), extra statements, objects, comments, expressions, assignments, state bindings, built-ins, queries, mutations, actions and unknown components. It reconstructs canonical source, so raw input is never passed downstream. Syntax-looking text remains inert text. Limits: 64 KiB input, 24 syntax nesting levels, 200 component calls, 4,000 values and 2,000 characters per string.

The fixture adapter then requires a complete error-free parse with no unresolved/orphaned declarations, generated state or tool statements. It validates exact component schemas and child shapes, limits rendered depth to 12 and elements to 200, and caps total referenced dataset rows at 2,000 and concept instances at six. Tabs own ephemeral React state, not generated expressions. Dataset ids point only at fixed host-owned, legacy-validated synthetic snapshots. There is no second analytical data language. Invalid admission produces a visible alert rather than a partial answer. Renderer-reported errors hide the incomplete content and show an alert.

`node scripts/build-openui-fixture.mjs` builds with NODE_ENV=production regardless of surrounding environment and asserts that emitted chunks contain neither the CDN bootstrap strings nor devtools modules. No development server or raw development import is supported. The build writes a separate Electron main into ignored `.cowork/.tmp/openui-phase-b`, with sandboxed/context-isolated renderer, no preload/Node integration, denied permissions/new windows/navigation, and a request interceptor allowing only local file requests. HTML CSP additionally denies connections, images, forms and remote scripts. The renderer receives no IPC, MCP provider, host action handler, clipboard facility or application context. Observability publication is disabled. Source package internals are not patched.

These controls qualify this static fixture, not every OpenUI feature. A production artifact path must enforce the same admission in the trusted persistence boundary; this work does not claim that boundary exists yet. Do not reuse the raw Renderer directly in normal development mode.

## Library and comparison

Development-only dependencies are pinned to react-lang/lang-core 1.0.2 and Zod 4.1.12. Lockfile pins devtools 0.3.1 and observability 0.0.4 transitively. Adding root Zod 4 changes optional provider peer resolution from Zod 3 to 4; this is a real integration cost, not hidden. An attempted reuse of Zod 3's early v4 compatibility entry produced an upstream missing `mergeDefs` export warning, so it was not retained. All provider presentation contract tests passed; broader failures are recorded below.

Ten registrations: Stack, Row, Text, Card, Metric, Chart, DataTable, Tabs, Tab and Concept. Cards, tabs, buttons, tables, dialogs, chart model/formatting, CartesianChart and UI concept demo renderer reuse North Star components. Concept currently embeds a fixed legacy demo; it is not evidence that OpenUI replaces the complete present_ui vocabulary. Alternatives are local tabs in the fixture, not persisted design alternatives, and there is deliberately no design-choice send/approval button.

The fixture compares metrics, composed metrics/chart/table, cards/tabs, multi-screen concept layouts, a 1,000-row dataset with gaps/long labels plus an empty result, and prose-only explanation. A rejected-expression case exercises visible failure. The baseline uses the same readers/data and plainly labels unsupported compositions. It is a manual fixture comparison, not generated model-output evidence.

Design uses existing North Star typography, light/dark palette and spacing; both surfaces are 360 CSS pixels wide. Expanded comparison uses the existing host dialog. No extra design system or custom theme was added.

## Observed Electron results

Launched the isolated built fixture using electron_launch and inspected snapshots/screenshots. Light and dark mixed-answer screenshots, a dark concept screenshot and expanded-dialog screenshots are retained in the conversation's tool evidence, not committed image files. `scripts/fixtures/openui.check.json` saves the durable rerunnable 26-step check; all steps passed. Additional exploratory runs exercised dark/light switching, metrics and large-data expansion.

Verified: 75%/25% formatting, explicit “No value” gaps, supplied order and readable underlying tables, 1,000-row caption, explicit empty result, keyboard ArrowRight tab selection, local screen transition, reset returning to initial alternative, dialog opening/Escape/focus return, invalid-expression alert, and prose with no tables. App session log tail was empty; no remote request or runtime failure appeared in captured host logs. This is observation plus source/build controls, not a network penetration test.

Mixed composition is more scannable than separate analytical artifacts: summary metrics and explanation travel with supporting evidence. Expanded width makes the supporting table easier to inspect. At narrow width the shared chart suppresses the first long category tick (also observed expanded for this deliberately long label); its full value remains in the underlying-data view. This is shared chart behavior, not missing source data. Metric-only prose remains competitive; concept wrapping mostly reproduces what present_ui already does. The chart/table renderer adapters are small, but admission/schema maintenance remains custom work, so there is no demonstrated maintenance saving yet.

Responsiveness evidence is limited: saved Electron check completed in about 3.6 seconds total, including tool input delays; the large-fixture selection step took about 0.49 seconds and expanded large view about 0.62 seconds in exploratory checks. These are host interaction timings, not isolated render benchmarks. No freezes occurred. No timing threshold is claimed.

Fixture build: 1,121,580 total asset bytes, including existing chart/React/component code; main JS 883.80 kB (268.95 kB gzip), CSS 232.14 kB (34.81 kB gzip), helper JS 5.65 kB. This is **not the incremental OpenUI bundle cost**; no matched baseline bundle delta was measured. Production application build still does not import fixture/runtime code.

## Reproduction and checks

Run `node scripts/build-openui-fixture.mjs`, launch `.cowork/.tmp/openui-phase-b/main.cjs` through the supported Electron launch tool, then run `scripts/fixtures/openui.check.json` through electron_run. Build output is intentionally disposable. The ordinary application does not offer this fixture or any new presentation tool.

Focused artifact/admission/component tests: 8 files, 132 passed. Provider artifact-tool contract adds one passing test. Application typecheck, fixture typecheck (`pnpm exec tsc --noEmit -p scripts/fixtures/tsconfig.openui.json`), fixture build/no-CDN assertions and application production build passed.

Full suite: 277 files passed, 2 failed, 6 skipped; 2,851 tests passed, 3 failed, 96 skipped. Failures are two attachment prompt-expectation tests in `tool-error-feedback.integration.test.ts` and the `turbo` effort expectation in `db/repositories/conversations.test.ts`. The changed code does not touch these paths, but no clean-baseline rerun was performed, so they are not asserted to be pre-existing. Existing act-environment warnings remain in component tests. Full output is retained locally in `.cowork/.tmp/openui-full-tests.log`.

## Gate recommendation and limits

The bounded subset establishes enough containment to evaluate composition. Phase B demonstrates a useful mixed-answer surface, but a **conditional continuation**, not adoption: retain this fixture for review and resolve how much custom admission/library code is worth maintaining before committing to Phase C. No tool, persistence, artifact lifecycle or provider model-generation path was added.

Still unqualified: arbitrary OpenUI, credential/form flows, persistence admission, exact revision/alternative choice, reload/history/cancellation, generated model success rates, token/latency comparisons, minimum mobile window sizes, automated contrast/overflow measurements, all portal types, packaged behavior and Windows/Linux. The host dialog and keyboard tabs were exercised, not a comprehensive accessibility audit. Phase C remains pending Phase B review and any required refinement; Phase D generation comparison remains pending. No default rollout or tool removal is implied.
