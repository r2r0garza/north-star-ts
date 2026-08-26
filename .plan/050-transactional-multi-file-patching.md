# PR50: Transactional multi-file patching

> Status: **IMPLEMENTED**. Depends on `047` revisions/diff previews and benefits
> from `049` effect metadata. No DB migration. The shipped slice validates the
> complete structured patch before mutation, gates one combined diff, stages
> writes/backups, and rolls back commit failures. Durable crash-recovery manifests
> remain a follow-up hardening gap.

## Context

The current edit tool replaces one exact string in one file. It is excellent for
small surgical changes but inefficient for coordinated refactors, file moves,
or several hunks. Repeated calls expose partial intermediate states and can leave
half a logical change applied if a later call fails or the turn stops.

Codex's native patch model demonstrates the useful contract: one patch can add,
update, move, and delete files, and every hunk must match expected context.

## Goal

Add a provider-neutral `apply_patch_tool` that validates an entire bounded patch
against current workspace state, presents one combined diff/approval, and commits
all file operations atomically from the agent's perspective—or changes nothing.

## Contract

- Accept a structured operation list rather than executing arbitrary patch text:
  `add`, `update`, `move`, and `delete`.
- Updates contain ordered exact-context hunks with optional revisions from `047`.
- Paths are workspace-relative and independently resolved through
  `resolveInWorkspaceReal`; moves validate both source and destination.
- Enforce caps on operations, files, hunks, input bytes, and resulting bytes.
- Reject duplicate/conflicting targets, overlapping hunks, ambiguous matches,
  path escapes, binary files, and case-fold collisions before writing anything.
- Return one combined diff summary plus per-file status/revision.

## Transaction strategy

1. Resolve and read every source; capture bytes, revisions, and modes.
2. Apply all operations in memory and validate the complete final path set.
3. Re-read/revalidate revisions immediately before commit.
4. Write an app-owned transaction manifest before mutation, recording operations,
   revisions, staging paths, and commit progress without file contents.
5. Stage every new file and every original backup as random siblings of its
   target so rename stays on the same filesystem; rename staged files into place
   only after all staging succeeds.
6. On any failure/abort, restore every original and remove all staged artifacts.
   On app startup, reconcile any incomplete manifest before allowing new patches.

Because cross-file filesystem operations cannot be truly atomic on every
platform, the guarantee is a tested rollback transaction. The tool must report a
distinct `rollback_failed` critical error if restoration itself fails and retain
recovery artifacts with their exact location for the user.

## Approval and activity

- Classify the patch as one file-mutation action with affected paths and bounded
  combined diff; delete/move operations are marked destructive.
- One approval covers the exact captured revisions. Any revision change after
  approval invalidates it and returns `stale_file` rather than silently rebasing.
- Emit per-file activity only after validation; final result clearly distinguishes
  validated, committed, rolled back, and failed states.

## Implementation areas

- New `tools/file/patch-*` parser/validator/transaction helpers.
- New registered `apply_patch_tool` and effect metadata.
- Environment extensions for unlink/mode/rollback operations with Local and
  container parity.
- Approval/activity diff rendering reused from `047`.

## Verification

- Successful multi-hunk update and mixed add/update/move/delete transaction.
- Any invalid hunk/path/revision leaves all files byte-identical.
- Inject failures at each commit step and prove rollback or explicit retained
  recovery artifacts.
- Simulate process loss at each recorded manifest step and prove startup recovery
  converges to the complete old or complete new state, never an undocumented mix.
- Stop during validation/staging/commit settles safely.
- Symlink, case-insensitive filesystem, Windows rename, file mode, newline style,
  no-final-newline, and Unicode fixtures.
- Patch/result size caps and deterministic per-file ordering.

## Out of scope

- Semantic AST refactoring or automatic merge resolution.
- Binary patches.
- Git commits/reverts; the filesystem transaction is independent of git.
