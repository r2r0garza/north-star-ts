# Tool hardening debug queue

Last audited: **2026-09-02**, against the current `feat/agent-hardening` working
tree. The 96 briefs below cover tool hardening and the subsequent agent/process
recovery work. Numeric IDs are stable creation order.

## Current queue

**The queue is not fully closed:** 93 briefs are Closed, Fixed, or Resolved;
061 is Implemented with a documented execution boundary; 048 and 054 remain
Partial.

| ID  | Remaining work                                                                                                                                                                                                               | Tracking / prerequisite                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 048 | Sandbox enforcement coverage and user-facing documentation distinguishing approval, command classification, and OS isolation. Native Linux/Windows sandbox adapters remain deferred; unsupported Local profiles fail closed. | [Linux adapter plan](../.plan/053-linux-local-sandbox-adapter.md), [Windows adapter plan](../.plan/054-windows-local-sandbox-adapter.md)                                                                       |
| 054 | Bind local filesystem validation and use to opened directory handles; repeated path validation only mitigates the parent-symlink race.                                                                                       | [ADR 009](../.decisions/009-local-filesystem-openat-helper.md) deliberately retains Partial status; [native helper plan](../.plan/055-local-filesystem-openat-helper.md) exists but is Not Started / deferred. |

061 provides read-only `skill://` resource access. Direct execution of bundled
scripts through shell URI rewriting remains outside its implemented scope, as
recorded in that brief; Implemented should not be read as universal command
support.

The audit added the 26 missing index entries (062–064 and 072–094), synchronized
statuses with all brief files, and removed the obsolete implementation sequence
for the now-completed 065–071 recovery work. Historical verification remains in
the individual briefs and their linked umbrella resolutions. This pass checks
tracking consistency; partial/deferred work remains visible until verified.

## Brief index

