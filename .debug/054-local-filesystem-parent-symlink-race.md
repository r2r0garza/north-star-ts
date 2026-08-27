# Local filesystem operations can follow a parent symlink swapped after validation

> Status: **PARTIAL**
> Severity: **P1 — workspace confinement bypass**
> Area: local filesystem backend

## Problem

The Node-based local filesystem helper validates each path component with
`lstat`, then performs the requested operation through an absolute path.
`O_NOFOLLOW` protects only the final component passed to `open`; it does not stop
the kernel from following a parent directory that is replaced with a symlink
between validation and use.

A concurrent process can swap a validated workspace directory for a symlink
before `open`, `chmod`, `rename`, `link`, `unlink`, or directory creation. The
operation may then read or modify a path outside the workspace. Existing tests
swap the parent before the operation starts, so they do not exercise this final
component-validation/syscall race.

This regresses the directory-relative no-follow guarantee previously provided
by the safe filesystem helper while removing the system-Python dependency in
debug 048.

## Reproduction test

Add a controllable filesystem seam or native test helper that pauses after the
parent component is validated but before the final syscall. Replace that parent
with a symlink to an external directory, resume, and assert the operation fails
without reading, writing, renaming, linking, chmodding, or deleting the external
target. Cover every mutating primitive plus file read and directory listing.

## Fix direction

Bind validation to use through opened directory handles and directory-relative
no-follow operations (`openat`/`renameat`/`linkat`/`unlinkat` equivalents), or a
small packaged native helper that exposes those semantics. An OS sandbox may be
defense in depth, but host-access filesystem confinement must remain correct on
its own.

Do not rely on repeated `realpath`/`lstat` checks immediately before an absolute-
path syscall; that only narrows the race window.

## Acceptance criteria

- Parent-directory swaps cannot redirect any filesystem primitive outside the
  workspace.
- Validation and use are bound to the same opened directory chain.
- Missing-leaf creation retains no-replace and atomic-staging behavior.
- Tests deterministically pause inside the validation/use window rather than
  depending on probabilistic race timing.
- Static symlink, workspace-root symlink, and ordinary nested-path behavior
  remain covered.

## 2026-08-27 branch update

Added a deterministic local backend test seam that pauses after the first scoped
path validation and before each filesystem primitive commits. Regression tests
now swap a validated parent directory to an external symlink during that window
for reads, writes, chmod, rename, no-replace link installs, unlink, mkdir, and
directory listing; the external sentinels remain unchanged.

The implementation now revalidates scoped paths after that seam and before the
filesystem syscall. This blocks the reproduced swap window, but it is still not
the full directory-handle/openat-style binding called for above.
