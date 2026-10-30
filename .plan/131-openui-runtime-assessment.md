# PR131 Phase A assessment — 2026-10-29

> Historical Phase A result. The subsequent [containment implementation and Phase B comparison](131-openui-phase-b.md) supersede the stop for a restricted static fixture only; the unmodified runtime is still not approved.

Decision at Phase A: **stop before Phase B; no-go for adopting the unmodified 1.0.2 React runtime.** This is a capability/cost gate result, not a visual-quality comparison or a claim that a restricted integration is impossible. No production dependency, renderer, tool, artifact kind, network capability or persistence contract changed.

## Baseline and selected packages

Clean branch `spike/openui-visual-answers`, baseline commit `aa972e67f755ce34dc0cfb07ae5963822311d8c9`. North Star declares React/React DOM 19.2.4, Recharts 3.8.0 and Electron ^37.10.3. Registry metadata and npm tarballs were inspected, not just documentation.

Candidates: `@openuidev/react-lang@1.0.2` (684,444 unpacked bytes), `@openuidev/lang-core@1.0.2` (1,432,842), `@openuidev/devtools@0.3.1` (878,750), `@openuidev/observability@0.0.4` (26,746). All four ship MIT license metadata; the downloaded tarballs contain license files. These are package sizes including source maps, **not bundle deltas**. React-lang depends on the other three through caret ranges; reproducible adoption would need lockfile pinning. Lang-core additionally depends on `ci-info` (^4.4.0; isolated install resolved 4.4.0). Its Zod peer was tested with exactly 4.1.12. React-lang accepts any React version and optional React DOM, React Native and MCP peers; no peer-level React 19 conflict, but React/Electron behavior was not exercised. No second design system is necessary.

The isolated installation used `--ignore-scripts`: lang-core has a postinstall entry. Its postinstall and cloud entry are not qualified for app use. No Gateway, account, cloud entry or new provider was used. The app package.json and lockfile remain untouched.

## Capability findings

Published source-map files in the exact tarballs provide these evidence points (paths below are original source names, not North Star files).

`react-lang/src/devtoolsBootstrap.ts` runs at import time when NODE_ENV is development, auto-mounts devtools with version `0`, and imports the devtools package. `devtools/src/cdn.ts` dynamically imports `https://cdn.jsdelivr.net/npm/@openuidev/devtools@0/dist/devtools.browser.js` with a time-bucket cache key, injecting the host React and react-lang graph. This is a moving remote executable dependency in the intended development evaluation path. Production dead-code elimination is claimed in source, not measured here. It must be explicitly excluded or patched, not left to prompt flags or a failed network request. No CDN code was loaded in this assessment.

`lang-core/src/telemetry/runtime.ts` documents opt-in sampled server-side parser/prompt telemetry via OPENUI_RUNTIME_TELEMETRY_ENABLED=1; browser/worker execution does not send it. Probes explicitly set this variable to 0. Observability is a local event bus by source inspection, but publishing generated content into application-global listeners would still need review and disabling. No optional hooks were activated.

`lang-core/src/parser/parser.ts` installs BUILTIN_CALLS in compileSchema even for a library with only Stack and Text. The public createParser result does not expose a pre-materialization admission hook or evaluation/work budget. The evaluator interprets expressions rather than requiring arbitrary JavaScript, but includes collection operations and built-in action plans. Built-in actions include OpenUrl, ContinueConversation, Run, Set and Reset; query/mutation declarations are separate from registered component names. Omitting toolProvider is necessary but is not a complete language admission policy. These findings are not evidence that a URL opened or a tool executed: only parsing and source inspection were performed.

`lang-core/src/parser/materialize.ts` resolves references recursively, detects cycles but removes names from the visited set after each branch, and expands repeated references again. A small, bounded parser probe produced:

| Source bytes | Statements | Expansion depth | Materialized elements | Parse time, one sample |
| --- | --- | --- | --- | --- |
| 155 | 5 | 4 | 31 | 0.20 ms |
| 291 | 9 | 8 | 511 | 1.36 ms |
| 430 | 13 | 12 | 8,191 | 9.27 ms |

