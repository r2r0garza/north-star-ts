# 009 — Local filesystem confinement requires directory-relative syscalls

**Area:** Main — `src/main/agent/env/local.ts`, local filesystem backend
**Status:** Accepted

## What

The local Node filesystem backend may use repeated lexical, `realpath`, and
`lstat` validation as a near-term hardening measure, but that is not the final
security boundary for workspace confinement.

To close parent-directory symlink races completely, local host filesystem
operations must bind validation to use through opened directory handles and
directory-relative operations such as `openat`, `fstatat`, `mkdirat`,
`renameat`, `linkat`, and `unlinkat`, or platform equivalents exposed by a
small packaged native helper.

## Why

Node's `fs/promises` APIs operate on absolute paths for the primitives this
backend needs. `O_NOFOLLOW` protects only the final component passed to `open`;
it does not stop the kernel from following a parent directory that is swapped to
a symlink after validation but before the syscall.

The current branch mitigation revalidates immediately before the syscall and has
deterministic tests for that specific window. That is useful defense in depth,
but it still narrows a race rather than removing it. The complete fix is to walk
the workspace path as a stable chain of opened directory descriptors and perform
the final operation relative to the validated parent descriptor.

## Consequences

- `.debug/054-local-filesystem-parent-symlink-race.md` remains **PARTIAL** until
  the backend stops relying on absolute-path syscalls for local host filesystem
  primitives.
- A future plan must introduce a packaged native helper or native addon instead
  of depending on system Python or shell commands.
- The helper must cover reads, pageable reads, writes, chmod, rename,
  no-replace installs, unlink, mkdir, stat, directory listing, and search root
  validation.
- The existing revalidation tests should remain as regression coverage, but the
  final acceptance test should pause after parent directory descriptor
  validation, swap the visible path, and prove the final directory-relative
  syscall cannot follow the swapped symlink.

## Trade-offs / notes

- Repeated validation is acceptable as temporary hardening because it blocks the
  deterministic reproduction in the current Node backend.
- It is not enough to mark the issue complete because a concurrent swap can
  still occur between the last validation and an absolute-path syscall.
- macOS `/dev/fd/<dirfd>/child` is not a portable or sufficient substitute for
  `openat` semantics in Node.
