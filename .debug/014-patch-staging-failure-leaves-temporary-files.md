# Patch staging failure leaves temporary files

> Status: **FIXED**  
> Severity: **P2 — failed mutation leaks workspace artifacts**  
> Area: multi-file patch staging and cleanup

## Problem

`commitPatch` creates a `StagedFile` entry and assigns its temporary path, but
does not add the entry to the transaction's `staged` collection until after
`writeFile` and the optional `chmod` both succeed.

If `writeFile` creates or partially writes the temporary file before rejecting,
or if `chmod` fails after a successful write, control reaches the transaction's
catch block without the entry being present in `staged`. Cleanup therefore does
not know about the `.north-star-*.tmp` path and leaves it in the workspace.

This means bug 012's transaction-wide stale validation is effective, but its
acceptance requirement that temporary files be removed after every failure is
not yet satisfied.

## Impact

- Failed patch attempts can leave hidden temporary files in user directories.
- Temporary files can contain the complete proposed replacement content,
  including sensitive material.
- Repeated failures can accumulate stale artifacts and confuse later tooling or
  workspace inspection.
- Local and container backends can behave differently depending on when their
  write or chmod operation reports failure.

## Reproduction test

Extend the deterministic fake environment with failure injection around staging:

1. Plan an update of an existing file whose replacement is staged.
2. Make `writeFile` persist some or all of the temporary content and then throw.
3. Assert the patch reports `commit_failed` and no `.north-star-*.tmp` path
   remains.
4. Repeat with a successful `writeFile` followed by a failing `chmod` for a file
   whose original mode is captured.
5. Include a multi-file case where an earlier entry staged successfully before
   a later entry fails.
6. Assert original source content, modes, and destinations remain unchanged in
   every case.

Where practical, exercise equivalent behavior through the local and container
environment implementations.

## Fix direction

- Register each staging entry before invoking any operation that may create or
  modify its temporary path.
- Ensure cleanup can safely remove an entry whose temporary file was never
  created as well as one that was partially created.
- Keep backup state separate from staging state so early registration does not
  make rollback assume that a backup rename occurred.
- Preserve the original commit error unless cleanup itself fails in a way that
  requires an explicit rollback/cleanup failure result.

## Acceptance criteria

- A write that creates content and then rejects leaves no temporary file.
- A chmod failure after a successful staged write leaves no temporary file.
- Failure on a later entry cleans temporary files from all earlier entries.
- Original sources, destinations, content, and permission modes remain intact.
- Successful patches retain their existing atomic install behavior.
- Regression tests cover fake, local, and container backends where the failure
  can be injected deterministically.

## Resolution

- `commitPatch` now registers each transaction entry before `mkdirp`, staged
  write, or staged `chmod` can fail, so cleanup always knows the intended temp
  path once one has been allocated.
- Backup-path allocation is now independent from backup completion through an
  explicit `backedUp` flag. A staging failure therefore cannot make rollback
  attempt to restore a backup that was never created.
- Fake-environment regressions cover a write that persists then rejects, a
  staged `chmod` failure, and a later-file staging failure after an earlier file
  was staged successfully. They verify original content and modes are retained
  and all transaction temp files are removed.
- Real local-backend regressions cover both injected failure points. The
  container integration suite covers the write-after-persist case when Docker
  or Podman is available.

## Verification

- `npm test -- src/main/agent/tools/apply_patch_tool.test.ts src/main/agent/env/local.test.ts src/main/agent/env/container.test.ts`
  — 61 passed, 30 container tests skipped because no usable runtime/image was
  available.
- `npm run typecheck` — passed.
- `npm test` — patch-related tests passed; the overall run reported 607 passed,
  364 skipped, and two unrelated `cli-sessions` failures because the installed
  `better-sqlite3` binary was built for Node ABI 136 while the test runner
  requires ABI 137.
