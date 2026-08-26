# Patch rollback can leave an installed destination while claiming recovery

> Status: **Fixed**  
> Severity: **P1 — false rollback and partial mutation**  
> Area: multi-file patch rollback

## Problem

When rollback handles an add or move destination installed by the transaction,
failure from `removeFile(target)` is swallowed. The transaction can return
`commit_failed`—rendered as “all staged changes were rolled back”—while the new
destination remains in the workspace.

## Reproduction test

Install an added destination, fail a later commit step, then inject failure while
removing the installed destination. Cover moves as well as adds and verify the
source restoration independently.

## Fix direction

Record destination-removal failure in the rollback error collection and return
`rollback_failed` with the unresolved path. Never describe recovery as complete
unless every transaction-owned installation is gone or restored.

## Acceptance criteria

- Failed destination removal produces `rollback_failed`.
- The result identifies every path requiring manual recovery.
- Successful rollback still reports `commit_failed` and restores the full tree.

## Resolution

Rollback now records failed removal of transaction-installed add and move
destinations as `rollback_failed` errors, including the unresolved patch path
that still requires manual recovery.

Regression coverage injects removal failures for both add and move destinations
after a later commit step fails. The tests verify that successfully restorable
sources are restored, unresolved installed destinations remain reported, and
ordinary successful rollback continues to return `commit_failed`.
