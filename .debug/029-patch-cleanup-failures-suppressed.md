# Patch cleanup failures are silently suppressed

> Status: **FIXED**  
> Severity: **P2 — leaked sensitive artifacts and false success**  
> Area: patch staging, success cleanup, and stale paths

## Problem

Patch commit suppresses failures while deleting staged files and backups on
success, stale rejection, and failure. A successful patch may retain the complete
original under a hidden backup; a rejected patch may retain proposed content.
The caller receives no path or recovery instruction.

## Reproduction test

Inject remove failures for a hard-linked staged add, an original-file backup, and
a stale/failing staged replacement. Verify the result reports every retained path
and does not mislabel cleanup as complete.

## Fix direction

Ignore only a confirmed not-found cleanup result. Represent committed-with-
cleanup-failure separately from rollback failure and return actionable recovery
paths. Preserve the primary failure while attaching cleanup errors.

## Acceptance criteria

- Unexpected cleanup failures are always surfaced.
- Successful content installation is not incorrectly described as rolled back.
- Tests verify no hidden backup or staging artifact remains on normal paths.

## Resolution

`commitPatch` now records cleanup failures for staged files and backups across
stale rejection, successful commit, and rollback paths. It ignores only confirmed
not-found cleanup results. Successful content installation with retained cleanup
artifacts returns a distinct `cleanup_failed` result, while stale, commit, and
rollback failures keep their primary error code and attach retained cleanup paths.

Regression coverage injects cleanup failures for applied add staging artifacts,
applied update backups, stale staged replacements, and commit failures with
retained staged files. The fake patch environment now reports `ENOENT` for
missing cleanup paths so normal rename-owned staged paths stay ignored.

## Verification

- `pnpm exec vitest run src/main/agent/tools/apply_patch_tool.test.ts`
- `pnpm exec vitest run src/main/agent/tools/apply_patch_tool.test.ts src/main/agent/tools/file_mode_mutation.test.ts src/main/agent/env/local.test.ts`
- `pnpm exec tsc --noEmit`
