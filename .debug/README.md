# Tool hardening debug queue

These briefs capture the original post-hardening review of plans `046` through
`052` and the comprehensive built-in-tool closure audit that followed. Numeric
IDs are stable creation order; prioritize open P1 issues, then P2, then P3 unless
a brief names a prerequisite.

| Order | Severity | Status | Brief | Area |
| --- | --- | --- | --- | --- |
| 1 | P1 | Closed | [Concurrent patch destination overwrite](./001-concurrent-patch-destination-overwrite.md) | Multi-file patch transaction |
| 2 | P2 | Fixed | [File mutations lose original mode](./002-file-mutations-lose-original-mode.md) | Edit/write/patch staging |
| 3 | P2 | Resolved | [Ripgrep spawn failure becomes no matches](./003-ripgrep-spawn-failure-returns-no-matches.md) | Workspace search |
| 4 | P2 | Resolved | [Command output cap drops the newest chunk](./004-command-output-cap-drops-newest-chunk.md) | Shell sessions |
| 5 | P2 | Fixed | [Oversized-line pagination cannot advance](./005-oversized-line-pagination-cannot-advance.md) | Pageable reads |
| 6 | P3 | Resolved | [Plan 048 status is stale](./006-plan-048-status-is-stale.md) | Planning documentation |
| 7 | P2 | Resolved | [Combined process output loses stream order](./007-combined-process-output-loses-stream-order.md) | Shared process capture |
| 8 | P2 | Closed | [Search capture truncation is not reported](./008-search-capture-truncation-is-not-reported.md) | Workspace search |
| 9 | P2 | Fixed | [Patch commit ignores concurrent mode changes](./009-patch-commit-ignores-concurrent-mode-changes.md) | Multi-file patch transaction |
| 10 | P2 | Closed | [Container oversized-line reads are unbounded](./010-container-oversized-line-reads-are-unbounded.md) | Pageable reads |
| 11 | P3 | Resolved | [Container test availability probe is incomplete](./011-container-test-availability-probe-is-incomplete.md) | Test infrastructure |
| 12 | P2 | Fixed | [Patch commit staging window allows stale overwrite](./012-patch-commit-staging-window-allows-stale-overwrite.md) | Multi-file patch transaction |
| 13 | P2 | Fixed | [Container test probes can hang indefinitely](./013-container-test-probes-can-hang-indefinitely.md) | Test infrastructure |
| 14 | P2 | Fixed | [Patch staging failure leaves temporary files](./014-patch-staging-failure-leaves-temporary-files.md) | Multi-file patch transaction |
| 15 | P2 | Fixed | [Container probe timeout is not a hard deadline](./015-container-probe-timeout-is-not-a-hard-deadline.md) | Test infrastructure |
| 16 | P3 | Resolved | [Patch rollback does not track completed backups](./016-patch-rollback-does-not-track-completed-backups.md) | Multi-file patch transaction |
| 17 | P1 | Fixed | [Create-only writes can replace a concurrent destination](./017-create-only-write-race.md) | Single-file writes |
| 18 | P1 | Fixed | [Patch rollback can leave an installed destination](./018-patch-rollback-swallows-destination-removal.md) | Multi-file patch rollback |
| 19 | P1 | Fixed | [list_files can enumerate outside the workspace](./019-list-files-symlink-escape.md) | Directory listing |
| 20 | P1 | Fixed | [Local realpath validation has a check/use race](./020-local-path-resolution-symlink-toctou.md) | Local path confinement |
| 21 | P1 | Fixed | [exec_command cwd can escape through a symlink](./021-shell-cwd-symlink-escape.md) | Command sessions |
| 22 | P1 | Fixed | [Shell analysis misses substitutions and wrappers](./022-shell-analyzer-backtick-wrapper-network-bypass.md) | Approval policy |
| 23 | P1 | Fixed | [Headless fetches can reach private services](./023-web-fetch-ssrf-redirect-scope.md) | Web and dashboards |
| 24 | P1 | Fixed | [Dashboard recipes can replace the captured cwd](./024-dashboard-recipe-arbitrary-cwd.md) | Dashboard refresh |
| 25 | P2 | Resolved | [Container runtime CLI operations are unbounded](./025-container-runtime-cli-unbounded.md) | Container backend |
| 26 | P2 | Resolved | [Container commands can survive Stop](./026-container-inflight-process-survives-stop.md) | Container shell execution |
| 27 | P2 | Fixed | [Container paths can escape the workspace mount](./027-container-resolver-symlink-escape.md) | Container path confinement |
| 28 | P2 | Resolved | [File mutation source reads are unbounded](./028-file-mutation-source-reads-unbounded.md) | Edit/write/patch planning |
| 29 | P2 | Fixed | [Patch cleanup failures are suppressed](./029-patch-cleanup-failures-suppressed.md) | Patch cleanup |
| 30 | P2 | Fixed | [list_files output is unbounded](./030-list-files-unbounded-output.md) | Directory listing |
| 31 | P2 | Fixed | [index_query accepts an unbounded limit](./031-index-query-limit-unbounded.md) | Workspace index |
| 32 | P2 | Fixed | [Browser snapshot builds the full AX tree](./032-browser-snapshot-full-tree-unbounded.md) | Agent browser |
| 33 | P2 | Fixed | [Network response bodies are unbounded](./033-network-response-bodies-unbounded.md) | Web and dashboards |
| 34 | P2 | Resolved | [Dashboard JSON truncation corrupts data](./034-dashboard-json-truncation-corrupts-data.md) | Dashboard persistence |
| 35 | P2 | Resolved | [Dashboard refresh ignores command failure](./035-dashboard-refresh-ignores-command-failure.md) | Dashboard refresh |
| 36 | P2 | Fixed | [Windows Python heredocs regressed under sessions](./036-windows-python-heredoc-session-regression.md) | Command sessions |
| 37 | P3 | Resolved | [Byte truncation can split UTF-8](./037-utf8-truncation-splits-codepoints.md) | Output formatting |
| 38 | P3 | Fixed | [Listings cannot represent newline filenames](./038-directory-listing-newline-filenames.md) | Directory listing |
| 39 | P3 | Fixed | [Command-session completion test is timing-dependent](./039-command-session-test-timing-flake.md) | Test infrastructure |
| 40 | P3 | Fixed | [CLI-session tests fail on native ABI mismatch](./040-cli-sessions-native-abi-test-failure.md) | Test infrastructure |
| 41 | P1 | Resolved | [Tool execution ignores the offered tool set](./041-tool-call-availability-not-enforced.md) | Agent tool dispatch |
| 42 | P1 | Fixed | [Headless fetch is vulnerable to DNS rebinding](./042-headless-fetch-dns-rebinding.md) | Shared safe-fetch transport |
| 43 | P1 | Open | [Shell approval identities drift](./043-shell-approval-identity-drift.md) | Approval policy and dashboards |
| 44 | P1 | Fixed | [Revision-checked mutations have a final install race](./044-file-revision-final-install-race.md) | File mutation transactions |
| 45 | P1 | Open | [Consequential browser actions are auto-approved](./045-browser-consequential-actions-auto-approved.md) | Browser approval policy |
| 46 | P2 | Closed | [Local reads materialize the entire file](./046-local-read-materializes-entire-file.md) | Local filesystem reads |
| 47 | P2 | Open | [Local safe writes ignore short writes](./047-local-safe-fs-short-write.md) | Local filesystem writes |
| 48 | P2 | Open | [Local runtime and sandbox portability gap](./048-local-tool-runtime-and-sandbox-portability.md) | Local execution backend |
| 49 | P2 | Resolved | [Command cursors skip model-truncated output](./049-command-session-cursor-skips-truncated-output.md) | Command session pagination |
| 50 | P2 | Fixed | [MCP call lifecycle and output are unbounded](./050-mcp-call-lifecycle-unbounded.md) | MCP client manager |
| 51 | P2 | Open | [Single-file cleanup failures are suppressed](./051-single-file-cleanup-failures-suppressed.md) | Mutation and command cleanup |
| 52 | P2 | Open | [Database-backed tests are silently skipped](./052-sqlite-integration-tests-silently-skipped.md) | Test infrastructure and CI |
| 53 | P3 | Open | [Workspace containment mishandles edge cases](./053-workspace-path-containment-edge-cases.md) | Workspace path resolution |

New briefs start in **OPEN** state. When fixing one, add the regression test
described by its acceptance criteria before marking it resolved.
