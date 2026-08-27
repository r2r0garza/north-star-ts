# PR53: Linux Local sandbox adapter

> Status: **NOT STARTED**. Deferred security hardening. Containers remain the
> supported cross-platform sandbox path for Linux until this ships.

## Context

`052` made Local runtime profiles honest: `host-access` is always available,
while stronger `read-only` and `workspace-write` profiles are only offered when a
dependable OS adapter exists. Today that adapter exists only on macOS through
`sandbox-exec`; Linux users who need an enforced boundary should use Docker or
Podman.

This plan tracks a future native Linux adapter so Local can enforce the same
profile labels without requiring a container runtime.

## Goal

Add a Linux-only Local sandbox adapter that can enforce `read-only` and
`workspace-write` for shell/session commands with filesystem, network, and
process-tree guarantees strong enough to be used as an approval auto-approve
boundary.

## Scope

- Detect Linux adapter availability at runtime and fail closed when unavailable.
- Enforce `read-only`: no filesystem writes and no network access.
- Enforce `workspace-write`: writes limited to the resolved workspace plus
  approved temp scratch locations; no network access by default.
- Keep file tools routed through `Environment` path validation so direct
  filesystem operations cannot bypass the selected profile.
- Preserve process-tree cleanup on timeout, abort, and Stop.
- Surface clear Settings copy: unavailable Linux Local sandbox => use
  Docker/Podman or explicit host access.

## Candidate adapters

Decision required before implementation:

- **Bubblewrap / namespaces**: strongest practical candidate when available, but
  distribution/install availability varies and unprivileged namespaces may be
  disabled.
- **Landlock**: promising filesystem restrictions from the app process, but
  kernel/API coverage and network restriction story need validation.
- **seccomp + namespaces**: likely too much native surface unless wrapped by an
  existing tool.

The adapter must be a real OS-enforced boundary. Regex classifiers, cwd, and
approval prompts are not acceptable substitutes.

## Implementation areas

- `src/main/agent/env/local-profiles.ts`: add Linux capability probe and adapter
  selection.
- `src/main/agent/env/local.ts`: wrap `exec` and `spawnCommand` with the Linux
  adapter when a stronger Local profile is active.
- Settings UI: explain why a Linux Local profile is unavailable and recommend
  Docker/Podman.
- Tests: add Linux enforcement probes that are skipped only when the profile is
  explicitly unsupported.

## Verification

- `host-access` remains direct host execution.
- `read-only` blocks filesystem writes inside and outside the workspace.
- `workspace-write` allows workspace writes and blocks writes outside workspace
  and temp scratch.
- Network probes fail under both stronger profiles.
- Symlink/path escape attempts fail.
- Child processes cannot outlive timeout/abort/Stop.
- Unsupported Linux hosts fail closed before command execution.

## Out of scope

- Replacing Docker/Podman as the recommended Linux sandbox path before this
  adapter is proven.
- Sandboxing external CLI providers beyond the Local environment seam.
- Building a custom Linux distribution, VM, or long-lived container manager.
