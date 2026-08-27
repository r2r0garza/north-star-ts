# PR48: Ripgrep-backed workspace search

> Status: **DONE**. Depends on neither `046` nor `047`, but ordered after them
> as the third tool-quality slice. No schema migration.

## Implementation note

Implemented in this branch. Local search now uses packaged `@vscode/ripgrep`
with a shared `rg --json` parser and argv builder. The agent-facing
`search_tool` exposes the richer query contract below while preserving legacy
`pattern`/`glob` inputs. Container search probes for in-container `rg` and falls
back to a bounded Python implementation that reports `engine:"grep"` plus
reduced-feature metadata. Electron packaging unpacks the ripgrep binary from
ASAR.

## Context

Local search currently walks every file sequentially in Node, reads each file
into memory, splits it into lines, and interprets the pattern as a JavaScript
regex. Its `glob` is only a case-insensitive filename substring. Container search
uses `rg` or `grep`, so regex and ignore behavior vary by backend.

Ripgrep already supplies fast parallel traversal, gitignore handling, binary and
hidden-file policy, real glob semantics, context lines, counts, and structured
JSON events.

## Goal

Use one ripgrep result parser and one search contract across Local and container
environments, with explicit modes and honest truncation. Keep a tested fallback
for environments where a container image lacks `rg`.

## Decisions

- Add `@vscode/ripgrep` as a production dependency for Local execution. It ships
  the platform binary and exposes `rgPath` without runtime downloads.
- Unpack the platform binary from Electron ASAR and add a packaged-app smoke test;
  `spawn` cannot reliably execute a binary trapped inside ASAR.
- Container execution probes `rg`; if absent, use a capability-equivalent bounded
  fallback and report `engine:"grep"`/reduced features rather than silently
  pretending full parity.
- Spawn argv arrays directly—never interpolate a model pattern into a shell
  command.

## Tool contract

Replace the ambiguous contract with:

- `query`: required text.
- `mode`: `regex | fixed` (default `fixed` for literal user/code searches).
- `case`: `smart | sensitive | insensitive`.
- `path`: optional workspace-relative subtree, resolved before spawn.
- `globs`: real include/exclude glob array.
- `result`: `content | files | count`.
- `before_context` / `after_context`, each tightly capped.
- `include_hidden` and `respect_ignore`, defaulting to ripgrep-safe behavior.
- `max_results`, always server-capped.

Parse `rg --json` events instead of colon-delimited text so paths containing
colons/newlines, match ranges, encodings, and context lines remain unambiguous.
Return relative POSIX paths, line/column, matched text, engine, capped status, and
a recovery hint tailored to the selected result mode.

## Implementation areas

- Package/build config: dependency and ASAR unpack rule.
- `Environment.search` types: richer query/result shape and engine metadata.
- Local/container backends: argv builder, JSONL parser, abort/process-group kill.
- `search_tool.ts`: schema, validation, rendering, and precise recovery hints.

## Verification

- Focused LocalEnvironment and `search_tool` tests passed.
- Production build passed.
- `pnpm typecheck` reached only the known pre-existing three test type errors.
- Container integration tests could not start in this environment because Docker
  credential access and Podman socket access were unavailable.

## Follow-ups

- Add packaged-app smoke coverage that executes the unpacked ripgrep binary from
  the built app layout on supported targets.
- Preserve the spawn-failure regression behavior resolved in debug brief `003`:
  infrastructure search failures must stay distinct from empty result sets and
  bad regex errors.
- Add container `rg` parity and no-`rg` fallback coverage in an environment with
  working Docker or Podman access.

## Out of scope

- Replacing `index_query`; semantic index queries remain complementary.
- Search-and-replace.
- Fuzzy filename UI search outside the agent tool.
