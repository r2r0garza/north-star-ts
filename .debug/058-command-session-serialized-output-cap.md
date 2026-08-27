# Command-session output cap does not include JSON serialization expansion

> Status: **Fixed**
> Severity: **P2 — tool result can exceed the model-output budget**
> Area: command session result rendering

## Problem

Debug 049 correctly applies the model cap before advancing the session cursor.
The cap is measured against raw command-output bytes, then the result is embedded
in pretty-printed JSON. Quotes, backslashes, newlines, tabs, and control characters
expand during `JSON.stringify`, so the final tool result can substantially exceed
the intended model-result budget.

For example, a raw stream dominated by quotes approximately doubles when encoded.
The response remains cursor-correct, but context/resource bounds are no longer
guaranteed at the actual envelope handed to the model.

## Reproduction test

Render sessions containing output dominated by quotes, backslashes, newlines,
control characters, ordinary ASCII, ANSI sequences, and multi-byte UTF-8. Measure
the UTF-8 byte length of the complete serialized result and assert it never
exceeds the public model-result cap. Repeated polling must still reconstruct all
retained output without gaps or duplication.

## Fix direction

Budget the final serialized envelope rather than only the raw `output` field.
Reserve bytes for fixed metadata, calculate JSON-escaped output incrementally,
and stop at a UTF-8- and escape-safe boundary before setting the cursor. An
alternative structured transport is acceptable if it provides the same exact
final-size guarantee.

Expose omitted/model-truncated bytes consistently and always return a session ID
and next cursor when recoverable output remains.

## Acceptance criteria

- The complete serialized tool result never exceeds the documented byte cap.
- Worst-case JSON escaping, pretty-print overhead, and metadata are included in
  the budget.
- Cursor advancement covers exactly the output represented in the response.
- Polling reconstructs retained output without gaps or duplication.
- Ring-buffer drops and model-envelope truncation remain separately reported.
