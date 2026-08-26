# Oversized-line pagination returns a non-advancing cursor

> Status: **FIXED**  
> Severity: **P2 — incomplete/read loop**  
> Area: pageable file reads

## Problem

When the first requested line is larger than the response byte cap, the reader
returns a bounded prefix and sets `lineTooLong: true`. It also sets `hasMore:
true` and calculates `nextOffset` as the same line number. Calling
`read_file_tool` with that offset returns the same prefix again, so the caller
cannot reach the rest of the line or advance to the next line.

Both the Local and container implementations use this same line-based
continuation behavior.

## Impact

- Following the supplied continuation metadata can create an infinite read
  loop.
- The remainder of a long minified line, generated artifact, or log record is
  inaccessible through the tool.
- `hasMore` promises recoverable content without providing a usable cursor.

## Reproduction test

Create a file containing one line larger than `MAX_READ_BYTES`, followed by a
short second line:

1. Read at offset one and verify the first result is bounded.
2. Follow every returned continuation cursor.
3. Assert each cursor makes progress and the second line is eventually
   reachable without returning the same prefix twice.
4. Repeat with multibyte UTF-8 around each byte boundary.

Apply the same contract test to Local, container, and Chat attachment reads.

## Fix direction

Choose and document one explicit contract:

- Add a byte/column cursor that can continue within the current line, then
  return a normal line offset after its newline; or
- Treat oversized lines as deliberately non-pageable, omit `nextOffset`, and
  provide a separate cursor/tool option for skipping to the following line.

Do not keep `hasMore: true` with a `nextOffset` that reproduces the same result.
Any byte cursor must remain UTF-8 safe and bounded.

## Acceptance criteria

- Every advertised continuation cursor makes observable forward progress.
- The remainder of an oversized line is either retrievable or explicitly
  declared unavailable with a way to continue after it.
- UTF-8 characters are never split or replaced.
- Ordinary line-based pagination remains backward compatible.
- Local, container, and attachment implementations share the same behavior.

## Resolution

Implemented the explicit skip contract. When the first returned line is larger
than the byte cap, readers now return a UTF-8-safe bounded prefix, set
`lineTooLong: true` and `skippedLineRemainder: true`, and advertise
`nextOffset` as the following line. The remainder of that oversized line is not
pageable through the line-based cursor.

Covered by focused Local, container, and attachment read tests.
