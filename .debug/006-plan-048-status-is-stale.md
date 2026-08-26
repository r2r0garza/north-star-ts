# Plan 048 status does not reflect its implementation

> Status: **RESOLVED**  
> Severity: **P3 — documentation drift**  
> Area: `.plan` tracking

## Problem

`.plan/048-ripgrep-search.md` still declares `Status: NOT STARTED`, while
`.plan/ROADMAP.md` describes the ripgrep-backed search as implemented and the
branch contains its implementation and tests.

## Impact

- The standalone plan and roadmap disagree about project state.
- A future contributor may attempt to schedule or reimplement completed work.
- Search hardening gaps can be confused with the entire phase being absent.

## Fix direction

- Change the standalone plan status to the repository's chosen completed label.
- Add a concise implementation note matching the roadmap entry.
- Preserve the unresolved items as explicit follow-ups, especially packaged-app
  smoke coverage and the spawn-failure issue in debug brief `003`.

## Acceptance criteria

- Plan `048` and the roadmap report the same implementation status.
- Remaining search gaps are listed as follow-ups, not hidden by the completed
  status.
- No unrelated roadmap ordering or history is changed.

## Resolution

- `.plan/048-ripgrep-search.md` now reports `Status: DONE`, matching the roadmap.
- The standalone plan has a concise implementation note aligned with the roadmap
  Done entry.
- Remaining gaps are explicit follow-ups, including packaged-app smoke coverage,
  the spawn-failure regression behavior resolved by debug brief `003`, and
  container coverage in a Docker/Podman-capable environment.