| ID  | Severity | Status                        | Brief                                                                                                                               | Area                                               |
| --- | -------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 001 | P1       | Closed                        | [Concurrent patch destination overwrite](./001-concurrent-patch-destination-overwrite.md)                                           | Multi-file patch transaction                       |
| 002 | P2       | Fixed                         | [File mutations lose original mode](./002-file-mutations-lose-original-mode.md)                                                     | Edit/write/patch staging                           |
| 003 | P2       | Resolved                      | [Ripgrep spawn failure becomes no matches](./003-ripgrep-spawn-failure-returns-no-matches.md)                                       | Workspace search                                   |
| 004 | P2       | Resolved                      | [Command output cap drops the newest chunk](./004-command-output-cap-drops-newest-chunk.md)                                         | Shell sessions                                     |
| 005 | P2       | Fixed                         | [Oversized-line pagination cannot advance](./005-oversized-line-pagination-cannot-advance.md)                                       | Pageable reads                                     |
| 006 | P3       | Resolved                      | [Plan 048 status is stale](./006-plan-048-status-is-stale.md)                                                                       | Planning documentation                             |
| 007 | P2       | Resolved                      | [Combined process output loses stream order](./007-combined-process-output-loses-stream-order.md)                                   | Shared process capture                             |
| 008 | P2       | Closed                        | [Search capture truncation is not reported](./008-search-capture-truncation-is-not-reported.md)                                     | Workspace search                                   |
| 009 | P2       | Fixed                         | [Patch commit ignores concurrent mode changes](./009-patch-commit-ignores-concurrent-mode-changes.md)                               | Multi-file patch transaction                       |
| 010 | P2       | Closed                        | [Container oversized-line reads are unbounded](./010-container-oversized-line-reads-are-unbounded.md)                               | Pageable reads                                     |
| 011 | P3       | Resolved                      | [Container test availability probe is incomplete](./011-container-test-availability-probe-is-incomplete.md)                         | Test infrastructure                                |
| 012 | P2       | Fixed                         | [Patch commit staging window allows stale overwrite](./012-patch-commit-staging-window-allows-stale-overwrite.md)                   | Multi-file patch transaction                       |
| 013 | P2       | Fixed                         | [Container test probes can hang indefinitely](./013-container-test-probes-can-hang-indefinitely.md)                                 | Test infrastructure                                |
| 014 | P2       | Fixed                         | [Patch staging failure leaves temporary files](./014-patch-staging-failure-leaves-temporary-files.md)                               | Multi-file patch transaction                       |
| 015 | P2       | Fixed                         | [Container probe timeout is not a hard deadline](./015-container-probe-timeout-is-not-a-hard-deadline.md)                           | Test infrastructure                                |
| 016 | P3       | Resolved                      | [Patch rollback does not track completed backups](./016-patch-rollback-does-not-track-completed-backups.md)                         | Multi-file patch transaction                       |
| 017 | P1       | Fixed                         | [Create-only writes can replace a concurrent destination](./017-create-only-write-race.md)                                          | Single-file writes                                 |
| 018 | P1       | Fixed                         | [Patch rollback can leave an installed destination](./018-patch-rollback-swallows-destination-removal.md)                           | Multi-file patch rollback                          |
| 019 | P1       | Fixed                         | [list_files can enumerate outside the workspace](./019-list-files-symlink-escape.md)                                                | Directory listing                                  |
| 020 | P1       | Fixed                         | [Local realpath validation has a check/use race](./020-local-path-resolution-symlink-toctou.md)                                     | Local path confinement                             |
| 021 | P1       | Fixed                         | [exec_command cwd can escape through a symlink](./021-shell-cwd-symlink-escape.md)                                                  | Command sessions                                   |
| 022 | P1       | Fixed                         | [Shell analysis misses substitutions and wrappers](./022-shell-analyzer-backtick-wrapper-network-bypass.md)                         | Approval policy                                    |
| 023 | P1       | Fixed                         | [Headless fetches can reach private services](./023-web-fetch-ssrf-redirect-scope.md)                                               | Web and dashboards                                 |
| 024 | P1       | Fixed                         | [Dashboard recipes can replace the captured cwd](./024-dashboard-recipe-arbitrary-cwd.md)                                           | Dashboard refresh                                  |
| 025 | P2       | Resolved                      | [Container runtime CLI operations are unbounded](./025-container-runtime-cli-unbounded.md)                                          | Container backend                                  |
| 026 | P2       | Resolved                      | [Container commands can survive Stop](./026-container-inflight-process-survives-stop.md)                                            | Container shell execution                          |
| 027 | P2       | Fixed                         | [Container paths can escape the workspace mount](./027-container-resolver-symlink-escape.md)                                        | Container path confinement                         |
| 028 | P2       | Resolved                      | [File mutation source reads are unbounded](./028-file-mutation-source-reads-unbounded.md)                                           | Edit/write/patch planning                          |
| 029 | P2       | Fixed                         | [Patch cleanup failures are suppressed](./029-patch-cleanup-failures-suppressed.md)                                                 | Patch cleanup                                      |
| 030 | P2       | Fixed                         | [list_files output is unbounded](./030-list-files-unbounded-output.md)                                                              | Directory listing                                  |
| 031 | P2       | Fixed                         | [index_query accepts an unbounded limit](./031-index-query-limit-unbounded.md)                                                      | Workspace index                                    |
| 032 | P2       | Fixed                         | [Browser snapshot builds the full AX tree](./032-browser-snapshot-full-tree-unbounded.md)                                           | Agent browser                                      |
| 033 | P2       | Fixed                         | [Network response bodies are unbounded](./033-network-response-bodies-unbounded.md)                                                 | Web and dashboards                                 |
| 034 | P2       | Resolved                      | [Dashboard JSON truncation corrupts data](./034-dashboard-json-truncation-corrupts-data.md)                                         | Dashboard persistence                              |
| 035 | P2       | Resolved                      | [Dashboard refresh ignores command failure](./035-dashboard-refresh-ignores-command-failure.md)                                     | Dashboard refresh                                  |
| 036 | P2       | Fixed                         | [Windows Python heredocs regressed under sessions](./036-windows-python-heredoc-session-regression.md)                              | Command sessions                                   |
| 037 | P3       | Resolved                      | [Byte truncation can split UTF-8](./037-utf8-truncation-splits-codepoints.md)                                                       | Output formatting                                  |
| 038 | P3       | Fixed                         | [Listings cannot represent newline filenames](./038-directory-listing-newline-filenames.md)                                         | Directory listing                                  |
| 039 | P3       | Fixed                         | [Command-session completion test is timing-dependent](./039-command-session-test-timing-flake.md)                                   | Test infrastructure                                |
| 040 | P3       | Fixed                         | [CLI-session tests fail on native ABI mismatch](./040-cli-sessions-native-abi-test-failure.md)                                      | Test infrastructure                                |
| 041 | P1       | Resolved                      | [Tool execution ignores the offered tool set](./041-tool-call-availability-not-enforced.md)                                         | Agent tool dispatch                                |
| 042 | P1       | Fixed                         | [Headless fetch is vulnerable to DNS rebinding](./042-headless-fetch-dns-rebinding.md)                                              | Shared safe-fetch transport                        |
| 043 | P1       | Resolved                      | [Shell approval identities drift](./043-shell-approval-identity-drift.md)                                                           | Approval policy and dashboards                     |
| 044 | P1       | Fixed                         | [Revision-checked mutations have a final install race](./044-file-revision-final-install-race.md)                                   | File mutation transactions                         |
| 045 | P1       | Resolved                      | [Consequential browser actions are auto-approved](./045-browser-consequential-actions-auto-approved.md)                             | Browser approval policy                            |
| 046 | P2       | Closed                        | [Local reads materialize the entire file](./046-local-read-materializes-entire-file.md)                                             | Local filesystem reads                             |
| 047 | P2       | Closed                        | [Local safe writes ignore short writes](./047-local-safe-fs-short-write.md)                                                         | Local filesystem writes                            |
| 048 | P2       | Partial                       | [Local runtime and sandbox portability gap](./048-local-tool-runtime-and-sandbox-portability.md)                                    | Local execution backend                            |
| 049 | P2       | Resolved                      | [Command cursors skip model-truncated output](./049-command-session-cursor-skips-truncated-output.md)                               | Command session pagination                         |
| 050 | P2       | Fixed                         | [MCP call lifecycle and output are unbounded](./050-mcp-call-lifecycle-unbounded.md)                                                | MCP client manager                                 |
| 051 | P2       | Fixed                         | [Single-file cleanup failures are suppressed](./051-single-file-cleanup-failures-suppressed.md)                                     | Mutation and command cleanup                       |
| 052 | P2       | Fixed                         | [Database-backed tests are silently skipped](./052-sqlite-integration-tests-silently-skipped.md)                                    | Test infrastructure and CI                         |
| 053 | P3       | Closed                        | [Workspace containment mishandles edge cases](./053-workspace-path-containment-edge-cases.md)                                       | Workspace path resolution                          |
| 054 | P1       | Partial / Deferred by ADR 009 | [Parent symlink swaps can escape local filesystem confinement](./054-local-filesystem-parent-symlink-race.md)                       | Local filesystem backend                           |
| 055 | P1       | Closed                        | [Browser commit approvals are under-scoped](./055-browser-approval-scope-and-classification.md)                                     | Browser approval policy                            |
| 056 | P2       | Fixed                         | [Node pageable reads materialize complete sources](./056-local-pageable-read-streaming-regression.md)                               | Local filesystem reads                             |
| 057 | P2       | Fixed                         | [MCP discovery lacks cancellation and definition bounds](./057-mcp-discovery-lifecycle-and-definition-bounds.md)                    | MCP discovery                                      |
| 058 | P2       | Fixed                         | [Command output caps exclude serialization expansion](./058-command-session-serialized-output-cap.md)                               | Command session rendering                          |
| 059 | P2       | Resolved                      | [Listener subscriptions leak and background tasks remain untitled](./059-maxlisteners-and-title-generation.md)                      | IPC subscriptions and conversation titles          |
| 060 | P3       | Resolved                      | [Generated titles echo greetings or expose reasoning](./060-title-generation-reasoning.md)                                          | Conversation title generation                      |
| 061 | P2       | Implemented                   | [Skill resources resolve against the workspace](./061-skill-resources-resolve-against-workspace.md)                                 | Skill runtime and filesystem roots                 |
| 062 | P2       | Resolved                      | [Failed file writes look successful and encourage repeated revision errors](./062-failed-file-writes-look-successful-and-repeat.md) | File-write feedback and revision recovery          |
| 063 | P2       | Resolved                      | [Todo sidebar stays stale after an agent task-list update](./063-todo-sidebar-stale-after-agent-update.md)                          | Todo sidebar synchronization                       |
| 064 | P2       | Fixed                         | [Whole fan-out rework drops the flag feedback](./064-whole-fanout-rework-drops-feedback.md)                                         | Process fan-out rework                             |
| 065 | P2       | Resolved                      | [Deterministic tool-error feedback coverage](./065-tool-error-feedback-lacks-loop-integration-tests.md)                             | Full agent/process loop tests                      |
| 066 | P1       | Closed                        | [API retries restart process workers](./066-api-retries-restart-process-workers.md)                                                 | Shared model-request recovery                      |
| 067 | P1       | Closed                        | [Interrupted tools risk duplicate effects](./067-interrupted-tools-risk-duplicate-side-effects.md)                                  | Durable tool outcomes and safe resume              |
| 068 | P1       | Closed                        | [Validator errors silently approve phases](./068-validator-errors-silently-approve-phases.md)                                       | Fail-closed review                                 |
| 069 | P2       | Closed                        | [Failures lose stage and attempt context](./069-process-failures-lose-stage-and-attempt-context.md)                                 | Error records and monitor actions                  |
| 070 | P2       | Closed                        | [Tool-free replies do not prove completion](./070-tool-free-replies-do-not-prove-phase-completion.md)                               | Explicit process completion contracts              |
| 071 | P2       | Closed                        | [Tool batches delay feedback and cancellation](./071-tool-batches-delay-error-feedback-and-cancellation.md)                         | Bounded lifecycle and per-call durability          |
| 072 | P1       | Closed                        | [Persist model request retry budgets](./072-persist-model-request-retry-budget.md)                                                  | Durable model-request retry budgets                |
| 073 | P1       | Closed                        | [Wire retry state into runAgentLoop](./073-agent-loop-retry-state-wiring.md)                                                        | Agent-loop retry integration                       |
| 074 | P1       | Resolved                      | [Prevent auto-resume from refreshing model retry budgets](./074-auto-resume-must-not-refresh-model-retry-budget.md)                 | Auto-resume retry accounting                       |
| 075 | P1       | Closed                        | [Define explicit retry budget semantics](./075-explicit-retry-linked-model-budget.md)                                               | Explicit retry accounting                          |
| 076 | P1       | Closed                        | [Add fake-clock tests for model request retries](./076-model-request-retry-fake-clock-tests.md)                                     | Retry deadline and cancellation tests              |
| 077 | P1       | Closed                        | [Persist per-tool-call lifecycle evidence](./077-durable-tool-call-lifecycle.md)                                                    | Durable tool-call lifecycle                        |
| 078 | P1       | Resolved                      | [Distinguish not-started recovery from unknown outcomes](./078-tool-recovery-not-started-vs-unknown.md)                             | Interrupted-tool recovery                          |
| 079 | P1       | Resolved                      | [Preserve stable tool invocation identity](./079-stable-tool-invocation-identity-and-reconciliation.md)                             | Stable tool invocation identity                    |
| 080 | P1       | Resolved                      | [Gate equivalent replay after unknown mutations](./080-block-equivalent-unknown-mutation-replay.md)                                 | Unknown-mutation replay guards                     |
| 081 | P1       | Closed                        | [Record unresolved outcomes on cancellation](./081-cancellation-records-unresolved-tool-outcomes.md)                                | Cancellation outcome persistence                   |
| 082 | P1       | Resolved                      | [Add fault-injection coverage for tool lifecycle recovery](./082-tool-lifecycle-fault-injection-tests.md)                           | Tool-lifecycle fault injection                     |
| 083 | P1       | Closed                        | [Align process worker recovery with tool outcome safety](./083-process-worker-tool-outcome-recovery.md)                             | Process-worker recovery                            |
| 084 | P1       | Closed                        | [Retry validator review without rerunning phase work](./084-validator-review-only-retry.md)                                         | Validator review-only retry                        |
| 085 | P1       | Resolved                      | [Bind validator approval to the reviewed phase output](./085-validator-output-identity-and-stale-review.md)                         | Validator output identity                          |
| 086 | P2       | Closed                        | [Expose validator retry and audited manual override](./086-validator-ui-retry-and-manual-override-audit.md)                         | Validator UI and override audit                    |
| 087 | P2       | Resolved                      | [Add process failure stage fault-injection coverage](./087-process-failure-stage-fault-injection-coverage.md)                       | Failure-stage fault injection                      |
| 088 | P2       | Closed                        | [Preserve distinct tool and API failures in process runs](./088-process-tool-error-then-api-error-distinct-events.md)               | Tool/API failure causality                         |
| 089 | P2       | Closed                        | [Make process recovery states reload-safe](./089-process-recovery-states-survive-reload.md)                                         | Durable process recovery states                    |
| 090 | P2       | Closed                        | [Expose process attempt history in the monitor](./090-process-attempt-history-ui.md)                                                | Process attempt history UI                         |
| 091 | P2       | Closed                        | [Keep process control-flow states out of failure records](./091-process-cancel-and-approval-not-failures.md)                        | Cancellation and approval control flow             |
| 092 | P1       | Closed                        | [Redact and cap process failure diagnostics](./092-process-failure-redaction-and-size-limits.md)                                    | Failure diagnostic sanitization                    |
| 093 | P2       | Closed                        | [Include nested process failure identity in support exports](./093-process-support-export-failure-identity.md)                      | Process support exports                            |
| 094 | P2       | Closed                        | [Handle process failure diagnostic persistence failures honestly](./094-process-failure-db-persistence-fallback.md)                 | Persistence failure diagnostics                    |
| 095 | P2       | Fixed                         | [Reject empty terminal model responses](./095-empty-model-response-reported-as-complete.md)                                         | Conversation completion and model-request recovery |
| 096 | P2       | CLOSED                        | [Preserve model response failure diagnostics](./096-model-response-failure-diagnostics.md)                                          | Model-response evidence and bounded diagnostics    |

## Maintaining the queue

- Add every new brief to this index, initially in OPEN state.
- Keep index statuses synchronized with the brief's frontmatter or Status line.
  Closed, Fixed, and Resolved are completed dispositions. Implemented may retain
  an explicit scope boundary; Partial and Deferred remain unfinished.
- For actionable work, prioritize P1, then P2, then P3, honoring documented
  prerequisites and accepted deferrals. In particular, 054 remains deferred
  until the native helper plan is taken up.
- Before closing a behavioral issue, record regression coverage, verification
  commands/results, limitations, and the implementation reference when available.
  Documentation-only corrections need consistency and link checks.
- For agent/process orchestration, use scripted model responses and injected
  tool/transport failures. Exercise the real shared loop in integration tests;
  mocking `runAgentLoop` alone cannot prove feedback or recovery behavior.
- Require SQLite-backed checks to execute when they are part of the acceptance
  evidence; report skipped environment/platform coverage explicitly.
- Preserve workspace confinement, approval rules, and Electron process
  boundaries. A retry does not grant additional permission.
