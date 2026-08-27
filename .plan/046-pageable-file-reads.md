# PR46: Truly pageable file reads and structured truncation metadata

> Status: **DONE**. First tool-quality phase. No schema migration.

## Context

`read_file_tool` advertises line-based `offset`/`limit`, but it calls `stat` and
rejects every file over 256 KiB before applying those arguments. Its recovery
hint says to paginate, even though pagination cannot cross that size guard. The
tool also reads the full file into memory, and `truncateForModel` emits the same
“use read_file with offset” note for outputs that did not come from a file read.

This makes large generated sources, lockfiles, logs, and minified-but-text files
unreadable and gives the model no machine-readable continuation cursor.

## Goal

Make text reads genuinely incremental and self-describing: a model can request a
bounded line window from a large file, learn whether more content exists, and
continue without guessing. Preserve workspace/attachment confinement, binary
detection, UTF-8 safety, and provider-independent behavior.

## Design

### Backend seam

- Add an `Environment.readTextLines(path, { offset, limit, maxBytes })` operation
  returning `{ text, startLine, endLine, hasMore, fileBytes }`.
- Local uses a UTF-8-safe read stream plus a bounded incremental line splitter,
  stops after `limit + 1` lines, and never buffers the entire file or an
  unbounded newline-free line.
- Container performs the slice inside the container in one exec operation and
  returns one bounded payload. Do not round-trip every line through IPC.
- Chat attachments use the same host streaming helper after the existing exact
  attachment allowlist check.
- Inspect only an initial chunk for binary/NUL detection. A huge text file is no
  longer rejected merely because of total size.

### Tool contract

- Keep `path`, one-based `offset`, and `limit`; cap `limit` and response bytes
  server-side regardless of model input.
- Render line-numbered text as today, followed by a compact metadata envelope:
  `startLine`, `endLine`, `hasMore`, `nextOffset`, `fileBytes`, `truncated`.
- When the byte cap lands before the requested line limit, set `truncated:true`
  and compute `nextOffset` from the last complete returned line.
- A single pathological line larger than the byte cap returns a bounded prefix
  plus an explicit `line_too_long`/continuation result; never split invalid UTF-8.
- Return a stable content revision (SHA-256) when affordable during the same
  stream. `047` consumes it as an optional optimistic edit precondition. If the
  requested window ends before EOF, revision may be omitted rather than forcing
  a full-file scan.

### Output helpers

- Extend `truncateForModel` to accept a caller-owned recovery hint and metadata;
  remove the hard-coded read-file advice from generic shell/search output.
- Keep the transport representation text-compatible for current providers, but
  centralize metadata rendering so future structured tool results have one seam.

## Implementation areas

- `src/main/agent/env/types.ts`: line-window input/result and environment method.
- `src/main/agent/env/local.ts` / `container.ts`: streaming/sliced backends.
- `src/main/agent/tools/read_file_tool.ts`: remove whole-file size rejection and
  consume the new window result.
- `src/main/agent/tools/output.ts`: caller-specific truncation metadata/hints.

## Verification

- Read the first, middle, and final windows of a file larger than 256 KiB.
- Prove adjacent `nextOffset` windows have no missing or duplicated lines.
- UTF-8 multibyte characters spanning chunks remain intact.
- Binary files, symlink escapes, missing files, directories, and unauthorized
  Chat attachments still fail closed.
- Very long lines and huge requested limits remain bounded.
- Local and container fixtures return equivalent content/metadata.
- Existing small-file output remains compatible apart from the added metadata.

## Out of scope

- PDF/image/notebook interpretation.
- Semantic symbol-range reading; the existing index remains the orientation tool.
- Editing large files (`047`/`050`).
