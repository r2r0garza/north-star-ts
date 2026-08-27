# Local safe filesystem writes can report success after a short write

> Status: **OPEN**
> Severity: **P2 — silent partial file corruption**
> Area: local Python filesystem helper

## Problem

The local helper performs one `os.write(fd, data)` call and ignores its returned
byte count. POSIX permits `write` to consume fewer bytes than requested. Under
resource pressure or interruption, the helper can close the file and report
success even though only a prefix was written.

## Reproduction test

Factor the write loop so a test double can force multiple short writes and an
interruption. Assert the full payload is written when progress continues and
that zero progress or a terminal error produces a failure rather than success.
Include multi-byte UTF-8 content.

## Fix direction

Encode once, then loop over a memory view until every byte is written. Handle
interrupted calls according to Python's documented behavior and fail if a write
makes no progress. Decide and document whether success also requires `fsync`;
at minimum, never claim success before all bytes reach the file descriptor.

## Acceptance criteria

- All bytes are written or the operation fails explicitly.
- Short writes, interruptions, zero-progress writes, and UTF-8 payloads have
  regression coverage.
- Atomic staging and cleanup behavior remains unchanged.
