# Container command processes can survive Stop and timeout

> Status: **RESOLVED**  
> Severity: **P2 — orphaned execution**  
> Area: ContainerEnvironment shell execution

## Problem

Interrupt and kill terminate the host Docker/Podman `exec` client, not reliably
the process group running inside the shared container. The tool can report a
stopped or timed-out command while that command continues mutating files or
consuming resources.

## Reproduction test

Start a command that writes a delayed sentinel from a child process, Stop or time
it out, then wait past the delay and assert the sentinel was never created. Cover
session interrupt, force kill, turn abort, and compatibility execution.

## Fix direction

Implement `.plan/005.1`: track an in-container PID/process group and explicitly
kill it through a separate runtime exec path. Cleanup must itself be bounded.

## Acceptance criteria

- No inner process or grandchild survives Stop, timeout, or disposal.
- Host and container session status reflects confirmed termination.
- This brief closes only when `.plan/005.1` verification passes.

## Resolution

- Added an in-container Python command supervisor for `ContainerEnvironment.exec`
  and `ContainerEnvironment.spawnCommand`. It starts the model command in a new
  process group, records the process-group id in a per-command file under `/tmp`,
  and removes the file when the command exits normally.
- Added bounded cleanup through a separate runtime exec path. Timeout, abort,
  session interrupt, and session kill now signal the recorded in-container
  process group instead of only killing the host Docker/Podman `exec` client.
- Added an `onTerminate` hook to the shared process capture helper so captured
  container commands wait for backend-specific cleanup before resolving.
- Added regression coverage for bounded cleanup without a container daemon and
  integration coverage for delayed sentinel writes after exec timeout and command
  session kill.

## Verification

- `pnpm exec tsc --noEmit -p tsconfig.json --pretty false`
- `pnpm exec vitest run src/main/agent/env/spawn-util.test.ts src/main/agent/env/container.test.ts`

The final focused run was executed outside the filesystem/network sandbox so the
test process could reach the local Docker and Podman daemons. It passed all fake
runtime, Docker, and Podman cases.
