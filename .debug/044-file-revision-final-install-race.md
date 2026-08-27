# Revision-checked mutations can overwrite a write after final validation

> Status: **Fixed**
> Severity: **P1 — stale overwrite and rollback data loss**
> Area: single-file and multi-file mutation commits

## Problem

Existing-file writes compare the current revision and mode, then replace the
target with an unconditional rename. Another actor can modify the destination
between the final check and rename, and the staged content silently overwrites
that newer version.

Multi-file patching has the same gap between final validation, backup moves, and
staged installation. During rollback, restoring a backup can overwrite an
external write that arrived after the transaction began.

Debug 017 closed create-only replacement through no-replace installation. This
brief covers existing destinations and the larger transaction boundary.

## Reproduction test

For single-file mutation, pause after the final revision check, replace the
target externally, resume, and assert the external bytes survive. For patching,
inject concurrent changes after validation, after backup, and before rollback.
Verify the operation reports a conflict without overwriting any external data.

## Fix direction

Define the actual concurrency contract. If revisions promise compare-and-swap,
use per-workspace serialization plus a cross-process lock or versioned install
primitive that binds validation to commit. Rollback must detect a destination
that no longer belongs to the transaction before restoring or removing it.

If atomic cross-process CAS cannot be provided on a backend, narrow the public
guarantee and fail closed when contention is detected.

## Acceptance criteria

- No write after the final validated revision is silently overwritten.
- Multi-file commit and rollback distinguish transaction-owned paths from
  external replacements.
- Conflict results identify the affected path and preserve external bytes.
- Create-only, mode-preservation, cleanup, and rollback tests remain green.

## Resolution

- Existing-file single writes now move the current target to a temporary backup,
  validate the backed-up bytes and mode, and install the staged content with the
  no-replace primitive.
- Multi-file patch commits now install all staged content with no-replace after
  backup, validate backed-up sources before install, and refuse to restore or
  remove rollback paths whose current bytes no longer belong to the transaction.
- Regression tests cover existing-file races before backup and after backup,
  patch install contention after backup, and rollback conflict preservation.

## Verification

- `npm test -- --run src/main/agent/tools/write_file_tool.test.ts src/main/agent/tools/apply_patch_tool.test.ts`
- `npm run typecheck`
