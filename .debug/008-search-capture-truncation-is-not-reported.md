# Search capture truncation is not reported

> Status: **CLOSED**  
> Severity: **P2 — incomplete result presented as complete**  
> Area: ripgrep execution and structured search results

## Problem

Local and container ripgrep execution capture at most 16 MiB. `captureSpawn`
silently discards bytes beyond that cap and does not expose whether capture was
truncated. `parseRipgrepJson` then ignores malformed or partial JSON lines and
sets `SearchResult.capped` only when the parsed result count reaches
`maxResults`.

A search containing fewer than `maxResults` very large matching/context lines
can therefore exceed the byte cap, lose later results, and still return
`capped:false`.

## Impact

- The model can treat a partial workspace search as exhaustive.
- Missing results have no recovery hint because the response does not advertise
  truncation.
- A partial final JSON event is silently discarded, hiding the capture boundary.

## Reproduction test

Add a test seam for a small search capture limit, then:

1. Search a fixture with multiple matching lines whose JSON events exceed that
   limit before `maxResults` is reached.
2. Assert the result is explicitly capped/truncated.
3. Assert a recovery hint recommends narrowing path, query, or globs.
4. Cover a capture boundary inside a JSON event.
5. Repeat the contract for Local and container ripgrep execution.

## Fix direction

- Extend `ExecResult` with byte-cap metadata such as `outputTruncated` and the
  number of retained/observed bytes.
- Propagate capture truncation into `SearchResult.capped` or a more precise
  `captureTruncated` field.
- Do not treat an incomplete JSON event as a clean end of results.
- Prefer stopping ripgrep once enough structured results are obtained so the
  process does not continue producing discarded output.
- Preserve the distinction between result-count caps, byte caps, timeout, and
  cancellation in tool metadata.

## Acceptance criteria

- Any discarded ripgrep output is visible in the returned metadata.
- A truncated search can never report itself as complete.
- The model receives an actionable narrowing/retry hint.
- Complete searches retain their current result shape and `capped:false`.
- Fixed, regex, content, files, count, and context modes are covered.

## Resolution

- `captureSpawn` now reports `outputTruncated`, retained bytes, and observed
  bytes whenever the shared output cap discards stdout/stderr.
- Local and container ripgrep search pass capture metadata into JSON parsing.
- Ripgrep search results mark byte-cap truncation as `capped:true` with
  `capReason:"captureBytes"` and expose capture metadata without adding those
  fields to complete searches.
- Partial/malformed JSON events at the capture boundary are counted in metadata.
- `search_tool` renders an explicit incomplete-results note and narrowing hint.

Verification:

- `pnpm vitest run src/main/agent/env/spawn-util.test.ts src/main/agent/env/ripgrep.test.ts src/main/agent/env/local.test.ts src/main/agent/tools/search_tool.test.ts`
- `pnpm typecheck`

Full-suite note:

- `pnpm test` still fails outside this change because `better-sqlite3` was built
  for a different Node module version and container integration startup cannot
  pull/connect to the configured runtime image in this environment.
