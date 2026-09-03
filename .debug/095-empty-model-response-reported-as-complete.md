---
status: Fixed
severity: P2
trigger: "An interactive conversation ends with an empty assistant message and a turn-complete notification before performing the requested work"
created: 2026-09-02
updated: 2026-09-02
---

# Reject empty terminal model responses

## Evidence and scope

Conversation `ab472ae6-08a6-48cf-8d56-ff9e875b8ef5`, titled
`Refresh Project Roadmap`, requested a freshness check/update of
`.plan/ROADMAP.md`. Read-only inspection of the closed app's
`~/Library/Application Support/north-star/cowork.db` found:

- Messages 1-20 contain inspection, tool calls, and tool results. No editing
  tools ran; the only shell command was `git log --oneline -50`.
- Three `search_tool` calls used `.plan/ROADMAP.md` as a directory and failed.
  These are invalid arguments under the documented tool contract. Two reads
  succeeded afterward, and the agent requested another model round.
- Message 21 has `content = ''` and no tool calls.
- Budget `after-seq:20` is `completed`, with one attempt, no recorded error,
  and approximately 156 seconds from first attempt to completion.

The code accepts a tool-free response as final even when its text is empty.
The renderer sends `turnComplete` for a result with neither error nor stop.
A read-only probe executing the real retry coordinator with an injected
repository reproduced acceptance of an empty stream, an empty `stop` response,
an empty `length` response, and a synthetic reasoning-only response. Each
returned without an error or retry. This probe was not a full-loop test.

This confirms an application validation bug. It does not prove that the
provider sent zero bytes: raw chunks, terminal reason, and usage were not
persisted. See [096](./096-model-response-failure-diagnostics.md).

## Intended behavior

A native model round may finish the conversation only with non-whitespace
user-visible text after tool-call recovery, or another explicitly supported
outcome. Earlier commentary is not a final answer. A valid tool-only round
continues execution normally. Do not require a file change to prove success:
a legitimate audit may conclude that the roadmap needs no changes.

| Response condition                                                | Planned handling                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Empty/whitespace text, no calls, `stop` or no finish reason       | Retry the same model round within its existing durable budget; surface failure when exhausted.                                      |
| Empty text, no calls, `length`                                    | Surface an actionable output-limit failure immediately; do not automatically retry the unchanged request.                           |
| Explicit filter/refusal indication with no usable answer          | Surface a clear non-transient failure; do not retry to bypass a refusal.                                                            |
| Empty text and an unknown explicit finish reason                  | Surface an unsupported-response failure with bounded diagnostics rather than guessing success or retryability.                      |
| Valid structured or recovered text tool calls, no prose           | Preserve tool execution and existing malformed/truncated-call handling.                                                             |
| No calls while owned background commands are pending              | Remain in the existing command wait flow; empty intermediate text is not completion and need not create a blank transcript message. |
| User cancellation, including during stream consumption or backoff | Preserve the stopped outcome; no retry or completion notification.                                                                  |

Nonempty text-only truncation retains its current behavior in this fix. General
stream protocol validation and semantic verification of arbitrary chat tasks
are separate work. The process-only contract in
[070](./070-tool-free-replies-do-not-prove-phase-completion.md) stays unchanged.

## Original implementation sequence

1. Add scripted regression cases before changing behavior. Exercise the real
   `runAgentLoop`, not just a mocked result or the stream accumulator.
2. Add typed response-validation failures. Validate after text normalization
   and tool-call recovery but inside the request retry boundary. A validation
   callback supplied by the loop can keep the retry coordinator independent
   of tool recovery and command ownership. Reuse the same normalization for
   validation and execution so their definitions of an empty round agree.
3. Give only the specified transient empty-response cases automatic retries.
   Retain the existing round ID, persisted attempt count, deadline, and backoff.
   Never append a blank assistant message, mark the round completed, execute
   calls, or emit abandoned text before acceptance. Previously settled tools
   must not run again when retrying this request.
4. Integrate final failure with `failTurn` and existing error/result handling.
   Persist a visible explanation such as "The model returned no usable answer.
   The turn ended before it could finish." Classify output-limit failures
   separately. Exhausted/deterministic failures return `retryable: false` to
   prevent outer task/process runners from granting another automatic budget.
   Explicit user retry keeps the linked-budget semantics from
   [075](./075-explicit-retry-linked-model-budget.md).
