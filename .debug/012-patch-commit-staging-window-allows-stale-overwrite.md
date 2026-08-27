# Patch commit staging window allows stale overwrite

> Status: **Fixed**  
> Severity: **P2 — concurrent state can be silently overwritten**  
> Area: multi-file patch transaction

## Problem

`commitPatch` validates every source revision and permission mode before it
stages replacement files. It then writes and chmods all temporary files before
starting the backup-renames that mutate the workspace.

For a multi-file or slow-backend patch, another process can change a source's
content or mode after the initial validation but before that source is renamed
to its backup. The patch then installs the previously staged version and
silently overwrites the newer state.

The mode comparison added for bug 009 closes the approval-to-commit gap, but it
does not close this validation-to-rename staging window. Single-file
`atomicWriteChecked` performs a second revision and mode check immediately
before rename; multi-file patch commit does not yet provide the same guarantee.

## Impact

- Concurrent content or permission changes can be lost after validation.
- The risk grows with patch size, backend latency, and the number of staged
  files.
- The final filesystem state can differ from both the approved preview and the
  state that existed immediately before mutation.

## Reproduction test

Use the deterministic fake environment to pause or inject a mutation while
temporary files are being staged:

1. Plan a patch that updates at least two existing files.
2. Allow the initial revision and mode validation to succeed.
3. While the second temporary file is written, externally change the first
   source's content without changing its original revision beforehand.
4. Repeat with a mode-only change such as `0644` to `0755`.
5. Assert the patch returns `stale_file` before any source is backed up or any
   destination is installed.
6. Assert every source, destination, and permission mode remains exactly as it
   was at the point the conflict was detected.

Also cover move operations and a control case with no concurrent mutation.

## Fix direction

- Stage all replacement files first without mutating source or destination
  paths.
- After staging, perform a second transaction-wide validation of source
  revisions, source modes, and move destinations.
- Begin backup renames only if the complete second validation succeeds.
- Keep this final validation as close as practical to the first workspace
  mutation.
- Clean up every staged temporary file when the second validation rejects the
  patch.

Per-entry validation immediately before each rename is not sufficient by
itself: a later conflict could be discovered after earlier entries have already
been backed up. The pre-mutation validation pass must remain transaction-wide.

## Acceptance criteria

- A content change during staging rejects the entire patch as stale.
- A permission-mode change during staging rejects the entire patch as stale.
- No backup rename or destination install occurs before final validation of all
  entries completes.
- Rejection preserves all source content, paths, destinations, and modes.
- Update and move-with-hunks operations share the same behavior.
- Staged temporary files are removed after success, rejection, or failure.
- Local and container/fake backends exercise the same transaction contract.

## Resolution

- `commitPatch` now runs the source revision, source mode, and move destination
  validation once before staging and again after all temporary files are staged,
  immediately before the first backup rename.
- A staging-time content, mode, or move-source change now returns `stale_file`
  before any workspace path is renamed or installed.
- Rejection after staging removes all staged temporary files before returning.
- Fake-environment regression tests cover staging-time content changes, mode
  changes, move-with-hunks source changes, and the unchanged control path.

## Verification

- `pnpm exec vitest run src/main/agent/tools/apply_patch_tool.test.ts`
- `pnpm exec vitest run src/main/agent/env/local.test.ts src/main/agent/env/container.test.ts`
- `pnpm exec tsc --noEmit`
