# Combined process output loses stdout/stderr event order

> Status: **RESOLVED**  
> Severity: **P2 — incorrect command output**  
> Area: shared process capture

## Problem

`captureSpawn` now retains stdout and stderr in separate arrays so search callers
can inspect stderr independently. At process close it reconstructs the historical
combined `ExecResult.stdout` value by concatenating the complete stdout buffer
before the complete stderr buffer.

This loses the order in which chunks actually arrived. A child that emits
`stdout:out-1`, then `stderr:err-1`, then `stdout:out-2` is returned as
`out-1out-2err-1`.

The `ExecResult` contract still describes `stdout` as the raw combined
stdout/stderr bytes. Consumers include Local and container `Environment.exec`,
dashboard recipes, git context extraction, Claude Code detection, and legacy
shell compatibility paths.

## Impact

- Compiler, test, and script diagnostics can appear after output that was
  actually emitted later.
- Logs can become misleading when stderr explains or qualifies adjacent stdout.
- Existing consumers relying on the historical combined ordering receive a
  silent behavioral regression.

## Reproduction test

Add focused coverage for `captureSpawn`:

1. Spawn a deterministic child that writes `out-1` to stdout.
2. After a short delay, write `err-1` to stderr.
3. After another delay, write `out-2` to stdout and exit.
4. Assert `result.stdout` is `out-1err-1out-2`.
5. Assert `result.stderr` remains `err-1`.

Also verify ordering when the shared byte cap truncates the final chunk.

## Fix direction

- Maintain an event-ordered combined chunk list in addition to the
  stream-specific stderr list.
- Apply one shared byte budget consistently at arrival time.
- Preserve separate stderr without reconstructing the combined result after the
  process exits.
- Keep UTF-8 decoding at the consumer boundary; capture should remain byte based.

## Acceptance criteria

- Combined output preserves observed stdout/stderr chunk order.
- `stderr` contains only captured stderr bytes.
- The shared byte cap is applied deterministically without exceeding its limit.
- Spawn errors, timeout, abort, and signal metadata remain unchanged.
- Local/container exec and search regression tests continue to pass.
