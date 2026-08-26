# Ripgrep spawn failure is rendered as no matches

> Status: **RESOLVED**  
> Severity: **P2 — false-negative search result**  
> Area: LocalEnvironment workspace search

## Problem

`captureSpawn` represents a spawn error with `exitCode: null` and places the
error message in `stdout`. `LocalEnvironment.search` throws only when a numeric
exit code is greater than one, then passes the non-JSON error text to the
ripgrep JSON parser. The parser skips it and returns an empty result.

Consequently, a missing, damaged, non-executable, or unsupported bundled
ripgrep binary can be reported to the model as a successful search with no
matches. For regex searches, other engine/infrastructure failures can also be
collapsed into `ERROR[bad_regex]` by `search_tool`.

The app normally bundles `@vscode/ripgrep`, so a system installation should not
be required. This bug concerns failure of the bundled resolution/execution
path, not the normal absence of `rg` on `PATH`.

## Impact

- The agent can make decisions based on a false claim that text is absent.
- Packaging or architecture problems are hidden from the user.
- Recovery guidance points at changing the query instead of repairing search.

## Reproduction test

Make the ripgrep executable resolver or spawn function injectable in focused
tests, then cover:

1. Executable path does not exist (`ENOENT`).
2. Executable exists but cannot be executed (`EACCES`).
3. Search times out or is aborted.
4. Ripgrep exits `2` for a genuine regex parse error.
5. Fixed-string and regex modes preserve distinct error classifications.

No infrastructure failure may produce a normal empty `SearchResult`.

## Fix direction

- Treat `exitCode === null`, timeout, abort, and process signals as execution
  failures before parsing output.
- Keep stderr separate from stdout for search execution, or return structured
  spawn-error metadata from the capture layer.
- Introduce a `search_unavailable`/`search_failed` tool error for infrastructure
  failures.
- Return `bad_regex` only when ripgrep or the fallback positively identifies a
  pattern error.
- Add the packaged-app smoke test promised by plan `048`, verifying that the
  unpacked binary exists and executes from the built application layout.

## Acceptance criteria

- A missing or non-executable bundled binary produces an explicit error.
- A valid query is never blamed for an engine startup failure.
- A genuinely invalid regex still produces `ERROR[bad_regex]`.
- Fixed-string searches cannot produce `bad_regex`.
- Development, packaged Local, container-rg, and container-fallback paths have
  explicit tests or documented reduced behavior.

## Resolution

- `captureSpawn` now preserves stderr separately, tracks aborts, and exposes
  spawn-error metadata while keeping the historical combined `stdout` behavior.
- Local and container ripgrep execution now fail before JSON parsing for spawn
  failures, null exits, timeouts, aborts, signals, and non-pattern ripgrep
  failures.
- `search_tool` maps only known pattern failures to `ERROR[bad_regex]`;
  infrastructure failures return explicit `search_unavailable`, `search_failed`,
  or `aborted` errors.

## Verification

- `pnpm exec vitest run src/main/agent/env/local.test.ts src/main/agent/tools/search_tool.test.ts`
  passed.
- `pnpm run typecheck` passed.
- `pnpm test` was run; unrelated failures remain in
  `src/main/db/repositories/cli-sessions.test.ts` due a `better-sqlite3` Node ABI
  mismatch and in `src/main/agent/env/container.test.ts` due local
  Docker/Podman image/runtime access.
