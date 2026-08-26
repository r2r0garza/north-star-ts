# exec_command cwd can resolve outside the workspace through a symlink

> Status: **FIXED**  
> Severity: **P1 — execution scope mismatch**  
> Area: command sessions and approval

## Problem

`startCommand` applies only `resolveInWorkspace` to `cwd`. On Local, a relative
workspace path that is an external symlink becomes the child process working
directory outside the workspace. The approval analysis and displayed action do
not contain the resolved real destination.

## Reproduction test

Point `workspace/link` at an external directory, request `cwd: "link"`, and run a
command that prints its working directory. Assert execution is rejected before
the approval gate and no session is created.

## Fix direction

Construct the active environment before analysis and resolve `cwd` through
`await env.resolve`. Bind the approved identity to the validated environment path
and revalidate immediately before spawning.

## Acceptance criteria

- External symlink cwd values are rejected on Local and Container.
- Approval and execution use the same resolved cwd.
- Normal nested workspace cwd values continue to work.

## Resolution

- `exec_command`/`run_shell_tool` command sessions now build the active
  environment before approval, resolve `cwd` through `env.resolve`, and include
  the resolved workspace/cwd in approval detail.
- The command session revalidates the same `cwd` immediately before spawning and
  rejects if the resolved identity changed after approval.
- `ContainerEnvironment.resolve` now follows real paths inside the container and
  rejects paths that leave `/workspace`.

## Verification

- `npm test -- src/main/agent/tools/command_session_tools.test.ts`
- `npm test -- src/main/agent/env/local.test.ts`
- `npm test -- src/main/agent/env/container.test.ts` (skipped locally because no
  usable Docker/Podman runtime was available)
- `npm run typecheck`
- `git diff --check`

Full `npm test` was also run; it reached 61 passing test files and then failed
in `src/main/db/repositories/cli-sessions.test.ts` because the installed
`better-sqlite3` native module was compiled for `NODE_MODULE_VERSION 136` while
the current Node.js requires `137`.
