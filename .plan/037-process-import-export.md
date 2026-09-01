# PR37: Process import / export — share a Process definition as JSON

> Status: **COMPLETED in this branch**. Adds local JSON export/import for reusable Process
> definitions. A Process lives only in SQLite, so sharing requires explicit serialization and
> deserialization rather than the file-copy import flow used by skills (`035`) and agents (`036`).

## Implemented

Process definitions can now be exported from the Process browser and imported back as new definitions.
The interchange document is `ProcessExport` with `formatVersion: 1`, `exportedAt`, `definition`,
`phases`, and `edges`.

The exported file is definition-only. It includes phases, routing, gate policy, fan-out, rework and
validator settings, dot-folder behavior, positions, phase agent pools, and dependency edges. It does
not include process run history.

## Format decisions

- **Id-free graph.** Raw SQLite row ids are omitted. Phases carry their unique per-process `key`; edges
  reference `fromKey` and `toKey`.
- **Portable agent descriptors.** Source-qualified `agentref:v1` values are exported as
  `{ sourceKind, nativeName, scope? }`. Absolute local `definitionPath` values are not written to the
  JSON. Legacy unqualified agent names are retained as `{ legacyName }` with an import warning.
- **Sub-process references.** A phase's `subprocess_id` exports as `{ name }`. Import resolves that name
  to exactly one existing definition, excluding the newly-created imported definition itself. Missing or
  ambiguous sub-processes import with a warning and leave the phase as an ordinary agent phase.
- **Definition-name collisions.** Duplicate Process definition names are allowed, matching the existing
  table behavior.
- **Unknown format versions.** Imports reject unsupported `formatVersion` values with a clear error.

## Implementation

- Added [io.ts](/Users/r2r0garza/Documents/01-Projects/north_star_ts/src/main/process/io.ts) with
  `buildProcessExport`, `exportProcessDefinition`, and `importProcessExport`.
- Import validates the full JSON shape before writing: required objects/arrays, unique phase keys,
  edge endpoint resolution, enum values, non-negative integer fields, booleans, and nullable override
  arrays.
- Import replays through the existing Process CRUD in one SQLite transaction:
  `createProcessDefinition` -> `createPhase` -> `createPhaseAgent` -> `createEdge`.
- Added main-process native save/open dialog IPC in
  [process-handlers.ts](/Users/r2r0garza/Documents/01-Projects/north_star_ts/src/main/ipc/process-handlers.ts).
- Exposed typed preload methods:
  `window.cowork.process.exportDefinition(processId)` and
  `window.cowork.process.importDefinition()`.
- Added Process browser UI affordances in
  [process-screen.tsx](/Users/r2r0garza/Documents/01-Projects/north_star_ts/src/renderer/src/components/process-screen.tsx):
  an Import button beside New Process and a per-card Export icon.
- Added focused tests in
  [io.test.ts](/Users/r2r0garza/Documents/01-Projects/north_star_ts/src/main/process/io.test.ts).

## Verification

- `pnpm typecheck` passes.
- `pnpm build` passes.
- `pnpm vitest run src/main/process/io.test.ts` discovers the focused tests, but they skip under the
  current plain Node runner because SQLite-backed tests depend on the local `better-sqlite3` native
  module loading successfully.
- `pnpm test:sqlite` is currently blocked in this checkout before assertions run:
  `better-sqlite3` was compiled for `NODE_MODULE_VERSION 136`, while this Node requires
  `NODE_MODULE_VERSION 137`.

## Out of scope

- Exporting `process_runs` or `process_phase_runs` execution history.
- Remote sharing, marketplace publishing, gist links, or bundle URLs.
- Bundling agent or skill file contents inside the Process export.
- Importing agent or skill definitions themselves.
