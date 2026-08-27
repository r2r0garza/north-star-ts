# Shell analysis misses backtick substitutions and wrapped network commands

> Status: **FIXED**  
> Severity: **P1 — approval-policy bypass**  
> Area: shell analyzer

## Problem

Legacy backtick command substitution is not marked uncertain or recursively
analyzed. Network detection also examines only the first executable token, so
wrappers and assignments such as `env X=1 curl`, `command curl`, `sudo curl`, or
`nohup wget` hide the real network operation. Sandboxed/enforced profiles can
therefore classify a network command as benign.

## Reproduction test

Add table-driven tests for backticks, nested substitutions, leading assignments,
and common wrappers around every recognized network command and package manager.
Assert they cannot receive a benign high-confidence verdict.

## Fix direction

Treat backticks and unsupported shell constructs as requiring approval, extract
their bodies where safe, and normalize wrappers/assignments before executable and
subcommand classification.

## Acceptance criteria

- Every test command is categorized as network access or uncertain syntax.
- Identities include the effective command, not just its wrapper.
- Existing hard blocks remain unconditional.

## Resolution

- Added recursive analysis for legacy backtick substitutions, including nested
  substitutions.
- Normalized leading assignments and wrappers (`env`, `command`, `sudo`,
  `nohup`, `setsid`, `time`, `exec`) to the effective command used for identity,
  path, and network analysis.
- Added regression tests for backticks, nested substitutions, leading
  assignments, and common wrappers around every recognized network command and
  package manager.

## Verification

- `pnpm vitest run src/main/agent/approval/approval.test.ts` — passed.
- `pnpm typecheck` — passed.
- `pnpm test` — failed only in `src/main/db/repositories/cli-sessions.test.ts`
  because the installed `better-sqlite3` native module was built for
  `NODE_MODULE_VERSION 136`, while the current Node.js requires `137`.
