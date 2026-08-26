# Tool hardening debug queue

These briefs capture the open issues found during the post-hardening review of
plans `046` through `052`. Work through them in severity order unless a later
brief becomes a prerequisite for an earlier fix.

| Order | Severity | Status | Brief | Area |
| --- | --- | --- | --- | --- |
| 1 | P1 | Closed | [Concurrent patch destination overwrite](./001-concurrent-patch-destination-overwrite.md) | Multi-file patch transaction |
| 2 | P2 | Fixed | [File mutations lose original mode](./002-file-mutations-lose-original-mode.md) | Edit/write/patch staging |
| 3 | P2 | Resolved | [Ripgrep spawn failure becomes no matches](./003-ripgrep-spawn-failure-returns-no-matches.md) | Workspace search |
| 4 | P2 | Resolved | [Command output cap drops the newest chunk](./004-command-output-cap-drops-newest-chunk.md) | Shell sessions |
| 5 | P2 | Fixed | [Oversized-line pagination cannot advance](./005-oversized-line-pagination-cannot-advance.md) | Pageable reads |
| 6 | P3 | Resolved | [Plan 048 status is stale](./006-plan-048-status-is-stale.md) | Planning documentation |
| 7 | P2 | Resolved | [Combined process output loses stream order](./007-combined-process-output-loses-stream-order.md) | Shared process capture |
| 8 | P2 | Open | [Search capture truncation is not reported](./008-search-capture-truncation-is-not-reported.md) | Workspace search |
| 9 | P2 | Open | [Patch commit ignores concurrent mode changes](./009-patch-commit-ignores-concurrent-mode-changes.md) | Multi-file patch transaction |
| 10 | P2 | Open | [Container oversized-line reads are unbounded](./010-container-oversized-line-reads-are-unbounded.md) | Pageable reads |
| 11 | P3 | Open | [Container test availability probe is incomplete](./011-container-test-availability-probe-is-incomplete.md) | Test infrastructure |

New briefs start in **OPEN** state. When fixing one, add the regression test
described by its acceptance criteria before marking it resolved.
