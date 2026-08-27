# CLI-session repository tests fail under the Electron native-module ABI

> Status: **OPEN**
> Severity: **P3 — full-suite test infrastructure failure**
> Area: SQLite repository tests

## Problem

`cli-sessions.test.ts` imports `better-sqlite3` without the availability guard
used by other repository suites. After postinstall rebuilds the module for
Electron, Node-based Vitest requires a different ABI and these two tests fail at
setup, making the full suite red despite no product assertion running.

## Reproduction test

Run postinstall/Electron rebuild, then `pnpm test` under the project Node version.
Verify the CLI-session suite follows the same explicit native-module policy as
the other DB suites.

## Fix direction

Choose one consistent test runtime strategy: run DB tests under a compatible ABI,
maintain separate native builds, or apply the shared `sqliteLoads` guard with a
clearly reported skip. Do not hide genuine migration/repository failures.

## Acceptance criteria

- A normal documented setup produces a non-red full suite.
- Both CLI-session behaviors still execute in at least one required CI job.
- ABI unavailability is distinguished from assertion failure.
