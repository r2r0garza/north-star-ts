# Command-session cursors can advance past output omitted from the model

> Status: **Resolved**
> Severity: **P2 — unrecoverable command-output loss**
> Area: command session pagination

## Problem

Session rendering advances the cursor according to the caller's output cap,
which may be as high as one MiB. The final result is then independently truncated
to the smaller model-output budget without reducing the cursor. The response can
contain only the first portion while its cursor skips all omitted bytes.

When a quick command has already completed and no session identifier is exposed,
the missing output may be impossible to recover.

## Reproduction test

Produce distinct output markers spanning more than the model cap, request the
maximum output page, and repeatedly poll using returned cursors. Assert every
retained byte appears exactly once and in order. Cover running, completed,
ring-buffer-truncated, ANSI, and multi-byte UTF-8 output.

## Fix direction

Apply the effective model budget while constructing the page, before advancing
the cursor. Return explicit `nextCursor`, omitted/dropped byte counts, and a
session identifier whenever more recoverable output exists. Avoid applying a
second opaque truncation pass to an already paginated result.

## Acceptance criteria

- A cursor never advances past recoverable bytes not present in the response.
- Repeated polling reconstructs retained output without gaps or duplication.
- Model-cap truncation and ring-buffer drops are reported separately.
- Completed commands remain pageable whenever output was omitted.

## Resolution

- Session pagination now applies a model-safe page cap before advancing the
  cursor, and command results no longer run a second opaque model truncation pass
  over already paginated output.
- Results expose `nextCursor`, `omittedBytes`, and `modelTruncated` separately
  from ring-buffer `droppedBytes`.
- Completed commands include `sessionId` whenever omitted output is still
  recoverable through polling.

## Verification

- `npm test -- src/main/agent/tools/command_session_tools.test.ts`
- `npm run typecheck`
