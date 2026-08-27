# Shell approval identity omits environment state and diverges from dashboards

> Status: **RESOLVED**
> Severity: **P1 — durable approval scope mismatch**
> Area: shell analysis, allowlist, and dashboard refresh

## Problem

Shell analysis strips leading assignments plus `env`, `sudo`, and wrapper
metadata before constructing its structured identity. Commands whose behavior
changes through `PATH`, `LD_PRELOAD`, `GIT_SSH_COMMAND`, proxy variables,
credentials, or wrapper options can therefore share one supposedly exact
allowlist identity.

Dashboard command recipes additionally reconstruct their action with
`normalizeCommand(recipe.command)`, while live command tools use the structured
shell-analysis identity. A durable approval created by the command tool may be
reported as stale or fail to match the corresponding dashboard recipe.

## Reproduction test

Approve `PATH=/trusted git status` as an exact action, then evaluate
`PATH=/untrusted git status` and assert it does not match. Cover behaviorally
relevant `env`, wrapper, and Git environment variables. Create a dashboard from
an approved command action and assert refresh reconstructs the identical
`(kind, identity)` tuple without hand-seeding a legacy normalized identity.

## Fix direction

Create one canonical shell-action builder used by command execution, approval
persistence, dashboard creation, and dashboard refresh. Preserve normalized raw
command state or explicitly include every behaviorally relevant assignment and
wrapper option. Continue using the effective executable separately for risk and
network classification.

## Acceptance criteria

- Commands that differ in behavior-changing environment or wrapper state have
  different exact identities.
- Equivalent formatting and quoting normalize consistently where safe.
- Live shell actions and dashboard recipes construct the same identity.
- Existing durable rules are migrated, invalidated, or versioned explicitly.

## Resolution

- Shell identities are now versioned (`version: 2`) and include each parsed
  segment's full `rawArgv` before assignment/wrapper stripping.
- The effective executable/argv remains separate for risk and network
  classification.
- `shellActionForCommand()` is the canonical action builder used by live command
  execution and dashboard recipes.
- Existing durable shell approvals using the old identity shape are invalidated
  by the versioned identity change and must be re-approved.
