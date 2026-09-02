---
status: CLOSED
severity: P2
trigger: "A tool error followed by a model/API error can still be misread as one collapsed phase failure"
created: 2026-09-02
updated: 2026-09-02
---

# Preserve distinct tool and API failures in process runs

## Evidence

[069](./069-process-failures-lose-stage-and-attempt-context.md) requires that a
tool error followed by an API/model error appears as two distinct events. The
current structured process failure slice stores the terminal phase failure, but
does not yet prove that an earlier tool failure in the transcript remains
separate from the later model request failure.

## Proposed direction

Create an integration test where a process worker receives a structured tool
error result, persists it in the transcript/tool lifecycle, then the next model
request fails. The process monitor and task event history should show both
facts: the tool failed at the tool boundary, and the phase finally failed at the
model/request boundary.

Do not infer the failing stage from the last visible tool request. The terminal
failure should link to the model/API attempt, while the tool failure remains
inspectable through the worker transcript and tool-call lifecycle.

## Acceptance criteria

- [x] A process worker test produces a tool error and then a model/API error.
- [x] The tool failure and API failure are persisted as separate durable records/events.
- [x] The phase's terminal `FailureContext.stage` reflects the actual terminal boundary.
- [x] The UI/monitor can render or navigate to both records without blaming the wrong boundary.
- [x] Regression coverage fails if human-readable error parsing is used to infer stage.

## Likely files and dependencies

`src/main/agent/index.ts`, `src/main/agent/tool-error-feedback.integration.test.ts`,
`src/main/db/repositories/tool-call-lifecycle.ts`,
`src/main/tasks/process/service.ts`, process scheduler tests, and process monitor
display code. Coordinates with [077](./077-durable-tool-call-lifecycle.md) and
[083](./083-process-worker-tool-outcome-recovery.md).
