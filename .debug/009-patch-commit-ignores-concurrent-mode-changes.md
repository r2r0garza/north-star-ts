# Patch commit ignores concurrent file-mode changes

> Status: **FIXED**  
> Severity: **P2 — stale metadata overwrite**  
> Area: multi-file patch transaction

## Problem

Patch planning now captures each update/move source's permission mode so staged
files can preserve it. Before commit, `commitPatch` revalidates source content
revisions but does not compare the current source mode with the captured mode.

If another process changes permissions after planning or approval—for example,
running `chmod +x script.sh`—the patch applies the older captured mode to its
staged file and silently reverses that external change.

Single-file `atomicWriteChecked` already performs a mode comparison immediately
before rename; multi-file patches do not provide the same protection.

## Impact

- Concurrent executable-bit or permission changes can be lost.
- Patch stale-safety differs from edit/write stale-safety.
- The committed filesystem state may differ from what the user approved and
  what existed immediately before commit.

## Reproduction test

Add a real-filesystem and/or deterministic fake-environment test:

1. Create `script.sh` with mode `0644` and plan an update or move.
2. During the approval gate, change its mode to `0755` without changing content.
3. Continue the patch.
4. Assert the patch returns `stale_file` and preserves both content and mode
   `0755`.

Repeat for update and move-with-hunks. Include a control where the captured mode
remains unchanged and the patch succeeds.

## Fix direction

- Re-read source mode alongside content revision during pre-commit validation.
- Treat a mode mismatch as stale state before any backup or destination install.
- Revalidate as close as practical to source backup/rename, consistent with the
  single-file mutation path.
- Include enough current-state metadata in the error for recovery without
  weakening path confinement.

## Acceptance criteria

- Concurrent mode changes cause a stale/conflict result.
- No content, source path, destination, or permission bits change on rejection.
- Update and move operations share the same behavior.
- Unchanged modes continue to be preserved on successful patches.
- Local and container backends have equivalent tests where supported.

## Resolution

- `commitPatch` now re-reads source permission bits during pre-commit
  validation and returns `stale_file` before staging or backup if they differ
  from the planned mode.
- Fake-environment patch transaction tests cover update and move-with-hunks
  chmod races plus the unchanged-mode success path.
- Local filesystem tests cover update and move-with-hunks chmod races.
