# Dashboard refresh accepts stdout from failed shell commands

> Status: **RESOLVED**  
> Severity: **P2 — failed refresh presented as fresh data**  
> Area: deterministic dashboard refresh

## Problem

After `env.exec`, dashboard refresh reads stdout without checking spawn failure,
abort, timeout, signal, nonzero exit, or output truncation. If the retained stdout
parses as JSON, the widget is marked `ok` even though execution failed or only a
prefix was captured.

## Reproduction test

Return valid JSON alongside each failure state, including nonzero exit and timeout
after output. Assert the widget becomes error/stale and its previous successful
cache is not replaced.

## Fix direction

Centralize process-result validation and require a clean, untruncated zero exit
before parsing rows. Surface stderr/status in a bounded error without storing
partial stdout as current data.

## Acceptance criteria

- Only a clean complete command result can mark a widget `ok`.
- Failure preserves prior data while recording refresh status/error separately.
- Container and Local results follow identical rules.

## Resolution

- Added centralized shell result validation in `DashboardService` before JSON parsing.
- Rejects spawn failure, abort, timeout, signal exit, nonzero exit, and truncated output.
- Records a bounded status/error via the existing cache upsert path without passing partial stdout as fresh data.
- Added table coverage for valid JSON stdout paired with each failure state, asserting prior cache data is preserved.

## Verification

- `npm test -- src/main/dashboards/service.test.ts` (skipped by existing `better-sqlite3` load guard in this environment)
- `npm run typecheck`
