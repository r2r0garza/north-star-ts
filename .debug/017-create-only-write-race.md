# Create-only writes can replace a concurrent destination

> Status: **Fixed**  
> Severity: **P1 — silent data loss**  
> Area: single-file atomic writes

## Problem

`atomicWriteChecked` verifies that a missing target is still absent, then installs
the staged file with ordinary `rename`. Another actor can create the target
between those operations; rename then replaces that file. Read errors are also
treated as absence, so an existing but unreadable target can enter the same path.

## Reproduction test

Pause after the final revision check for a create or append-to-missing write,
create the destination externally, resume, and assert the external bytes survive.
Repeat with a fake environment whose destination read fails while installation
would otherwise replace it.

## Fix direction

Use `Environment.installFileNoReplace` whenever `expectedRevision` is undefined.
If the backend lacks that primitive, fail closed. Distinguish not-found errors
from other read failures.

## Acceptance criteria

- Create and append-to-missing never replace a concurrent destination.
- Existing unreadable targets are not treated as safely absent.
- Overwrite/edit behavior and mode preservation remain unchanged.

## Resolution

`atomicWriteChecked` now uses `Environment.installFileNoReplace` for writes whose
expected revision is missing, and fails closed when that primitive is
unavailable. Revision reads only classify real not-found errors as absence; other
read failures propagate so unreadable destinations are not treated as safe
create targets.

Regression coverage was added for concurrent destination creation during create
and append-to-missing writes, unreadable destination reads, and missing
no-replace backend support.
