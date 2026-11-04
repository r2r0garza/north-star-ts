# PR131 Phase D — manual generation comparison

Evidence received 2026-10-30. Thirty user-run trials: five cases × three repetitions × two flag settings. Provider/model label exactly as supplied: **OpenAI Sub/gpt-6 luna**. Exact backend model revision, generation settings, timestamps and request ids were not supplied. These are user-reported render observations and copied terminal summaries, not independently replayed provider traces. Initial exploratory failures and the subsequent contract changes occurred before this batch and are excluded from these counts.

## Method and provenance

Cases follow the paired prompts supplied in this conversation: mixed monthly completion analytics; team comparison; missing/zero/empty response-time data; optional concise metrics; prose-only control. Flag 0 prompts name existing chart/table tools where relevant; flag 1 prompts name present_visual. This compares instructed paths, not blind model preference or identical-output equivalence. The composition arm requests additional metrics/cards/tabs, so output size is not a like-for-like language-efficiency benchmark. User was instructed to restart after flag changes, use fresh conversations and keep provider/model fixed; compliance was not independently inspected. No code or prompt changes were made during analysis of this batch.

The three Flag 0 entries under the Prose heading repeat Case: missing-empty. They are classified here as **prose**, based on heading, two-sentence response content and one-round logs. User's N/A error fields are interpreted as no reported error, not proof of complete validation traces. Normalized per-run rounded data is recorded below. Successful raw generated payloads were not supplied; failed payloads and agent response excerpts remain in the conversation evidence.

## Results

| Case | Flag | Runs | Rounds per run | Runs with reported correction | Reported render outcome |
| --- | --- | --- | --- | --- | --- |
| Mixed | 0 | 3 | 2, 3, 3 | 0 | 3/3 yes |
| Mixed | 1 | 3 | 2, 2, 2 | 0 | 3/3 yes |
| Comparison | 0 | 3 | 4, 4, 4 | 3 | 3/3 yes after correction |
| Comparison | 1 | 3 | 3, 2, 2 | 1 | 3/3 yes after any correction |
| Missing/empty | 0 | 3 | 5, 3, 2 | 0 | 3/3 yes |
| Missing/empty | 1 | 3 | 3, 2, 2 | 1 | 3/3 yes after any correction |
| Metrics | 0 | 3 | 1, 2, 2 | 0 | Prose twice; charts reported once |
| Metrics | 1 | 3 | 1, 1, 1 | 0 | Prose all three |
| Prose | 0 | 3 | 1, 1, 1 | 0 | Prose all three |
| Prose | 1 | 3 | 1, 1, 1 | 0 | Prose all three |

Across the nine requested analytical-visual trials per flag, final rendering was reported successful 9/9 for both. No correction was reported in 6/9 Flag 0 trials and 7/9 Flag 1 trials. All five reported failures self-corrected. This is too small a sample to claim a robust reliability advantage. No new document-syntax or percent-unit failures were reported in this batch after the earlier description changes.

The shared data-contract errors persist: Flag 0 comparison failed 3/3 times because completed/total columns used valueType `integer`; Flag 1 comparison failed 1/3 for the same reason. Correct contract is valueType `number` plus numberFormat `integer`. Flag 1 missing/empty failed 1/3 because `Response time` was used as a data key containing a space; display wording belongs in label, with a safe key such as `responseTime`. These were existing chart/table constraints, not evidence of an OpenUI parser fault. Do not silently coerce unsupported types or keys. Clarifying these shared schemas/descriptions is follow-up work; keep this measured batch frozen.

## Rounded terminal usage

Values below sum the displayed k-token figures across all rounds in each three-run group. `0.0k` is a rounded observation, not zero tokens. Each reported input round includes replayed context; totals are not unique prompt tokens, cache-adjusted billed tokens, money or latency. Reasoning delta/item counters are not reasoning-token counts.

