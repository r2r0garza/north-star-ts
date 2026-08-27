# PR55: Local filesystem openat helper

> Status: **NOT STARTED**. Deferred security hardening required to complete
> `.debug/054-local-filesystem-parent-symlink-race.md`.

## Context

The local host filesystem backend currently validates workspace paths in Node and
then calls `fs/promises` primitives on absolute paths. The branch mitigation for
debug `054` revalidates after a deterministic pre-syscall test seam, which
blocks the reproduced parent-symlink swap window.

That mitigation is intentionally partial. Node does not expose the `*at` syscall
family needed to bind validation to use. A complete fix requires a small
packaged native helper or native addon that walks paths through opened directory
handles and performs final operations relative to the validated parent handle.

## Goal

Replace the local backend's absolute-path filesystem primitives with a
directory-relative helper so parent-directory swaps cannot redirect reads,
writes, chmods, renames, no-replace installs, unlinks, directory creation,
stat/list operations, or search roots outside the workspace.

## Scope

- Add a packaged native helper or native addon available from the Electron main
  process without relying on system Python or shell scripts.
- Resolve workspace paths by opening the workspace root and each directory
  component with no-follow semantics.
- Perform final operations relative to the opened parent directory handle:
  `openat`, `fstatat`, `mkdirat`, `renameat`, `linkat`, `unlinkat`, or platform
  equivalents.
- Preserve existing LocalEnvironment behavior and tool contracts:
  - static symlink rejection
  - workspace-root validation
  - ordinary nested paths
  - dot-dot-prefixed filenames
  - missing-leaf creation
  - no-replace install semantics
  - atomic staging and rename behavior used by file mutations
- Keep Local runtime profile checks (`host-access`, `workspace-write`,
  `read-only`) enforced for direct file tools.
- Maintain container backend behavior separately; this plan is for local host
  filesystem operations only.

## Implementation areas

- Native helper package:
  - POSIX implementation for macOS/Linux using directory fds and `*at` calls.
  - Windows design decision for equivalent semantics before enabling Windows
    support; fail closed if equivalent protection is unavailable.
  - Packaged Electron distribution support.
- `src/main/agent/env/local.ts`:
  - replace direct `fs/promises` local safe filesystem calls with helper calls.
  - keep the existing Environment interface stable unless a narrow helper seam is
    clearly cleaner.
- Tests:
  - keep current static symlink and pre-syscall swap tests.
  - add native-helper tests that pause after parent directory fd validation,
    swap the visible parent path to an external symlink, resume, and prove the
    operation either affects the original validated directory or fails closed.

## Verification

- Parent-directory swaps cannot redirect any local filesystem primitive outside
  the workspace.
- Validation and use are bound to the same opened directory chain.
- Final-component symlinks remain rejected.
- Missing-leaf creation retains no-replace and atomic-staging behavior.
- Directory listing and search root validation cannot follow swapped parents.
- The helper works in packaged Electron builds.
- Unsupported platforms fail closed with a clear error rather than silently
  weakening confinement.

## Out of scope

- Implementing Linux or Windows shell sandbox adapters; those remain tracked by
  `053` and `054`.
- Changing container filesystem confinement.
- Treating approval classification or repeated `realpath`/`lstat` checks as the
  final security boundary.
