# Browser snapshot builds the full accessibility tree before truncation

> Status: **FIXED**  
> Severity: **P2 — renderer/main-process memory pressure**  
> Area: agent browser perception

## Problem

`BrowserSession.snapshot` requests `Accessibility.getFullAXTree`, stores refs for
every interactive node, and builds all output lines. The tool truncates only the
finished string. A pathological page can therefore create a huge CDP response
and ref map despite the bounded model result.

## Reproduction test

Load pages with accessibility trees beyond node and byte budgets. Assert snapshot
settles within its deadline, keeps bounded refs/output, and reports that the tree
was incomplete.

## Fix direction

Adopt a bounded tree strategy—protocol depth/chunking or controlled traversal—and
stop collecting once node/ref/byte limits are reached. Clear stale refs on every
failure and truncation path.

## Acceptance criteria

- AX nodes, interactive refs, and rendered bytes have hard caps.
- Truncated snapshots are explicit and actionable.
- Click/type can target every ref actually returned.

## Resolution

`BrowserSession.snapshot` now avoids `Accessibility.getFullAXTree`; it walks a
bounded set of visible DOM candidates and reads each with
`Accessibility.getPartialAXTree`. Snapshot output, AX reads, and interactive refs
are capped, truncation is reported in the returned outline, and refs are rebuilt
only from lines actually returned.
