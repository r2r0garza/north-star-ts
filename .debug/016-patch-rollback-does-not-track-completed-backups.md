# Patch rollback does not track completed backups

> Status: **RESOLVED**
> Severity: **P3 — rollback state and reporting are inaccurate**
> Area: multi-file patch transaction rollback

## Problem

For every existing source, `commitPatch` assigns an intended backup path before
the backup phase begins. Rollback later treats the presence of that path on the
entry as proof that the source-to-backup rename completed.

If a backup rename fails, the failing entry and every later entry still have a
backup path recorded even though no backup exists there. The rollback loop then
tries to rename those nonexistent paths back over their sources. Those expected
`ENOENT` failures are collected as rollback errors, so the tool can return
`rollback_failed` even when the affected sources never moved and require no
restoration.

The transaction already tracks completed destination installation with
`installed`; it needs an equivalent completion flag for backup creation.

## Impact

- A recoverable commit failure can be escalated to `rollback_failed` incorrectly.
- Users and agents may believe workspace recovery was incomplete when untouched
  sources are still safe.
- Genuine rollback failures are mixed with attempts to restore backups that
  never existed, reducing diagnostic value.
- Failure behavior depends on which entry's backup rename fails.

## Reproduction test

Add deterministic rename failure injection to the fake environment:

1. Plan a patch updating at least three existing files.
2. Fail the first source-to-backup rename and assert no nonexistent backup is
   restored and the result is `commit_failed`, not `rollback_failed`.
3. Fail a middle backup rename after one earlier backup succeeds.
4. Assert only the successfully created earlier backup is restored.
5. Assert the failing and later untouched sources are not renamed during
   rollback.
6. Verify all staged temporary files are removed and every original file retains
   its content and mode.

Include a separate injected failure while restoring a backup to prove that a
genuine restore failure still returns `rollback_failed`.

## Fix direction

- Add explicit state such as `backedUp: boolean` to each staged transaction
  entry.
- Set it only after the source-to-backup rename succeeds.
- During rollback, restore a backup only when that completion state is true.
- Clear or update the state after a successful restoration if doing so improves
  failure reporting.
- Keep destination ownership tracking through `installed` independent from
  backup tracking.

## Acceptance criteria

- Failure before the first completed backup returns `commit_failed` without
  attempting nonexistent restores.
- Failure in the middle of the backup phase restores only completed backups.
- Untouched sources are never renamed during rollback.
- A real failure restoring a completed backup returns `rollback_failed` with an
  actionable error.
- Staged temporary files are cleaned in every failure case.
- Original content, paths, and permission modes are preserved whenever rollback
  succeeds.

## Resolution

The root cause was that assigning `backup` recorded rollback intent, not proof
that the source-to-backup rename had completed. Rollback therefore attempted to
restore every planned backup after any backup-phase failure.

The production fix was already present in commit `1c46fd4` as part of the patch
staging cleanup work: each staged entry starts with `backedUp: false`, changes it
to `true` only after a successful backup rename, and restores only entries whose
backup completed. The `installed` flag remains independent.

Regression coverage now injects deterministic rename failures and verifies:

- failure on the first backup returns `commit_failed` without restore attempts;
- failure on a middle backup restores only the earlier completed backup;
- untouched sources retain their content and permission modes;
- staged temporary files are removed after successful rollback; and
- a genuine completed-backup restore failure still returns `rollback_failed`
  while retaining the original backup for recovery.
