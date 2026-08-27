# Green test runs skip the database-backed integration surface

> Status: **OPEN**
> Severity: **P2 — verification integrity gap**
> Area: native-module test infrastructure and CI

## Problem

The project rebuilds `better-sqlite3` for Electron, while Node-based Vitest needs
a different native ABI. Repository and integration suites use `sqliteLoads` to
skip when that binary cannot load. The full local run is non-red but currently
reports hundreds of skipped tests, including database, migration, dashboard,
process, provider, and repository behavior. There is no workflow under
`.github/workflows` that guarantees those assertions execute elsewhere.

Debug 040 correctly distinguished ABI unavailability from assertion failure,
but keeping the suite non-red is not equivalent to verifying the behavior.

## Reproduction test

Run the documented full suite after the Electron rebuild and record which test
files and assertions execute. Add a CI sentinel that fails if the Node-ABI job
cannot load SQLite or if an unexpected suite uses the ABI skip path.

## Fix direction

Create separate required jobs for Node/Vitest database coverage and packaged or
Electron smoke coverage. Build the native dependency for the active runtime in
each isolated job or cache. Keep conditional local skips if useful, but make the
required database job fail closed and report executed/skipped counts.

## Acceptance criteria

- Every SQLite-backed assertion executes in at least one required CI job.
- The database job fails when `better-sqlite3` cannot load.
- Electron packaging/runtime compatibility is verified separately.
- Unexpected skip-count growth is visible and fails the appropriate job.
- The documented local workflow explains ABI rebuild transitions.
