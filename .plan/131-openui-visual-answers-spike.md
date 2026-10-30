# PR131: OpenUI richer visual answers — evaluation spike

> Status: **Planned (2026-10-29) — implementation not started.** Local branch: `spike/openui-visual-answers`. Builds on [PR115: inline analysis artifacts](115-inline-analysis-artifacts.md) and [PR116: UI concept previews](116-ui-concept-previews.md). Does not activate [PR117: executable HTML/React previews](117-sandboxed-html-react-previews.md).

## Product decision

Optimize for richer visual answers, not generated mini-apps. An answer should be able to compose explanatory text, metrics, charts, tables, cards and local display controls in one coherent surface. UI sketches remain useful, but are not the only presentation use case.

Evaluate OpenUI as the presentation language and rendering engine inside North Star's existing artifact infrastructure. Do not replace artifact ownership, immutable revisions, validation, quotas, invocation settlement or transcript transport. Do not commit to replacing every presentation tool before the spike demonstrates value.

OpenUI's architecture leaves a possible future path to tool-connected interfaces. Preserve that option by keeping host behavior separate from presentation content, not by implementing an execution framework now. Mini-apps require a separate product decision, permission model and security review.

## Why investigate

`present_ui` already maintains a small bespoke UI language, model instructions, validation and a recursive React renderer. Its current vocabulary cannot embed charts. `present_chart` and `present_table` offer useful analytical contracts but produce separate artifacts rather than a mixed analytical answer.

OpenUI supplies schema-defined component registration, library-derived prompts, a compact model-generated language, React rendering, local state and streaming support. The hypothesis is that adopting its language/runtime can unlock useful composition while reducing the custom UI-language work we maintain. More chart types alone are not sufficient justification.

