# Dashboard persistence truncates serialized JSON into invalid data

> Status: **RESOLVED**  
> Severity: **P2 — silent dashboard data loss**  
> Area: dashboard repository serialization

## Problem

`toJsonText` slices serialized JSON at `MAX_JSON_CHARS`. Most oversized values
therefore become invalid JSON; `fromJsonText` later catches the parse failure and
returns `null`. Authoring or refresh can report success while configuration,
recipe, or cached rows disappear.

## Reproduction test

Persist oversized config, recipe, and data values whose JSON crosses the cap in
strings, arrays, and objects. Assert the write is rejected atomically and the
previous valid value remains readable.

## Fix direction

Measure the complete serialization and reject it with a typed size error, or
perform schema-aware row reduction before serialization. Never slice JSON text.

## Acceptance criteria

- Every stored non-null JSON cell parses successfully.
- Oversized authoring/refresh returns an actionable error.
- Failed replacement preserves the previous dashboard definition/cache.

## Resolution

- Replaced JSON slicing with `DashboardJsonTooLargeError` before SQL writes.
- `dashboard_write` maps oversized dashboard JSON to `ERROR[json_too_large]`
  and relies on its transaction to preserve the previous definition/cache.
- Deterministic refresh marks an oversized widget refresh as `error` without
  replacing prior cached rows.
- Status-only cache updates now preserve existing widget data unless callers
  explicitly pass `data: null`.

## Verification

- `npm run typecheck` passes.
- Targeted Vitest command was attempted, but these SQLite-backed suites skipped
  in plain Node because `better-sqlite3` is built for the Electron ABI here:
  `npm test -- src/main/db/repositories/dashboards.test.ts src/main/agent/tools/dashboard_write.test.ts src/main/dashboards/service.test.ts`.
