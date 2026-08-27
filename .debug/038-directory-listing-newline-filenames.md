# Directory listings cannot represent newline-containing filenames safely

> Status: **FIXED**
> Severity: **P3 — ambiguous and incorrect listing**
> Area: Local and Container readdir rendering

## Problem

The tool joins raw names with newlines. On Local, one filename can look like
multiple entries. Container `readdir` parses `ls -Ap1` by newline first, so it
actually manufactures multiple entries and can misclassify names ending in `/`.

## Reproduction test

Create names containing newline, carriage return, tabs, quotes, backslashes, and
non-ASCII characters. Compare Local and Container structured results and rendered
tool output byte-for-byte.

## Fix direction

Use a NUL-delimited or JSON-producing container enumeration primitive with exact
file types. Render names with JSON escaping or return a structured JSON array.

## Acceptance criteria

- Every filesystem entry maps to exactly one result entry.
- Special characters round-trip identically across backends.
- Directory type is derived from metadata, not a trailing display character.

## Fix

- `list_files_tool` now renders each entry name with JSON string escaping, so
  embedded newlines, carriage returns, tabs, quotes, backslashes, and non-ASCII
  characters cannot create ambiguous display lines.
- Directory entries still receive the historical display suffix, but only after
  the escaped name and only when `DirEntry.isDirectory()` reports true.
- Local and container `listDir` already enumerate via structured JSON from
  metadata-backed `os.scandir`, avoiding line-split parsing and trailing-name
  type inference.

## Verification

- `pnpm exec vitest run src/main/agent/tools/list_files_tool.test.ts src/main/agent/env/local.test.ts`
  passed.
- `pnpm exec vitest run src/main/agent/env/container.test.ts` passed; runtime
  availability-gated container integration cases remained skipped in this
  environment.
- `pnpm run typecheck` passed.
