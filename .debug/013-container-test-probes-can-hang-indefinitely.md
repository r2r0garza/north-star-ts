# Container test probes can hang indefinitely

> Status: **FIXED**  
> Severity: **P2 — test discovery can block indefinitely**  
> Area: container integration test setup

## Problem

`checkContainerTestAvailability` runs synchronous Docker or Podman probes for
the CLI version, daemon information, and configured-image inspection. The
default `execFileSync` call has no timeout.

An installed CLI can block while waiting for an unhealthy daemon, an
unresponsive Podman machine, a remote Docker context, a credential helper, or
another runtime dependency. Because availability is checked while the
integration suite is defined, a stalled probe can prevent Vitest from finishing
test discovery and it will neither skip the suite nor report a useful setup
failure.

## Impact

- `pnpm test` or a focused container test can hang without a bounded result.
- CI jobs can consume their entire outer timeout before identifying the probe.
- Developers cannot distinguish a slow runtime probe from a frozen test runner.
- The opt-in policy added for bug 011 cannot provide its promised clear failure
  when the availability check itself never returns.

## Reproduction test

Exercise the command-execution boundary with an injected or wrapped runner:

1. Simulate a `--version` probe that exceeds the configured deadline.
2. Repeat for `runtime info` and `runtime image inspect`.
3. Assert a default test run returns unavailable and skips with a reason that
   names the timed-out probe.
4. Assert `COWORK_CONTAINER_TESTS=1` requests the suite and produces a clear
   setup failure with the same timeout reason.
5. Verify successful probes and ordinary nonzero/`ENOENT` failures retain their
   existing behavior.

## Fix direction

- Give every `execFileSync` probe a short, explicit timeout.
- Treat timeout termination as an unavailable capability and include the
  runtime, probe command, and deadline in the reason.
- Keep the probe runner injectable so timeout behavior can be tested without a
  real Docker or Podman daemon.
- Consider bounding captured diagnostic output as well if stderr is enabled for
  clearer failure messages.
- Use the same timeout policy for Docker and Podman.

## Acceptance criteria

- Every availability subprocess has a finite timeout.
- A timed-out probe returns a deterministic availability result rather than
  blocking test discovery.
- Default runs skip unavailable container integration after a timeout.
- Explicitly enabled runs fail clearly and identify which probe timed out.
- Docker and Podman use the same deadline and reporting contract.
- Missing CLI, inactive daemon, missing image, opt-out, and successful-runtime
  behavior remain covered.

## Resolution

- Added a shared 5s timeout to every Docker/Podman availability probe.
- Timeout failures now return unavailable with a reason that names the runtime,
  probe command, and deadline.
- Covered timed-out `--version`, `info`, and `image inspect` probes, explicit
  opt-in failure behavior, and the default subprocess timeout options.

## Verification

- `pnpm vitest run src/main/agent/env/container-test-availability.test.ts`
- `pnpm typecheck`