5. Guard the renderer's terminal-result handling: an unexpected empty success
   result must produce visible failure feedback and `turnError`, never
   `turnComplete`. Base this on the terminal result, not earlier streamed
   commentary. Check all `ChatResult` variants before adding the guard so
   supported non-content outcomes keep their intended behavior.
6. Split the bounded diagnostic work into
   [096](./096-model-response-failure-diagnostics.md). That follow-up remains
   open after this fix.

The 120-second retry budget currently controls admission of subsequent
attempts, not a hard timeout for an in-flight request. A 156-second first
attempt is therefore not proof of a timeout bug. If an empty attempt returns
after the deadline, fail without a new automatic attempt. Do not reset the
budget or add a hard request timeout as part of this fix.

## Likely files

- `src/main/agent/model-request-retry.ts` and its tests: response validation
  inside retries, typed error handling, fake-clock coverage.
- `src/main/agent/index.ts`: acceptance, command-wait exception, durable error
  propagation, and no empty terminal transcript writes.
- `src/main/agent/tool-error-feedback.integration.test.ts`: real loop and DB.
- `src/renderer/src/App.tsx` and focused renderer tests: terminal result and
  notification behavior, including defense against an empty IPC success.
- Existing retry repository/tests only if needed to preserve budget semantics;
  this brief does not require a schema change.

## Acceptance and verification

- [x] Empty/whitespace responses retry without changing logical round identity;
      empty then valid succeeds, while repeated empty responses exhaust the budget.
- [x] Empty `length` and filter/refusal outcomes fail without automatic retries.
- [x] A late empty first attempt does not obtain another attempt after expiry.
- [x] Valid tool-only replies, recovered text calls, and ordinary final prose
      retain their behavior; truncated tool calls still never execute.
- [x] Cancellation during streaming/backoff remains stopped and silent.
- [x] A pending command can complete and resume the loop without early failure,
      duplicate command execution, or a premature completion notification.
- [x] A script matching the incident (reads, failed searches, empty final round)
      either recovers to a real final response or stores a visible failure. Earlier
      preambles cannot mask the empty terminal response.
- [x] Completed tools are not replayed, no empty terminal message is persisted,
      and exhausted budgets stay exhausted across automatic resume.
- [x] Renderer tests prove one error notification and no completion notification
      on failure, normal completion on success, and silence on cancellation.
- [x] A shared-loop process worker exposes failure without releasing dependents
      or receiving a fresh outer automatic retry budget.

## Implementation references

- `src/main/agent/model-request-retry.ts` adds `ModelResponseValidationError`
  and runs a loop-supplied `validateRound` callback inside the durable retry
  boundary before accepting a completed stream.
- `src/main/agent/index.ts` validates empty terminal responses after structured
  and recovered text tool-call handling. Empty `stop`/EOF responses retry inside
  the existing logical round; empty `length`, `content_filter`, and unknown
  finish reasons fail without automatic retry. Empty command-wait replies no
  longer persist blank assistant messages.
- `src/renderer/src/lib/chat-result.ts` and `src/renderer/src/App.tsx` route an
  unexpected empty success result to visible error handling and `turnError`
  notification instead of `turnComplete`.
- Regression coverage was added in
  `src/main/agent/model-request-retry.test.ts`,
  `src/main/agent/tool-error-feedback.integration.test.ts`, and
  `src/renderer/src/lib/chat-result.test.ts`.

## Verification results

Initial SQLite-required verification failed because the local `better-sqlite3`
native module was compiled for Node module ABI 136 while the test runner needed
ABI 137. Rebuilding with `pnpm rebuild better-sqlite3` fixed the local test
environment.

Passed on 2026-09-02:

```sh
COWORK_REQUIRE_SQLITE_TESTS=1 pnpm exec vitest run src/main/agent/model-request-retry.test.ts src/main/agent/tool-error-feedback.integration.test.ts src/main/db/repositories/model-request-retry-budgets.test.ts
pnpm exec vitest run src/renderer/src/lib/chat-result.test.ts
pnpm run typecheck
```

The diagnostics work tracked in [096](./096-model-response-failure-diagnostics.md)
remains open. This fix prevents empty terminal responses from being reported as
successful completion; it does not add bounded provider-response diagnostics.
