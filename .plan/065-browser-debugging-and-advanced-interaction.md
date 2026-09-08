# PR65: Browser debugging and advanced interaction tools

> Status: **DONE**. Implemented by `ab1b572` with bounded wait/hover/drag/dialog
> tools, console and network buffers, gated `browser_evaluate`, browser approval
> updates, and session tests.

## Goal

Add structured tools in three slices:

1. Interaction: `browser_wait`, `browser_hover`, `browser_drag`,
   `browser_handle_dialog`.
2. Debug evidence: `browser_console`, `browser_network`.
3. Advanced escape hatch: tightly gated `browser_evaluate`.

## Interaction design

- Hover/drag target snapshot refs, preserving the current stale-ref checks.
- Wait supports bounded conditions: duration, URL/title change, ref visible/hidden,
  or network-idle approximation. Hard timeout and Stop support are mandatory.
- Dialog handling exposes pending dialog type/message and accepts only
  accept/dismiss plus optional prompt text.
- Re-snapshot after DOM-changing operations and invalidate stale refs consistently.

## Console and network evidence

Maintain bounded per-tab ring buffers in `BrowserSession`:

- Console: level, timestamp, text, source URL/line when available.
- Network: method, sanitized URL, resource type, status, timing, failure, and bounded
  response metadata—not unbounded bodies.

Tools page/filter buffers by time/cursor/level/status. Redact authorization/cookie
headers and sensitive URL components. Clear buffers with tab lifecycle and prevent one
conversation from reading another tab.

## `browser_evaluate`

Arbitrary page JavaScript can mutate state, issue network requests, and exfiltrate page
data. It is not a read tool merely because it returns a value.

- Separate `browser_advanced` capability, disabled for agents unless explicitly
  granted.
- Route through approval with the exact expression and origin displayed.
- Execute only in the current page world—no Node/Electron APIs, filesystem, CDP
  command access, or cross-tab handles.
- Bound execution time, serialization depth, and output bytes; reject functions,
  remote object handles, and cyclic/unserializable results.
- Consider an allowlisted query subset before enabling arbitrary expressions.

## External mapping

Map GitHub browser/vscodeBrowser hover, drag, dialog, and Playwright-like operations to
exact North Star equivalents only. `runPlaywrightCode` does not automatically map to
`browser_evaluate`; it remains unsupported unless the source explicitly receives the
advanced capability under `057`.

## Verification

- Dynamic waits, timeouts, cancellation, stale refs, hover menus, drag/drop, alerts,
  confirms, prompts, navigation, and tab closure.
- Console/network buffer caps, pagination, redaction, redirects, failed requests,
  websockets/streaming edge cases, and cross-conversation isolation.
- Evaluate cannot access Node/Electron, bypass approval, retain remote handles, or
  return unbounded data.
- Existing navigate/snapshot/click/type/back/close/handoff behavior stays green.

## Out of scope

- Full Playwright API/code execution, download/upload automation, credential capture,
  unredacted request/response bodies, or background browser use without a live tab.
