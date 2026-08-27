# Headless URL validation is not bound to the connected address

> Status: **OPEN**
> Severity: **P1 — SSRF through DNS rebinding**
> Area: shared safe-fetch transport

## Problem

The shared headless-fetch policy resolves a hostname and rejects private or
local results, then calls the global `fetch`. That connection performs a second,
independent DNS lookup. A rebinding hostname can return a public address during
validation and a loopback, private, link-local, or metadata address when the
socket connects. Redirect hops repeat the same check/use gap.

This is narrower than debug 023: direct private destinations and ordinary
redirect expansion are blocked, but the validated DNS result is not pinned to
the connection.

The fetch deadline is also disposed only on failure, leaving its timer and abort
listener alive until expiry after successful responses.

## Reproduction test

Use a deterministic lookup/connection fixture that returns a public address for
validation and a private address for connection. Cover the initial request and a
redirect hop. Assert the private endpoint is never contacted. Add a successful
request test that verifies deadline resources are disposed immediately.

## Fix direction

Use a transport/dispatcher with a controlled lookup that connects only to an
address from the validated result set while preserving the original hostname
for HTTP Host and TLS SNI. Validate the actual connected remote address as a
second defense. Apply the same policy to every redirect and dispose the deadline
in a `finally` path compatible with response-body consumption.

## Acceptance criteria

- DNS validation and socket connection use the same approved address set.
- The actual remote address is rejected if it is private, local, link-local, or
  metadata-scoped.
- Redirects cannot introduce a DNS rebinding gap.
- Successful, failed, and aborted requests all release deadline resources.
