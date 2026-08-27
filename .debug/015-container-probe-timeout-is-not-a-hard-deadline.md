# Container probe timeout is not a hard deadline

> Status: **FIXED**  
> Severity: **P2 — test discovery can still block indefinitely**  
> Area: container integration test availability probes

## Problem

Container availability probes now pass a five-second `timeout` to
`execFileSync`, but they leave `killSignal` at Node's default of `SIGTERM`.

When a synchronous child reaches its timeout, Node sends the configured signal
and waits for the child process to exit before returning. A process that catches,
handles, or ignores `SIGTERM` can therefore remain alive and keep
`execFileSync` blocked beyond the advertised deadline.

The existing regression test verifies that the timeout option is supplied and
that an injected `ETIMEDOUT` result is classified correctly. It does not verify
that a stubborn subprocess actually terminates within a bounded interval.

## Impact

- A misbehaving Docker/Podman CLI or wrapper can still freeze test discovery.
- CI can consume its outer job timeout despite the reported five-second probe
  deadline.
- The bug 013 resolution promises a finite timeout that the current process
  termination contract does not guarantee.

## Reproduction test

Use a small fixture subprocess or executable that installs a `SIGTERM` handler
and deliberately remains alive:

1. Run it through the same synchronous probe runner with a short test deadline.
2. Confirm the current default-signal implementation does not return at the
   nominal timeout.
3. Apply the hard-termination strategy and assert the runner returns within a
   bounded allowance above the configured deadline.
4. Assert the result is classified as timed out and names the runtime, command,
   and deadline.
5. Cover the platform-specific behavior expected on macOS, Linux, and Windows
   without relying on a real container daemon.

The regression itself must have an independent outer timeout so a broken
implementation cannot hang the test suite indefinitely.

## Fix direction

- Use a termination strategy that cannot be indefinitely deferred by the probe
  child, such as an appropriate hard-kill signal where supported.
- If cross-platform behavior requires asynchronous supervision, send graceful
  termination first and escalate to a hard kill after a short grace period.
- Keep timeout classification distinct from ordinary nonzero exits and missing
  executables.
- Test bounded wall-clock completion, not only the options passed to
  `execFileSync`.

## Acceptance criteria

- A probe that ignores graceful termination cannot block indefinitely.
- The observed completion time is bounded by the configured timeout plus a
  documented, short termination allowance.
- Timed-out probes retain the existing default-skip and explicit-opt-in failure
  behavior.
- Timeout reasons identify the runtime, probe command, and configured deadline.
- Docker and Podman follow the same cross-platform termination policy.
- Successful, missing-CLI, inactive-daemon, and missing-image probes remain
  unchanged.

## Resolution

- Extracted the production subprocess boundary into `runContainerTestProbe` so
  its real timeout behavior can be exercised without Docker or Podman.
- Configured every Docker and Podman availability probe to use `SIGKILL` when
  the shared five-second deadline expires. Node supports this hard-termination
  signal on macOS, Linux, and Windows.
- Added a supervised regression worker that runs the production probe against a
  Node subprocess that ignores `SIGTERM`. The worker verifies wall-clock
  completion within the probe deadline plus a one-second allowance and retains
  the existing `ETIMEDOUT` classification.
- Gave the regression worker an independent three-second outer `SIGKILL`
  deadline so a future synchronous-runner regression cannot hang Vitest.
- Kept the existing default-skip, explicit-opt-in failure, missing executable,
  inactive runtime, missing image, and successful probe behavior intact.

## Verification

- `pnpm vitest run src/main/agent/env/container-test-availability.test.ts src/main/agent/env/container-test-availability.deadline.test.ts src/main/agent/env/container-test-availability.deadline-worker.test.ts src/main/agent/env/container.test.ts`
- `pnpm typecheck`
