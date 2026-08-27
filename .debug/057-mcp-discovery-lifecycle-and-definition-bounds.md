# MCP discovery is not turn-cancellable and tool definitions are unbounded

> Status: **FIXED**
> Severity: **P2 — delayed Stop and unbounded model tool surface**
> Area: MCP connection and tool discovery

## Problem

Debug 050 added a hard deadline, turn cancellation, bounded errors, and bounded
content to actual MCP tool calls. Tool discovery runs earlier through
`connect`/`listToolsFor` without the turn's abort signal. The SDK supplies a
default request timeout, so discovery is not infinite, but pressing Stop cannot
promptly cancel a stalled server connection or tool-list request.

The manager also accepts every returned tool definition without budgets for tool
count, description size, input-schema size, or total serialized definition
bytes. A buggy or hostile enabled server can consume memory and model context
before the first model request.

## Reproduction test

Use fixture servers that stall during initialization and `tools/list`; abort the
turn and assert discovery settles promptly and closes the transport/process.
Return excessive tool counts, descriptions, deeply nested schemas, and oversized
serialized schemas. Assert discovery remains bounded, reports the affected
server, and still exposes valid definitions within the budget.

## Fix direction

Pass a discovery-scoped signal derived from the turn plus an explicit connection
and list deadline into client initialization and `listTools`. Close/evict the
transport on abort or timeout.

Validate and budget tool definitions before accumulating them. Bound individual
description/schema bytes, total server bytes, total tools, nesting/depth where
needed, and the combined MCP definition budget across servers. Report truncation
or omission explicitly instead of silently poisoning the model request.

## Acceptance criteria

- Stop promptly cancels MCP initialization and tool discovery.
- Timeout/abort closes stdio children and HTTP transports without listener or
  pool leaks.
- Tool count, descriptions, schemas, and total serialized definitions have hard
  documented bounds.
- One oversized or stalled server does not block valid servers or the turn.
- Debug 050's call-time cancellation and output-bound tests remain green.

## Resolution

- `src/main/agent/index.ts` passes the turn abort signal into MCP discovery.
- `src/main/agent/mcp/manager.ts` now applies a discovery-scoped deadline to
  connection initialization and `tools/list`, closes failed transports, and
  evicts failed pooled clients.
- MCP definitions are bounded by explicit environment-tunable budgets for total
  tools, per-server tools, description bytes, schema bytes, schema depth, and
  total serialized definition bytes.
- Oversized descriptions are UTF-8-safely truncated; oversized, malformed, or
  deeply nested input schemas are replaced with an empty object schema and
  reported through the existing per-server error callback.
- `src/main/agent/mcp/manager.test.ts` covers turn abort during discovery,
  per-server tool limits, description truncation, schema fallback, and retention
  of valid definitions.
