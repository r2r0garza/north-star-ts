# Local realpath validation is not bound to the subsequent filesystem operation

> Status: **FIXED**  
> Severity: **P1 — raceable workspace escape**  
> Area: LocalEnvironment path confinement

## Problem

`resolveInWorkspaceReal` validates the real target but returns the lexical path.
File tools later reopen that path. A writable parent component can be exchanged
for an external symlink after validation and before read, staging, rename, or
removal, redirecting the operation outside the workspace.

## Reproduction test

Add deterministic barriers between resolution and each filesystem primitive,
swap a validated parent directory for an external symlink, and verify reads and
mutations fail without touching the external sentinel.

## Fix direction

Bind validation to use: operate through verified real parents/file descriptors,
or add backend primitives using no-follow and directory-relative operations.
Post-checks alone do not prevent writes that already escaped.

## Acceptance criteria

- Parent and final-component symlink swaps cannot redirect any Local file tool.
- Create, edit, patch, read, search, and listing paths are covered.
- Unsupported platforms fail closed rather than weakening confinement.

## Resolution

- Local file operations now run through no-follow, directory-relative POSIX
  primitives so validation is bound to the filesystem operation.
- Local search opens the requested root safely and runs ripgrep after `fchdir`
  into the verified directory.
- Regression tests cover parent symlink swaps for read, write, list, and search.
