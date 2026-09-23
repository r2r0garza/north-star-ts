# PR99: Hardened host attachment reads

> Status: **DONE** (2026-09-23). User attachment reads in `read_file_tool` and `read_document` now share one no-follow, handle-validated opener; skill resources and workspace/container reads keep their existing semantics.

## Goal

Close the stat/open symlink-swap inconsistency for host attachments while preserving workspace environment reads and bundled skill resources.

## Activation condition

Schedule as a focused filesystem-hardening pass. Coordinate with `055` if that native openat work becomes active, but do not require `055` for a bounded attachment-specific improvement.

## Implementation (2026-09-23)

- **Host-path sources traced:** both tools accepted exactly three sources: workspace paths (via `Environment`, unchanged), `skill://` resources, and Chat attachments matched against `ctx.attachments`. The duplicated `resolveReadable()` now lives in `tools/host_files.ts` and tags host sources with an `origin` of `attachment` or `skill_resource`.
- **Shared opener:** `openHostFile(path, origin)` opens once, then validates the opened handle (`FileHandle.stat()` must be a regular file) and derives `size` from it. This replaces stat-by-path followed by a separate open in both tools.
- **Attachments** open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`. `O_NONBLOCK` means a swapped-in FIFO fails the handle check instead of hanging the open. Where the platform has no `O_NOFOLLOW` (Windows), the path is `lstat`ed first, symlinks are refused, and the handle's `dev`/`ino` must match the `lstat`.
- **Skill resources** are opened without no-follow: `resolveSkillResourcePath()` already `realpath`s and refuses symlinks, and tightening it could break packaged layouts. They still get the handle regular-file check.
- **Scope:** `O_NOFOLLOW` guards the final path component only, which is the swap the plan targets. Ancestor directories of an attachment can still be symlinks (for example `/tmp`); full directory-handle confinement remains `055`.
- **Errors:** `HostFileError` codes (`not_found`, `not_a_file`, `read_failed`) map to the tools' existing error codes with fixed, path-free messages; the tools echo only the model-supplied `path`.
- **Tests:** `tools/host_files.test.ts` covers the opener directly and both tools with an attachment replaced by a symlink (with the no-follow flag removed, these fail). It also covers dangling symlinks, FIFOs, directories, and unchanged skill-resource reads.

## Required plan/analysis pass

Trace every host-path source accepted by `read_file_tool` and `read_document`, separating user attachments from resolved `skill://` resources. Review cross-platform `O_NOFOLLOW` support, current stat-before-open races, regular-file validation through `FileHandle.stat()`, error mapping, and tests for symlink replacement. Decide whether a shared host-readable abstraction is warranted before editing either tool.

## Expected direction

Represent attachment and skill-resource sources distinctly. Use a shared hardened attachment opener that opens with the platform-supported no-follow flag, validates the opened handle as a regular file, and derives size from that handle. Avoid tightening skill-resource behavior accidentally if packaged resources legitimately traverse controlled symlinks.

## Acceptance

- Text and document attachment reads use the same hardened open/validation policy.
- Replacing an allowlisted attachment with a symlink before open cannot redirect the read.
- Workspace/container reads retain their environment semantics.
- Skill-resource reads continue to work in development and packaged layouts.
- Errors remain bounded and do not expose unrelated host paths.

## Likely files

- `src/main/agent/tools/read_file_tool.ts`
- `src/main/agent/tools/document_extraction_tool.ts`
- A shared host attachment helper and focused tests

## Out of scope

- General host filesystem access.
- Full directory-handle/openat confinement, tracked by `055`.