Do not extrapolate those times into a benchmark. The important repeatable result is node amplification before a post-parse validator could enforce the existing 200-node UI limit. Bytes, statement counts and cycle detection alone do not bound expanded work. The probe intentionally stops at depth 12 and does not attempt a host freeze. There is no claim that a depth-12 tree meets the existing UI depth contract.

The parser also returns a non-null, incomplete root with zero errors for an unclosed Text call, and a completed root with an unknown child removed plus an error. A query declaration and a built-in Sum expression both parse without errors with the minimal library. Therefore completed-artifact admission would need to reject incomplete, unresolved, orphaned, error-bearing and disallowed-language input before rendering; component schemas and onError reporting alone are insufficient. Runtime failures must visibly invalidate the result, not leave the renderer's last-good-child fallback presented as a complete answer.

## Fixed comparison inputs and preserved regressions

`src/shared/openui-comparison.fixture.ts` fixes six representative prompts: metrics, mixed analytics, cards/tabs comparison, alternative/multi-screen concept, large/empty analytics, and a prose-only control. All data is synthetic, percentages are fractions, gaps are explicit nulls and category order is retained. It marks unsupported current-tool composition rather than inventing a baseline equivalent. Expressible legacy snapshots pass the existing validator. These are fixed inputs, **not model-generated outputs**; the concept prompt points to existing PR116 screen/alternative cases rather than claiming a new equivalent output was generated.

Retained regression coverage: shared analytical/schema and UI-concept tests, artifact readers, conversation artifact rendering, and UI concept previews (including exact revision choice, alternative switching and local screen state). Existing `scripts/fixtures/inline-artifacts.tsx` and `ui-concepts.tsx` remain unchanged. No historical snapshot rewrite or library identity was introduced. A future persisted language must pin both payload version and positional component schema identity, and preserve the old renderer for historical revisions.

## Repeat the isolated checks

From the workspace root, use an ignored disposable directory:

```sh
npm install --prefix .cowork/.tmp/openui-assessment/runtime --ignore-scripts --no-audit --no-fund --save-exact @openuidev/lang-core@1.0.2 zod@4.1.12
node scripts/fixtures/openui-assessment.mjs .cowork/.tmp/openui-assessment/runtime/node_modules/@openuidev/lang-core/dist/index.mjs
pnpm exec vitest run src/shared/openui-comparison.test.ts src/shared/conversation-artifacts.test.ts src/shared/ui-concept-artifacts.test.ts src/renderer/src/components/artifact-readers.test.tsx src/renderer/src/components/conversation-artifact.test.tsx src/renderer/src/components/ui-concept-preview.test.tsx
pnpm typecheck
pnpm build
```

The probe uses assertions and only the parser; six scenarios passed. The six focused Vitest files passed, 104 tests total. Existing React act-environment warnings were emitted by component tests. Typecheck and production build passed. No app runtime imports these fixture files or the probe. Production build succeeded without adding OpenUI; its integration bundle impact is unmeasured, not zero.

## Decision and restart conditions

Stop under the plan's bounded-evaluation criterion rather than building a second parser and speculative integration now. The CDN auto-bootstrap is an additional dependency concern, not proof that all OpenUI use requires the network. A production-only isolated bundle could remove it, but would not solve expansion or language admission.

To restart: propose a reviewed no-CDN entry/build and a pre-materialization bounded subset or upstream resource budget. Quantify the adapter cost before assuming it reduces custom-language maintenance. Local tabs can remain vetted component-owned state; no generated queries, expressions, host actions or general event dispatcher are needed for the initial static comparison. A restricted parser/worker strategy needs its own depth, expansion, timeout and malformed-input tests; a post-parse node walk alone is too late. Then run Phase B before considering a new artifact contract.

No model comparison runs (sample size zero), prompt token measurements, visual screenshots, Electron checks, dark/light or keyboard/portal checks, artifact lifecycle spike, broad test suite or cross-platform/package qualification were performed. None of the plan's visual-quality, end-to-end replay or generation-cost success criteria are claimed. Keep existing presentation tools and prose defaults; do not recommend rollout. Retain only the fixtures, assertions and assessment from this attempt; there is no runtime integration code to remove.
