# Container runtime CLI operations have no production bounds

> Status: **RESOLVED**  
> Severity: **P2 — hung turn and memory exhaustion**  
> Area: ContainerEnvironment runtime operations

## Problem

`runtimeCli` buffers all stdout/stderr and waits indefinitely for Docker or
Podman. It backs container startup, lifecycle, file operations, capability
probes, and fallback search. A hung daemon wedges the Electron main process; a
large response can exhaust memory.

## Reproduction test

Inject runtime children that never exit, ignore graceful termination, or emit
output beyond the cap. Exercise startup, read, write, readdir, search probing,
and disposal.

## Fix direction

Replace the ad hoc collector with a shared supervised runner: per-operation hard
deadlines, bounded stdout/stderr, abort propagation, force kill, and explicit
truncation/failure results. Give file reads caller-controlled limits.

## Acceptance criteria

- Every runtime operation has a documented deadline and byte cap.
- Abort and timeout always settle and reap the host runtime process.
- Truncated data is never parsed or reported as a successful complete result.

## Resolution

- Added `captureProcess` alongside `captureSpawn` in `src/main/agent/env/spawn-util.ts`
  so machine-readable runtime subprocesses share timeout, abort, hard-kill, and
  byte-cap handling while preserving separate stdout/stderr.
- Replaced `ContainerEnvironment.runtimeCli`'s unbounded collector with the
  supervised runner. Defaults are documented in `src/main/agent/env/container.ts`:
  ordinary runtime calls use 30s/1 MiB, startup uses 60s, image pulls use 5m/4
  MiB, and full-file base64 reads use 16 MiB.
- Runtime CLI results now fail before parsing JSON/stat/base64 data when the
  subprocess times out, is aborted, fails to spawn, or exceeds the cap.
- Added focused fake-runtime regression tests for hung startup, truncated JSON,
  truncated file base64, and abort propagation through the search capability
  probe.

## Verification

- `pnpm exec vitest run src/main/agent/env/spawn-util.test.ts src/main/agent/env/container.test.ts`
- `pnpm exec tsc --noEmit -p tsconfig.json`
