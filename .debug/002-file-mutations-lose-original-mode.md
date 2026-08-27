# File mutations lose the original filesystem mode

> Status: **FIXED**  
> Severity: **P2 — functional regression**  
> Area: atomic edit/write and multi-file patch staging

## Problem

Atomic mutation writes content to a new sibling temp file and renames it over
the original. The temp file receives the process/umask default mode; the
original mode is neither captured nor restored. For example, editing a `0755`
script commonly replaces it with a `0644` file.

`Environment.StatInfo` exposes only size and type, and the environment has no
mode-setting primitive. The same staging approach is used by:

- `edit_file_tool`
- `write_file_tool` in overwrite/append modes
- `apply_patch_tool` updates and moves

Plans `047` and `050` explicitly call for preserving or capturing file modes.

## Impact

- Edited scripts can stop being executable.
- Other permission bits can change unexpectedly.
- Patch moves with content changes do not preserve source permissions.
- Local and container behavior may diverge based on their default umasks.

## Reproduction test

Add real-filesystem LocalEnvironment tests:

1. Create a shell script and set its mode to `0755`.
2. Edit it with `edit_file_tool`; assert the resulting mode is still `0755`.
3. Repeat for overwrite, append, patch update, and move-with-hunks.
4. Add a control test proving newly added files receive the documented default
   mode rather than inheriting an unrelated source mode.

Container parity should be covered when the integration environment is
available.

## Fix direction

- Extend environment metadata with the permission bits needed by mutations.
- Add a backend operation to apply a captured mode to a staged file before its
  final rename.
- For updates/overwrite/append, capture the original target mode.
- For moves, preserve the source mode on the destination.
- Define and document the default mode for genuinely new files.
- Keep permissions bounded to mode bits; do not accidentally copy ownership,
  ACLs, or platform-specific flags without an explicit design.

## Acceptance criteria

- Updating an executable file preserves its executable bits.
- Overwrite, append, patch update, and move preserve the intended source mode.
- Adds use one documented default mode.
- Local and container backends return equivalent results where supported.
- A failure while applying mode metadata leaves the original file intact and
  cleans up the staged file.

## Fix

- Added permission bits to `Environment.stat` metadata and a bounded
  `Environment.chmod(path, mode)` primitive.
- Local and container backends now return permission bits and can apply them to
  staged temp files.
- `atomicWriteChecked` preserves the original mode for existing-file edits and
  rejects concurrent mode changes before the final rename.
- `apply_patch_tool` captures source mode for update and move operations, then
  applies it to the staged destination before install.
- New add operations keep the backend default create mode: `0o666` filtered by
  the active umask.

## Verification

- `pnpm exec vitest run src/main/agent/tools/file_mode_mutation.test.ts src/main/agent/tools/edit_file_tool.test.ts src/main/agent/tools/write_file_tool.test.ts src/main/agent/tools/apply_patch_tool.test.ts src/main/agent/env/local.test.ts`
- `pnpm exec vitest run src/main/agent/env/container.test.ts`
