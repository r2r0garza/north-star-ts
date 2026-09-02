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
| 43 | P1 | Resolved | [Shell approval identities drift](./043-shell-approval-identity-drift.md) | Approval policy and dashboards |
| 44 | P1 | Fixed | [Revision-checked mutations have a final install race](./044-file-revision-final-install-race.md) | File mutation transactions |
| 45 | P1 | Resolved | [Consequential browser actions are auto-approved](./045-browser-consequential-actions-auto-approved.md) | Browser approval policy |
| 46 | P2 | Closed | [Local reads materialize the entire file](./046-local-read-materializes-entire-file.md) | Local filesystem reads |
| 47 | P2 | Closed | [Local safe writes ignore short writes](./047-local-safe-fs-short-write.md) | Local filesystem writes |
| 48 | P2 | Partial | [Local runtime and sandbox portability gap](./048-local-tool-runtime-and-sandbox-portability.md) | Local execution backend |
| 49 | P2 | Resolved | [Command cursors skip model-truncated output](./049-command-session-cursor-skips-truncated-output.md) | Command session pagination |
| 50 | P2 | Fixed | [MCP call lifecycle and output are unbounded](./050-mcp-call-lifecycle-unbounded.md) | MCP client manager |
| 51 | P2 | Fixed | [Single-file cleanup failures are suppressed](./051-single-file-cleanup-failures-suppressed.md) | Mutation and command cleanup |
| 52 | P2 | Fixed | [Database-backed tests are silently skipped](./052-sqlite-integration-tests-silently-skipped.md) | Test infrastructure and CI |
| 53 | P3 | Closed | [Workspace containment mishandles edge cases](./053-workspace-path-containment-edge-cases.md) | Workspace path resolution |
| 54 | P1 | Partial / Deferred by ADR 009 | [Parent symlink swaps can escape local filesystem confinement](./054-local-filesystem-parent-symlink-race.md) | Local filesystem backend |
| 55 | P1 | Closed | [Browser commit approvals are under-scoped](./055-browser-approval-scope-and-classification.md) | Browser approval policy |
| 56 | P2 | Fixed | [Node pageable reads materialize complete sources](./056-local-pageable-read-streaming-regression.md) | Local filesystem reads |
| 57 | P2 | Fixed | [MCP discovery lacks cancellation and definition bounds](./057-mcp-discovery-lifecycle-and-definition-bounds.md) | MCP discovery |
| 58 | P2 | Fixed | [Command output caps exclude serialization expansion](./058-command-session-serialized-output-cap.md) | Command session rendering |
| 59 | P2 | Closed | [Listener subscriptions leak and background tasks remain untitled](./059-maxlisteners-and-title-generation.md) | IPC subscriptions and conversation titles |
| 60 | P3 | Closed | [Generated titles echo greetings or expose reasoning](./060-title-generation-reasoning.md) | Conversation title generation |
| 61 | P2 | OPEN | [Skill resources resolve against the workspace](./061-skill-resources-resolve-against-workspace.md) | Skill runtime and filesystem roots |

New briefs start in **OPEN** state. When fixing one, add the regression test
described by its acceptance criteria before marking it resolved.

## Process and agent error-recovery follow-up (2026-09-01)

The following briefs document remaining gaps inspected at revision `21bd34d`.
They are remediation plans, not implemented fixes. Ordinary tool-error feedback
already exists; the original run on another computer has not been conclusively
diagnosed. The earlier nested-failure, agent compatibility, and reviewer-search
changes were committed in `5a8058c` and are not reopened by these briefs.

| ID | Severity | Status | Brief | Area |
| --- | --- | --- | --- | --- |
| 65 | P2 | OPEN | [Deterministic tool-error feedback coverage](./065-tool-error-feedback-lacks-loop-integration-tests.md) | Full agent/process loop tests |
| 66 | P1 | OPEN | [API retries restart process workers](./066-api-retries-restart-process-workers.md) | Shared model-request recovery |
| 67 | P1 | OPEN | [Interrupted tools risk duplicate effects](./067-interrupted-tools-risk-duplicate-side-effects.md) | Durable tool outcomes and safe resume |
| 68 | P1 | OPEN | [Validator errors silently approve phases](./068-validator-errors-silently-approve-phases.md) | Fail-closed review |
| 69 | P2 | OPEN | [Failures lose stage and attempt context](./069-process-failures-lose-stage-and-attempt-context.md) | Error records and monitor actions |
| 70 | P2 | OPEN | [Tool-free replies do not prove completion](./070-tool-free-replies-do-not-prove-phase-completion.md) | Explicit process completion contracts |
| 71 | P2 | OPEN | [Tool batches delay feedback and cancellation](./071-tool-batches-delay-error-feedback-and-cancellation.md) | Bounded lifecycle and per-call durability |

### Suggested implementation sequence

1. Establish the deterministic harness in 065 and the shared failure vocabulary
   from 069. Add failing regression cases before each behavioral change.
2. Ship the fail-closed baseline of 068 and shared request recovery in 066.
   Remove automatic fresh-worker replay for exhausted transport failures;
   coordinate that boundary with 067 rather than adding another retry loop.
3. Implement durable safe resume in 067 and batch lifecycle guarantees in 071.
   Retain successful results and handle unknown effects conservatively.
4. Finish review-only recovery actions in 068 and the durable diagnostics/UI in
   069. Test nesting, cancellation, restart, and late completion together.
5. Implement 070 after selecting and documenting its compatibility policy.
   This improves completion assurance but does not guarantee model correctness.

### Closure requirements

- Script model responses and inject tool/transport failures; live paid API calls
  are not necessary to prove orchestration behavior.
- Exercise the real shared loop in at least one process integration test;
  mocking `runAgentLoop` alone cannot establish error-delivery guarantees.
- Require database-backed tests to execute using the existing 052/`test:sqlite`
  workflow. Report executed/skipped counts and preserve Electron ABI usability.
- Preserve workspace confinement, approval rules, and main/preload/renderer
  process boundaries. No retry grants new permission.
- Record actual test commands, results, limitations, and implementing commits in
  each brief before marking it fixed. Do not claim that a scripted recovery
  proves that a real agent always selects a successful strategy.
