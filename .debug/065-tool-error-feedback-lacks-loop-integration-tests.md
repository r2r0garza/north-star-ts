---
status: OPEN
severity: P2
trigger: "Prove that a failed tool call reaches the agent's next model request and permits correction inside a process"
created: 2026-09-01
updated: 2026-09-01
---

# Tool-error feedback lacks deterministic loop integration coverage

## Symptoms and evidence

The reported remote process failed near a `read_file_tool` request for
`CLAUDE.md`. The provided excerpt has no tool result. Its actual failure cause
and the other computer's build are unverified; do not attribute that incident
to a missing file or translation failure without its complete record.

At inspected revision `21bd34d`, the normal feedback path exists:

- `src/main/agent/tools/index.ts`, `runTool`: catches thrown tool exceptions and
  returns error text.
- `src/main/agent/tool-batch-scheduler.ts`, `runBatch`: converts execution
  exceptions into results without cancelling sibling reads.
- `src/main/agent/index.ts`, `runAgentLoop`: appends results as `role: tool`
  messages with the original call ID, persists them, and sends `messages` in the
  next completion request. Unavailable tools and malformed JSON also use this
  result path.
- `src/main/tasks/process/service.test.ts` mocks `runAgentLoop`, so its process
  coverage does not prove actual error delivery to the next model request.

The relevant batch, availability, and read-tool suites passed 19 tests during
the investigation. That is unit evidence, not whole-loop recovery evidence.

## Proposed direction

Keep the production agent loop, process service, dispatcher, and persistence
real. Substitute only external boundaries: a scripted completion transport and
a controlled test tool/environment. Do not mock the very message assembly or
dispatch code this test is intended to verify.

Script the model transport to:

1. Stream a valid tool call with a fixed ID and arguments.
2. On the next request, assert that the exact error and matching ID are present;
   then stream a corrected call with a different ID.
3. Verify its successful result before returning a final answer.

The tool deliberately throws or returns an error on the first call. No live
model, network, credentials, random failure, or probabilistic recovery decision
is required. Test the transport payload as an immutable snapshot at each call;
retaining a reference to the mutable messages array can create false positives.

## Acceptance criteria

- [ ] Cover missing files, returned `ERROR[...]`, thrown tool exceptions,
  unavailable tools, and invalid JSON arguments.
- [ ] Assert one persisted result per call ID and correct next-request ordering.
- [ ] Assert forbidden/unavailable calls never execute their tool body.
- [ ] Exercise an imported Claude-style agent through an actual process worker;
  verify the offered native tool and error feedback, not just a policy helper.
- [ ] A corrected call succeeds and the ordinary phase settles correctly.
- [ ] A failing read does not discard a successful sibling result.
- [ ] Run database integration tests in the required Node-ABI job described in
  [052](./052-sqlite-integration-tests-silently-skipped.md); skipped tests are not
  a passing acceptance result.

## Dependencies and limits

Start this harness first; extend it for [066](./066-api-retries-restart-process-workers.md)
through [071](./071-tool-batches-delay-error-feedback-and-cancellation.md).
It proves software behavior, not that a real model always chooses to recover.
Do not reopen the already-fixed tool availability issue
[041](./041-tool-call-availability-not-enforced.md).

