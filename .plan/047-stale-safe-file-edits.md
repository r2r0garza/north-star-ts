# PR47: Stale-safe file edits and diff previews

> Status: **DONE**. Depends on `046` for optional read revisions. No DB
> migration.

## Context

`edit_file_tool` reads a file, computes an exact-string replacement, may wait for
human approval, then writes its earlier snapshot atomically. If another process
changes the file during that wait, the approved edit can overwrite newer work.
`write_file_tool` has the same risk for overwrite/append operations. Approval
cards currently receive only a path summary, not the change being approved.

Atomic rename prevents half-written files; it does not prevent stale writes.

## Goal

Make every text mutation conditional on the version the tool inspected, show a
bounded human/model-readable diff before approval, and fail with an actionable
conflict instead of overwriting concurrent changes.

## Design

### Revision checks

- Define a shared `FileRevision` as SHA-256 of the exact bytes read.
- `edit_file_tool` hashes its initial bytes, computes the replacement/diff, waits
  for approval, then re-reads and hashes immediately before rename. Mismatch →
  `ERROR[stale_file]`; no write occurs.
- Accept optional `expected_revision` from a prior `read_file_tool` result. If
  present, validate it before computing the edit, closing the read→edit race
  across separate model turns/calls.
- Apply the same precondition to overwrite and append. Distinguish create-only
  from overwrite explicitly so “create” cannot silently replace an existing file.
- A stale error returns current revision plus a recovery hint to re-read and
  rebase; never returns the whole new file automatically.

### Diff preview

- Generate a unified, path-relative text diff before the approval gate.
- Bound preview lines/bytes and include additions, deletions, affected line
  range, and whether the preview was truncated.
- Extend the file `ToolAction.detail` with the bounded diff metadata so the
  approval/activity UI can render the actual proposed change.
- Persist only the normal tool summary/result in conversation history; do not
  duplicate an enormous diff in several transcript records.

### Atomicity details

- Use a random sibling temp filename, preserve the existing same-filesystem
  atomic rename, and remove the temp file on every failure path.
- Revalidate the target's real path immediately before writing so a concurrent
  symlink swap cannot escape the workspace.
- Preserve the original file mode where the environment supports it; record a
  separate follow-up if container parity requires an Environment extension.

## Implementation areas

- New shared file-revision/diff helpers under `src/main/agent/tools/file/`.
- `edit_file_tool.ts` and `write_file_tool.ts`: revision and explicit mode rules.
- `approval/types.ts` plus renderer approval/activity cards: bounded diff detail.
- Environment primitives only where metadata/mode preservation requires them.

## Verification

- Edit succeeds when the revision remains unchanged.
- Change the file while approval is pending; the tool returns `stale_file` and
  preserves the external edit byte-for-byte.
- Wrong caller-supplied revision fails before approval.
- Create-only rejects an existing path; overwrite/append enforce revisions.
- Diff preview is correct for insertion/deletion/replacement and bounded for a
  huge change.
- Temp files are removed after denial, conflict, abort, rename error, and Stop.
- Symlink replacement between validation and write fails closed.

## Out of scope

- Multi-file atomic edits (`050`).
- Automatic merge/conflict resolution.
- Binary-file modification.