| Case | Flag | Input k per run | Output k per run | Group input k | Group output k |
| --- | --- | --- | --- | --- | --- |
| Mixed | 0 | 19.4, 29.3, 29.7 | 0.3, 0.4, 0.5 | 78.4 | 1.2 |
| Mixed | 1 | 21.6, 21.6, 21.6 | 0.5, 0.4, 0.4 | 64.8 | 1.3 |
| Comparison | 0 | 39.3, 39.3, 39.3 | 0.6, 0.6, 0.6 | 117.9 | 1.8 |
| Comparison | 1 | 33.3, 21.7, 21.6 | 1.1, 0.6, 0.5 | 76.6 | 2.2 |
| Missing/empty | 0 | 50.0, 29.5, 19.6 | 0.6, 0.5, 0.4 | 99.1 | 1.5 |
| Missing/empty | 1 | 33.0, 21.5, 21.6 | 0.9, 0.5, 0.6 | 76.1 | 2.0 |
| Metrics | 0 | 9.5, 19.2, 19.2 | 0.1, 0.1, 0.1 | 47.9 | 0.3 |
| Metrics | 1 | 10.5, 10.5, 10.5 | 0.1, 0.1, 0.1 | 31.5 | 0.3 |
| Prose | 0 | 9.4, 9.4, 9.4 | 0.0, 0.0, 0.0 | 28.2 | 0.0 |
| Prose | 1 | 10.5, 10.5, 10.5 | 0.0, 0.0, 0.0 | 31.5 | 0.0 |

Total model request rounds: 38 flag off, 26 flag on (about 32% fewer in this batch). Summed displayed input: 371.5k versus 280.5k (about 24% lower). Summed displayed output: 4.8k versus 5.8k (about 21% higher). These aggregate differences mix rendering paths, retries and optional tool choices; they do not establish intrinsic language token savings.

Initial round input grows by approximately 1.0–1.1k with the flag enabled (e.g. prose 9.4k → 10.5k). That is the observed added request-context overhead, not an isolated exact tool-description token measurement. The prose control pays this overhead without fewer rounds. Composition can offset it when it replaces multiple presentation requests, as seen here, but no general cost claim follows without cache/billing and latency evidence.

No elapsed times, first-usable-visual times or precise token receipts were supplied. No latency or monetary savings are claimed. Visual observations were N/A throughout; final render success was user reported, not a side-by-side usability score or artifact data audit. Both arms had correct prose metric values (75%, 66.7%); flag on kept the optional metrics case in prose 3/3, and both arms respected the explicit prose control 3/3.

## Decision

**Conditional go for retaining and refining the opt-in composed analytical path; no default rollout and no wholesale OpenUI React runtime adoption.** Phase B established visually useful composition and the user accepted the direction. Phase C established durable/restricted replay. This small Phase D batch shows successful final rendering in both arms, fewer request rounds for the composition arm and no observed regression toward unnecessary visuals. It does not demonstrate lower output tokens, lower latency, maintenance savings or reliable performance across models.

Retain the frozen static admission/library identity, present_visual, host component adapter and durable tests/checks for continued opt-in evaluation. Keep present_chart/present_table for concise semantic contracts and present_ui for concepts/design choices. Nothing in those existing implementations can yet be deleted on this evidence. Phase B react-lang/devtools fixture dependencies are evaluation-only; a proposed production adoption should remove or isolate that fixture/dependency surface, not ship the general runtime. No replacement of present_ui or mini-app framework is justified.

Before considering default offering: clarify safe keys and number-vs-integer formatting in shared model-facing data contracts; collect complete successful payloads and audit data fidelity; repeat with at least another approved provider/model; capture precise usage/cache and first-render/completion timings; review bundle/adapter costs and existing broad-suite failures. Re-test contract refinements as a separate labeled batch. Packaged and cross-platform qualification remain outstanding. The spike yields a bounded positive product signal with explicit costs, not blanket adoption approval.

## Post-batch pre-commit clarification

After freezing the results above, shared present_chart/present_table schema fields now document safe identifier keys (with the matching existing-validator pattern), integer counts as valueType number plus numberFormat integer, and percent units as omitted or `%`. present_visual inherits those nested schemas, with a regression test asserting that inheritance. No runtime coercion, library identity change or database migration. Seven focused files / 40 tests, typecheck, production build, roadmap verification and whitespace checks passed. This is a new description/schema-guidance revision; the 30-run batch above predates it and does not establish its effect on generation reliability. The full suite was not rerun for this description-only follow-up; the three failures recorded in Phase C remain unresolved.
