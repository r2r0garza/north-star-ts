# Byte truncation can split a UTF-8 code point

> Status: **Resolved**
> Severity: **P3 — corrupted tool and diff output**
> Area: output truncation

## Problem

Generic tool truncation and diff preview slice a raw Buffer at the byte cap and
decode it immediately. If the cap lands inside a multibyte character—especially
in newline-free output—the result contains a replacement character and no line
boundary fallback repairs it.

## Reproduction test

Place 2-, 3-, and 4-byte characters across each cap boundary with and without
newlines. Assert valid UTF-8, byte-limit compliance, and stable truncation notes.

## Fix direction

Use one shared UTF-8-safe prefix helper before searching for a line boundary.
Reserve space for the note so the complete returned result also respects its cap.

## Acceptance criteria

- Truncation never introduces U+FFFD or partial code points.
- Generic output and diff previews share the same tested implementation.
- Returned bytes, including metadata, remain bounded.

## Resolution

- Added a shared UTF-8-safe prefix helper in `src/main/agent/tools/output.ts`.
- Reworked generic model-output truncation to reserve byte budget for the
  truncation note, including metadata and recovery hints.
- Routed git diff preview clipping through the shared UTF-8-safe truncation
  helper.
- Added regression coverage for 2-, 3-, and 4-byte characters at cap boundaries,
  with and without newline fallback.

## Verification

- `npm test -- src/main/agent/tools/output.test.ts src/main/git/diff.test.ts`
- `npm run typecheck`
