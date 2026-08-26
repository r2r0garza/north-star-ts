# Dashboard command recipes can replace the captured workspace cwd

> Status: **FIXED**  
> Severity: **P1 — durable execution scope injection**  
> Area: dashboard authoring and refresh

## Problem

`withCwd` preserves an explicit `recipe.cwd` supplied by the model. Refresh later
passes that value to `createEnvironment` as its workspace and scopes an allowlist
grant to it. A dashboard authored in one workspace can therefore request a
durable command rooted at an unrelated host directory.

## Reproduction test

Author a dashboard in workspace A with `recipe.cwd` set to external directory B.
Assert the stored recipe is bound to A and approval cannot create a grant for B.

## Fix direction

For command recipes, overwrite `cwd` with the server-owned `ctx.workspace`; reject
command recipes when no workspace exists. Validate legacy recipes during refresh
against a persisted workspace identity before execution.

## Acceptance criteria

- Model-supplied cwd never changes the recipe execution root.
- Legacy mismatches become stale and require re-authoring.
- Approval display and allowlist scope show the server-bound workspace.
