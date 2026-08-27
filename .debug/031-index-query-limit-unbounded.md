# index_query accepts an unbounded explicit result limit

> Status: **FIXED**  
> Severity: **P2 — database and memory exhaustion**  
> Area: workspace index query

## Problem

A positive model-supplied `limit` is floored but never capped. SQLite may
materialize an arbitrarily large symbol, import, or file result set before
`truncateForModel` reduces the final string. Non-finite and extreme values can
also reach the repository layer.

## Reproduction test

Call every limited operation with huge, infinite, fractional, negative, and
normal values. Spy on repository calls and assert the server cap is always used.

## Fix direction

Define operation-specific hard maxima, clamp finite integers before querying,
over-fetch by one for completeness metadata, and document the caps in the schema.

## Acceptance criteria

- No repository query receives a limit above its hard maximum.
- Capped results state that more matches may exist.
- Default result sizes remain unchanged.
