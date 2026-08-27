# Local tools depend on system Python and lack cross-platform sandbox parity

> Status: **OPEN**
> Severity: **P2 — foundational runtime and isolation gap**
> Area: local execution backend

## Problem

Local safe filesystem and search operations depend on a `python3` executable
being installed and discoverable. Windows local filesystem tooling is disabled,
and strong local read-only/workspace-write profiles are available only on macOS
through `sandbox-exec`. Other platforms fall back to a container or host access.

The default backend is local host access. In that mode, approval policy and
shell classification help the user make decisions but cannot substitute for an
OS-enforced boundary, especially when Auto mode is deliberately enabled.

## Reproduction test

Exercise foundational reads, writes, search, and commands on supported macOS,
Linux, and Windows runners without assuming a system Python installation. For
each advertised sandbox profile, attempt writes outside the workspace, forbidden
reads, network access, child-process escape, and termination of process trees.

## Fix direction

Bundle or implement the foundational filesystem/search helper as an application
runtime dependency rather than relying on arbitrary host Python. Add dependable
Linux and Windows sandbox adapters, or clearly mark unsupported profiles and
fail closed instead of silently weakening requested isolation. Treat command
regexes as classification and approval UX, not the security boundary.

## Acceptance criteria

- Foundational tools do not require an undocumented system executable.
- Every advertised sandbox profile has tested filesystem, network, and process
  enforcement on its supported platforms.
- A requested unavailable sandbox fails closed with a clear recovery path.
- Documentation distinguishes approval, classification, and OS isolation.
