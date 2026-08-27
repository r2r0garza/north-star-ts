# MCP tool calls are unbounded and cannot be cancelled with the turn

> Status: **OPEN**
> Severity: **P2 — turn stall and unbounded remote output**
> Area: MCP client manager and agent lifecycle

## Problem

The MCP manager awaits `client.callTool` without a turn abort signal or deadline.
A hung server can stall the agent after the user presses Stop. Returned text and
resource bodies are concatenated without a byte cap, allowing a server to consume
unbounded memory and context before ordinary model-output controls apply.

This issue is independent of debug 041: a correctly authorized MCP tool still
needs bounded execution and output.

## Reproduction test

Use fixture servers that never respond, respond after cancellation, stream or
return oversized content, return oversized embedded resource text, and disconnect
mid-call. Assert Stop/deadline settles the call promptly and oversized results
produce bounded, explicit truncation metadata.

## Fix direction

Pass the turn's abort signal through the MCP client call, add a configurable hard
deadline, and evict or close clients that do not settle safely. Flatten content
incrementally into a byte budget and preserve content-type/truncation metadata.
Bound error strings as well as successful results.

## Acceptance criteria

- Stop and deadline cancellation settle an in-flight MCP call promptly.
- Text, resource text, error output, and metadata have documented hard bounds.
- Truncation is explicit and UTF-8 safe.
- Connection eviction does not leak child processes, sockets, or listeners.
