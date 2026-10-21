# PR113 code review

Reviewed the working-tree implementation against `.plan/113-shadcn-trace-adoption.md` and the planning acceptance criteria, using HEAD `f36e975` as the comparison baseline. Prior implementation results were treated as claims, not verification. Application code, tests and configuration were not modified.

## Confirmed defects

### R1 — Low severity: running Trace rows have no animation

Requirement: the status contract and AC2/AC3 require one subtle running treatment, including working compiled shimmer styles.

Locations: `src/renderer/src/components/ui/trace.tsx:36`, `src/renderer/src/globals.css:13–39`; affected consumers include `transcript.tsx:228–242`, `tool-group.tsx:186,369`, `run-detail.tsx:514–533,665–677`, and `todo-trace-list.tsx:35`.

Expected: a running TraceLine applies the defined title shimmer, unless reduced motion is enabled. Actual: TraceLine requests `data-[status=running]:*:data-[slot=trace-title]:shimmer`, but the added utility is named `trace-shimmer`. The old spinners were removed, so the migrated activity rows are static even with normal motion preferences. Explicit status text still works; there is no orchestration or approval failure.

Evidence: traced the consumers through TraceLine/TraceTitle into globals.css and compiled the actual stylesheet with the installed Tailwind PostCSS plugin. Enumerating every rule containing `shimmer` returned only `.motion-reduce\\:trace-shimmer-none`; there were zero running shimmer rules. The `trace-shimmer` keyframes exist but nothing applies their animation. The primitive test checks class strings and the reduced-motion reset, not a generated running rule, so all focused tests pass despite the defect. Use the matching utility name and verify the emitted selector/declarations, not merely keyframe existence.

Classification: **Confirmed**, by complete source/CSS-generation path and reproduced compiled output.

### R2 — Low severity: active todos lose their compact font size

Requirement: AC2/AC12 and phase D preserve the two consumers' existing compact typography.

Locations: `src/renderer/src/components/todo-trace-list.tsx:29–35`, `src/renderer/src/components/ui/trace.tsx:36`, `src/renderer/src/components/todos-section.tsx:156`.

Expected: the active panel's `className="text-xs"` controls todo row font size, while historical rows use `text-sm`. Actual: every TraceLine retains its own `text-sm`; `text-inherit` changes color, not font size. The list's inherited text-xs therefore cannot size the active rows. This enlarges the active checklist and its wrapping/height; the historical consumer remains at its intended size.

Evidence: traced TodosSection → TodoTraceList → TraceLine → cn/tailwind-merge. Running the exact base/override class merge retains `text-sm items-start text-inherit`. Compiling the actual stylesheet confirms `.text-inherit { color: inherit; }`, with `.text-sm` setting font-size and line-height. The todo test asserts content, statuses, wrapping classes and strike-through, but not consumer font sizing. Apply an actual font-size inheritance override or the intended size at the row boundary.

Classification: **Confirmed**, by complete composition/class-merge/generated-CSS path; no visual screenshot is needed to establish the conflicting font declarations.

## Potential risks

No additional potential defect is supported strongly enough to report as a finding. Narrow-width title/status visibility and real disclosure-animation behavior remain runtime verification gaps rather than confirmed regressions. No security, orchestration or approval-routing regression was identified in the inspected changes.

## Coverage and verification gaps

The focused tests meaningfully exercise mixed-state precedence, pending approval distinct from running, initially closed disclosures, stable keyed row updates/reordering, tool clipping and raw arguments, independent delegated navigation, exact media provenance and lazy unload/reopen, workflow response arrays/reversed arrival/orphans/structured error refresh, closed-step polling, all seven step statuses, read-only todo semantics, historical no-fetch snapshots and background-handoff races. Workflow response pairing remains its own adapter; timeline behavior and approval controls are unchanged by this diff.

Coverage is incomplete for the acceptance criteria. CSS tests assert class names rather than an applied running style, and todo typography is untested; both gaps allowed the confirmed defects. Workflow tests retain some incidental pre/child counts, although they also assert correctly scoped response content. They do not exercise supplied agent/skill metadata, exact raw argument preservation, live-event task filtering/reset/tail behavior, or run/step identity changes. Delegated fixtures always supply extensive metadata and do not test absent metadata or disclosure state through result refresh. These are verification gaps, not evidence that those behaviors are broken.

Independently executed in this review: the nine specified focused suites passed, **50 tests total**; `pnpm typecheck` passed; `git diff --check` passed. React act-environment warnings were printed by transcript tests. Native-module wrapper restoration reported success. Direct Tailwind compilation and tailwind-merge probes reproduced R1 and R2. The initial CSS probe could not resolve postcss from the workspace root; rerunning with the installed Tailwind plugin's own resolved postcss succeeded without dependency/configuration changes.

No full test suite or production build was run in this review. Prior full-suite failures and the reported build startup stall were not independently reproduced or attributed. Interactive Electron checks were unavailable with the supplied tools: narrow widths, light/dark appearance, keyboard/focus and screen-reader behavior, scrolling/conversation switching, actual reduced-motion appearance and end-to-end approval interactions remain unverified.

## Disposition

The migration substantially follows phases A–E and preserves the important data/resource boundaries in the inspected paths. Correct R1 and R2 and add regression coverage for generated running styles and consumer font sizing before calling the implementation complete. Phase E is interpreted as retaining the independently mergeable payload seam; implementing PR114 itself is outside this review's scope.
