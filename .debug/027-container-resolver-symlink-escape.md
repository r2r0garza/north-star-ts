# Container workspace paths can follow symlinks into the image filesystem

> Status: **FIXED**  
> Severity: **P2 — container confinement mismatch**  
> Area: ContainerEnvironment path resolution

## Problem

Container `resolve` is lexical only. A symlink under `/workspace` can point to
`/etc`, `/root`, or another container path, and subsequent file tools follow it.
The bind mount prevents host escape but does not mean the container sees only
`/workspace`, as the current comment claims.

## Reproduction test

Create `/workspace/link` pointing to a container-only directory with a sentinel.
Verify read, list, search, edit, write, and patch operations through `link` are
rejected.

## Fix direction

Implement realpath/nearest-existing-ancestor validation inside the container and
verify the resolved path remains beneath the real `/workspace` root. Revalidate
at mutation commit boundaries.

## Acceptance criteria

- File tools cannot access any container path outside `/workspace` via symlinks.
- New paths beneath valid workspace parents remain supported.
- Documentation no longer claims the mount hides the rest of the container.

## Resolution

- `ContainerEnvironment` now validates in-container paths with a realpath-based
  nearest-existing-ancestor check against the real `/workspace` mount root.
- Container file primitives revalidate paths before dereferencing them, including
  read, paged read, write, chmod, rename, no-replace install, remove, mkdir,
  stat, directory listing, and search.
- The container path mapper now rejects arbitrary host/container absolute paths
  instead of remapping outside paths through `/workspace/..`.
- The stale comment claiming the mount hides the rest of the container was
  removed.

## Verification

- `pnpm exec vitest run src/main/agent/env/container.test.ts` (fake-runtime
  tests passed; Docker/Podman integration cases skipped locally because no
  usable runtime was available)
- `pnpm exec tsc --noEmit`
