# Headless network reads buffer entire bodies and have no independent deadline

> Status: **FIXED**  
> Severity: **P2 — hung turn and memory exhaustion**  
> Area: web search, web_fetch, and dashboard URL refresh

## Problem

Web fetch, DuckDuckGo search, and dashboard URL recipes call `res.text()` before
applying output limits. They rely only on an optional turn/task signal, so a slow
or endless response can hang indefinitely and a large response is fully decoded
and parsed in the Electron main process.

## Reproduction test

Serve endless, slow, oversized, misleading-content-length, compressed, HTML, and
JSON responses. Verify hard deadlines, decoded-byte caps, cancellation, and clear
truncation/failure behavior.

## Fix direction

Combine caller cancellation with an explicit request deadline and stream bodies
through a decoded-byte cap. Cancel the reader immediately at the limit; do not
parse partial HTML or JSON as complete.

## Acceptance criteria

- Every headless request has a hard deadline and body cap.
- Oversized JSON refreshes fail without replacing the prior cache.
- Search/fetch errors distinguish timeout, abort, oversize, and HTTP failure.
