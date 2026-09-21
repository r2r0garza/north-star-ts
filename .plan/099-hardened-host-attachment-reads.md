# PR99: Hardened host attachment reads

> Status: **DEFERRED**. Apply no-follow and handle-based validation consistently to user attachment reads in both text and document tools without breaking trusted skill-resource resolution.

## Goal

Close the stat/open symlink-swap inconsistency for host attachments while preserving workspace environment reads and bundled skill resources.

## Activation condition

Schedule as a focused filesystem-hardening pass. Coordinate with `055` if that native openat work becomes active, but do not require `055` for a bounded attachment-specific improvement.

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