Research sources, reviewed 2026-10-29: [repository](https://github.com/thesysdev/openui), [component definitions](https://www.openui.com/docs/openui-lang/defining-components), [renderer](https://www.openui.com/docs/openui-lang/renderer), [architecture](https://www.openui.com/docs/openui-lang/architecture), and [specification](https://www.openui.com/docs/openui-lang/specification). Recheck APIs and package versions at implementation time. Vendor token/latency claims are hypotheses to measure locally, not expected results.

## Scope and retained contracts

Use the local open-source runtime and a small North Star-owned component library. Prefer existing React primitives and the existing chart renderer over importing a second design system. Begin with layout, text, cards, metrics, charts, tables and tabs; add other components only when a fixture needs them. Do not expose the entire installed UI directory.

Analytical answers use data obtained before presentation. Preserve source and data-as-of labels, units, percentage conventions, explicit nulls, category ordering and a readable underlying-data view. These labels are attribution rather than verification. Keep sample design content distinguishable from analytical findings. A richer visual answer is a snapshot, not a live dashboard.

Retain host-owned expand, revision and design-choice controls. If concepts use alternatives, retain selection of an exact artifact revision and alternative, with selection drafting a user message rather than editing files or approving actions. No claim that North Star components reproduce a workspace's actual design system.

Keep existing artifacts readable without rewriting historical snapshots. If the spike persists OpenUI content, use an explicitly versioned payload/library identity within the existing artifact envelope, and document replay behavior. Positional component arguments make schema ordering part of the compatibility contract. Do not mutate an old artifact's meaning by changing the registered library silently.

## Capability boundary

Generated content is untrusted presentation data interpreted by a reviewed runtime and rendered by vetted components, not arbitrary JavaScript, JSX or HTML. No generic prop spreading, arbitrary styles/classes, raw HTML, external assets, URLs, imports or access to application context/IPC through component props.

For this spike, deny tool-connected queries and mutations, navigation, network access, clipboard operations, automatic conversation sends and any filesystem or service actions. Do not supply a general `toolProvider` or MCP client. Enforce the allowed language/features and events at runtime and at persistence admission; prompt flags alone are not a permission boundary. Check the installed runtime's built-in actions and expression support rather than assuming omitted prompt instructions disable them.

Only bounded local display state is permitted, such as tab selection, display filters over supplied snapshot data, or demo screen transitions. Form/demo state is ephemeral, resets on revision changes/reload, and is not sent to the model or stored automatically. No real credential entry or operational submission flows.

Keep resource limits for payload bytes, node/statement count, depth, data size and evaluation/render work. Identify which limits OpenUI enforces and which North Star must enforce. If bounded evaluation cannot be established, narrow the supported subset or stop the spike. Test containment, keyboard behavior and component portals before exposing them.

OpenUI can render the remaining content after dropping invalid pieces. That may be useful for a partial preview, but a completed answer must visibly report missing/invalid content rather than silently presenting an incomplete analysis. Do not persist a partially valid result as a successful complete artifact.

## Evaluation sequence

### Phase A: Baseline and dependency/runtime investigation

Record the current branch baseline and exact dependency versions selected. Inspect React/Electron compatibility, license terms, transitive dependencies, build output impact, optional telemetry/cloud hooks and required runtime capabilities. No hosted Gateway, cloud observability, new account, provider migration or chat-shell replacement is required.

Create a small repeatable fixture set using synthetic, clearly labeled data. Capture current-tool outputs where expressible, and explicitly mark unsupported compositions instead of manufacturing an equivalent baseline. Record the existing analytical and UI-concept regression cases to preserve.

Exit: a documented dependency/capability assessment and fixed comparison inputs, before product integration.

### Phase B: Isolated visual comparison

Build a development-only fixture surface using a minimal registered library backed by North Star components. Reuse the chart/data semantics instead of creating another analytical data language. Keep it separate from normal tool offering while evaluating rendering and containment.

Exercise a concise metric summary; a mixed summary with metrics, chart and supporting table; a comparison answer using cards/tabs; a multi-screen UI concept with alternatives; and a larger chart/table with missing observations, percentages, long labels and an empty-data case. Include an explanatory answer that does not benefit from UI, to ensure prose remains the default when appropriate.

Measure readability at conversation width and expanded width, dark/light themes, keyboard accessibility, parse/render errors and responsiveness. Run a build and inspect the actual Electron surface using the supported Electron tools. Record screenshots and repeatable checks with the findings.

Exit: visible improvement on mixed answers, faithful analytical rendering and no privileged behavior. If the improvement is marginal or maintaining adapters is as complex as the existing language, recommend against adoption.

### Phase C: Thin end-to-end artifact spike

Only after Phase B passes, prove one opt-in presentation path through existing tool invocation, validation, persistence and transcript rendering. Do not replace the default tools or migrate old artifacts. Pick the smallest temporary model-facing contract needed for evaluation and record it; the spike is evidence, not a permanent API commitment.

Use the existing artifact envelope, conversation scoping, quotas, revision conflict handling and successful-settlement transaction. Verify cancellation, malformed input, retry/idempotency, reload, old-revision display and legacy chart/table/UI rendering. Check built-in provider and external CLI/MCP presentation seams affected by any new tool or artifact kind.

Completed-artifact rendering is sufficient for this phase. Progressive previews are a separate optional experiment only if the relevant provider already exposes usable argument deltas. Mark previews uncommitted, disable host interactions until validation/settlement, discard cancelled previews, and never imply that installing a streaming renderer makes all tool calls stream.

Exit: one real visual answer survives conversation reload without weakening the artifact or tool contracts.

### Phase D: Generation comparison and decision

Use the same representative prompts and data for current tools and the OpenUI path. Record model/provider versions, generated payloads, component prompt overhead, output tokens, time to first usable visual, completion time, invalid/incomplete generations and correction attempts. Use repeated runs rather than a single attractive example; report sample sizes and unavailable comparisons. Keep any added provider usage within existing user-approved accounts and do not export conversation data to a new service.

Record a go/no-go recommendation in this file with evidence, limitations, code retained/deleted in a proposed adoption, and follow-up scope. A successful spike does not itself authorize default rollout or replacement of all presentation tools.

## Adoption decision to make after the spike

The leading option is one richer composition path backed by OpenUI, while retaining the concise `present_chart`/`present_table` interfaces where their semantic contracts help. `present_ui` is the strongest candidate for eventual language/renderer replacement. Decide tool naming, whether shared adapters reduce duplicate rendering, and which existing code can actually be deleted after measurement—not by creating a permanent parallel presentation subsystem first.

Keep the render/runtime adapter separate from host actions. A future tool-connected mode would need explicit capabilities, host-side authorization, approval/audit integration, replay rules and its own plan. Do not add speculative hooks or implement mini-app infrastructure during this evaluation.

## Success and stop criteria

Success means materially better mixed visual answers, faithful and inspectable data, preserved historical artifacts and design-choice behavior, a runtime-enforced presentation-only boundary, and an integration cost justified by reduced custom-language maintenance or demonstrated capability gains. Document prompt/bundle/runtime costs even if the output looks better.

Stop or narrow scope if correctness depends on silently dropping invalid content, denied capabilities cannot be enforced, saved content cannot be replayed predictably, the runtime harms responsiveness/accessibility, or the library adds substantial complexity without improving representative answers. Token savings are not a prerequisite and must not excuse worse data integrity.

## Verification and deliverables

The spike delivers a minimal branch-local implementation, repeatable fixtures/checks, measured comparisons, a capability/dependency assessment and a decision write-up. Run focused schema/component/artifact tests, typecheck and build; run the broader suite before recommending adoption. Distinguish source inspection, automated checks and observed Electron behavior. Cross-platform/packaged behavior not exercised must remain explicitly unqualified.

This plan-preparation step creates only the branch and this document. Dependency installation, implementation, model experiments and application verification begin in a subsequent implementation step. No commits, remote pushes, roadmap rollout changes, current-tool removal, live-dashboard changes or PR117 activation are included in preparation.

## Results

Not started. No compatibility, performance, token-savings or rendering claims have been verified by a spike yet.
