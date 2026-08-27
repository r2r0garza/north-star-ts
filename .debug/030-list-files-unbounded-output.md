# list_files materializes and returns an unlimited directory

> Status: **FIXED**  
> Severity: **P2 — memory and context exhaustion**  
> Area: directory listing output

## Problem

`list_files_tool` reads every directory entry and joins every name into one
string. A generated or hostile directory can allocate a large main-process array
and tool result before any model-context control applies.

## Reproduction test

Use a fake environment returning more entries and bytes than the configured caps.
Verify deterministic ordering, a bounded result, and explicit incompleteness
metadata. Include very long UTF-8 names.

## Fix direction

Add server-owned entry and byte caps, over-fetch by one where possible, and return
a continuation/narrowing hint. Container readdir should avoid capturing unlimited
`ls` output before the tool cap.

## Acceptance criteria

- Result items and UTF-8 bytes are bounded on both backends.
- Truncation is explicit and never presented as a complete listing.
- Small directories retain the current display behavior.
