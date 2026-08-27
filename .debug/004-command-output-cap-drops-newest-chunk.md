# Command output cap can drop the entire newest chunk

> Status: **RESOLVED**  
> Severity: **P2 — missing command output**  
> Area: command-session bounded output buffer

## Problem

The session buffer enforces its byte cap by removing complete chunks from the
front. If one incoming chunk is larger than the configured cap, the loop removes
that same chunk and retains no output. More generally, dropping whole chunks can
discard substantially more history than necessary.

This is easiest to trigger with a small `max_output_bytes`, but large PTY chunks
can expose it at higher limits as well.

## Impact

- A command can report a positive `totalBytes` while returning no recent output.
- The model loses the most useful tail of compiler, test, watcher, or REPL output.
- Cursor and dropped-byte metadata are technically monotonic but do not describe
  a useful bounded ring buffer.

## Reproduction test

Using the fake command handle in `command_session_tools.test.ts`:

1. Start a session with `max_output_bytes: 4`.
2. Emit one chunk containing `abcdefgh`.
3. Poll from cursor zero.
4. Assert the retained output is the UTF-8-safe tail `efgh`, with four dropped
   bytes and a cursor at eight.

Add multibyte UTF-8 cases where the retention boundary falls inside a character,
plus multiple stdout/stderr chunks to verify stream labels and order.

## Fix direction

- Implement a true byte-bounded ring that can trim only the required prefix of
  the oldest chunk instead of dropping that chunk wholesale.
- Keep trimming UTF-8 safe for rendered text while maintaining byte-accurate
  absolute cursors.
- Preserve stdout/stderr/PTY stream attribution for partially retained chunks.
- Ensure a cap of one or a similarly tiny value behaves deterministically.

## Acceptance criteria

- The buffer retains the newest `N` usable bytes up to the configured cap.
- A single chunk larger than the cap retains its tail rather than disappearing.
- No rendered output contains a replacement character caused by boundary
  truncation.
- `cursor`, `totalBytes`, `droppedBytes`, and `truncated` remain accurate.
- Repeated polling has no duplicated or missing bytes within the retained range.

## Resolution

- Session output retention now trims only the required prefix of the oldest
  retained chunk instead of always dropping whole chunks.
- Retention advances to a valid UTF-8 boundary when a byte cap lands inside a
  multibyte character, so rendered output does not contain replacement
  characters.
- Poll rendering now also advances from invalid caller-supplied UTF-8 cursor
  boundaries and keeps absolute cursors byte-accurate.

## Verification

- `npm test -- src/main/agent/tools/command_session_tools.test.ts`
- `npm run typecheck`
