# PR54: Windows Local sandbox adapter

> Status: **NOT STARTED**. Deferred security hardening. Containers remain the
> supported cross-platform sandbox path for Windows until this ships.

## Context

`052` made stronger Local runtime profiles fail closed unless the platform has a
dependable OS adapter. macOS currently has an adapter through `sandbox-exec`;
Windows does not. The local filesystem/search helpers no longer depend on
`python3`, but shell/process/network isolation is still not available locally on
Windows.

Windows users who need an enforced sandbox should use Docker or Podman for now.

## Goal

Add a Windows-only Local sandbox adapter that can enforce `read-only` and
`workspace-write` for shell/session commands with filesystem, network, and
process-tree guarantees strong enough to be used as an approval auto-approve
boundary.

## Scope

- Detect Windows adapter availability at runtime and fail closed when
  unavailable.
- Enforce `read-only`: no filesystem writes and no network access.
- Enforce `workspace-write`: writes limited to the resolved workspace plus
  approved temp scratch locations; no network access by default.
- Ensure full process-tree cleanup for `cmd.exe`, PowerShell, and spawned child
  processes.
- Keep file tools routed through `Environment` path validation so direct
  filesystem operations cannot bypass the selected profile.
- Surface clear Settings copy: unavailable Windows Local sandbox => use
  Docker/Podman or explicit host access.

## Candidate adapters

Decision required before implementation:

- **Job Objects**: useful for process-tree lifetime, CPU/memory limits, and
  cleanup; insufficient alone for filesystem/network isolation.
- **AppContainer / restricted tokens**: possible isolation primitive, but likely
  requires a packaged native helper and careful filesystem capability mapping.
- **Windows Defender Firewall / WFP rules**: possible network control, but must
  avoid global machine-wide side effects and require no elevated privileges.

The adapter must be a real OS-enforced boundary. Regex classifiers, cwd, and
approval prompts are not acceptable substitutes.

## Implementation areas

- Add a small native helper or proven library if Node/Electron cannot access the
  required Windows primitives safely.
- `src/main/agent/env/local-profiles.ts`: add Windows capability probe and
  adapter selection.
- `src/main/agent/env/local.ts`: wrap `exec` and `spawnCommand` with the Windows
  adapter when a stronger Local profile is active.
- Settings UI: explain why a Windows Local profile is unavailable and recommend
  Docker/Podman.
- Tests: add Windows enforcement probes that are skipped only when the profile is
  explicitly unsupported.

## Verification

- `host-access` remains direct host execution.
- `read-only` blocks filesystem writes inside and outside the workspace.
- `workspace-write` allows workspace writes and blocks writes outside workspace
  and temp scratch.
- Network probes fail under both stronger profiles without requiring global
  machine firewall changes.
- Symlink/junction/path escape attempts fail.
- Child processes cannot outlive timeout/abort/Stop.
- Unsupported Windows hosts fail closed before command execution.

## Out of scope

- Treating Job Objects alone as a complete sandbox.
- Replacing Docker/Podman as the recommended Windows sandbox path before this
  adapter is proven.
- Sandboxing external CLI providers beyond the Local environment seam.
