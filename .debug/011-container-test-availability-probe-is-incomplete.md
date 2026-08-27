# Container test availability probe is incomplete

> Status: **RESOLVED**  
> Severity: **P3 — unreliable test-suite result**  
> Area: container integration test setup

## Problem

`container.test.ts` considers a runtime available when `docker --version` or
`podman --version` succeeds. This proves only that the CLI binary is installed;
it does not prove the daemon/machine is reachable, credentials work, the image
is locally available, or pulling is permitted.

On the current host both CLI version checks succeed, so the suites start and
then fail in `beforeAll`: Docker cannot access image credentials and Podman
cannot reach its socket. The source comment says unavailable runtimes should be
skipped, but the probe does not implement that promise.

## Impact

- `pnpm test` fails for developers who have an installed but inactive runtime.
- Genuine container regressions are harder to distinguish from environment
  setup failures.
- Verification records can disagree depending on transient daemon or credential
  state.

## Reproduction test

Cover availability detection as a pure/injected helper:

1. CLI missing.
2. CLI present but daemon/socket unavailable.
3. Daemon available but requested image unavailable without network access.
4. Fully usable runtime with the configured image.
5. Explicit environment opt-in/opt-out behavior, if adopted.

## Fix direction

Choose one deterministic policy:

- Probe daemon usability and configured-image availability before defining the
  integration suite; or
- Make container integration tests explicitly opt-in through an environment
  flag and fail clearly once opted in.

Avoid silently pulling images during a normal unit-test run unless that behavior
is explicitly documented and requested.

## Acceptance criteria

- [x] A normal test run skips container integration when the runtime is unusable.
- [x] An explicitly enabled container run fails on genuine setup or behavior errors.
- [x] Skip/failure output clearly identifies the unavailable capability.
- [x] Docker and Podman follow the same policy.
- [x] Unit/focused tool tests remain independent of container availability.

## Resolution

Added `checkContainerTestAvailability()` with an injected probe so availability
is covered as pure unit logic. The gate now checks:

1. Runtime CLI is installed.
2. `runtime info` succeeds, covering daemon/socket availability for both Docker
   and Podman.
3. The configured image exists locally via `runtime image inspect`.

The integration suite skips when the runtime is not usable by default. Setting
`COWORK_CONTAINER_TESTS=1` makes the suite run and fail clearly in `beforeAll`
when the requested runtime or image is unavailable. Setting
`COWORK_CONTAINER_TESTS=0` explicitly disables the suite.

Verification:

- `pnpm test src/main/agent/env/container-test-availability.test.ts` — 6 passed.
- `pnpm test src/main/agent/env/container.test.ts` — 1 file / 24 tests skipped
  on the current host.
- `pnpm typecheck` — passed.
