# Command-session completion test relies on fixed wall-clock timing

> Status: **OPEN**
> Severity: **P3 — flaky regression suite**
> Area: command-session tests

## Problem

The completion test starts a child that exits after roughly 280 ms, waits a fixed
250 ms after the tool's initial yield, and requires the next poll to be complete.
Under full-suite load the scheduling margin disappears; the test has failed as
`running` and then passed immediately in isolation.

## Reproduction test

Run the focused test repeatedly under CPU load and with timer jitter. Preserve a
bounded overall test deadline so a real stuck-session regression still fails.

## Fix direction

Poll until a terminal state with a short bounded deadline, or replace the real
timer child with a deterministic command-session handle controlled by the test.

## Acceptance criteria

- The test does not depend on one scheduling instant.
- A genuinely non-terminating session still fails quickly.
- Repeated focused and full-suite runs remain green.
