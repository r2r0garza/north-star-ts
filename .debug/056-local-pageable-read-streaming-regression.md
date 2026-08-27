# Node local pageable reads again materialize the complete source file

> Status: **FIXED**
> Severity: **P2 — source-size memory growth despite bounded output**
> Area: local filesystem reads and directory listing

## Problem

Debug 046 moved line pagination into a streaming helper, but the later Node
runtime rewrite replaced it with `safeReadTextLines -> safeReadFile`. The current
path reads the complete file into a `Buffer`, builds an array containing every
physical line, and only then applies offset, line, and byte limits.

The large-file regression still passes because Node can allocate the fixture;
it no longer demonstrates memory bounded by the requested page. A very large or
rapidly growing file can exhaust memory even when the caller requested one small
line range.

Directory listing has the same lesser source-bound problem: `readdir` returns the
complete directory before entry and name-byte caps are applied.

## Reproduction test

Instrument bytes read and peak buffered data rather than asserting only the
returned page. Read a tiny range from the beginning and end of a very large
generated file and verify memory stays within a documented multiple of the
streaming chunk/page budget. Exercise a very large directory and verify listing
stops once its requested bounds are satisfied.

Cover binary sniffing, oversized physical lines, UTF-8 boundaries, incremental
revision calculation, truncation metadata, and pagination after an oversized
line.

## Fix direction

Implement `readTextLines` with incremental `FileHandle.read` calls. Track line
number, selected bytes, binary prefix, UTF-8 decoder state, and SHA-256 incrementally
without retaining the complete source or an array of all lines. If a revision is
returned, continue hashing to EOF with a fixed-size buffer.

Use incremental directory iteration (`opendir`/async iterator) so list caps stop
enumeration at the data source.

## Acceptance criteria

- File-read memory is bounded independently of source-file size.
- Directory enumeration stops when entry or byte limits are reached.
- Tests assert bytes buffered/read, not merely successful output from a large
  fixture.
- Pagination, binary detection, UTF-8 safety, oversized-line recovery, and
  revision metadata preserve their existing contracts.
- Debug 046 remains historical; this brief records the later Node-rewrite
  regression explicitly.

## Resolution

- Replaced the Node local `safeReadTextLines -> safeReadFile` path with the
  shared chunked `readHostTextLines` helper over an `O_NOFOLLOW` file handle.
- Changed `readHostTextLines` to use bounded `FileHandle.read` chunks while
  tracking UTF-8 decoder state, binary sniffing, selected page bytes, oversized
  skipped-line recovery, and incremental SHA-256 revision calculation.
- Changed local directory listing caps to use `opendir` iteration so entry caps
  stop pulling names from the source.
- Kept direct host attachment reads on the same chunked reader by opening the
  attachment file in `read_file_tool`.

## Verification

- `npm run typecheck`
- `npm test -- src/main/agent/env/local.test.ts src/main/agent/tools/read_file_tool.test.ts src/main/agent/tools/list_files_tool.test.ts`
- `npm test`
