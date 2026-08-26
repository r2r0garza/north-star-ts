# Headless URL fetches can reach local and private services

> Status: **FIXED**  
> Severity: **P1 — SSRF and approval-scope expansion**  
> Area: web_fetch and dashboard URL recipes

## Problem

Headless fetch validates only the HTTP(S) scheme and follows redirects
automatically. It accepts loopback, private, link-local, and metadata endpoints;
an approved public URL can also redirect to one without a second decision.
Dashboard refresh repeats the same behavior under a durable URL grant.

## Reproduction test

Use local HTTP fixtures for direct loopback access, public-to-loopback redirects,
redirect chains, IPv4/IPv6 aliases, and a hostname resolving to a private address.
Assert no private response body reaches the tool or dashboard cache.

## Fix direction

Resolve and validate destinations, use manual redirects, and revalidate every
hop. Define policy for DNS rebinding and metadata IPs. The visible browser remains
the explicit path for user-approved local development URLs.

## Acceptance criteria

- Private/local/link-local/metadata destinations are rejected.
- Redirects cannot expand an approved public origin into a private destination.
- `web_fetch` and dashboard refresh share one tested URL policy.

## Resolution

- Added a shared `safeFetch` URL policy for headless fetch paths.
- The policy validates http(s), rejects localhost/private/link-local/metadata
  IP destinations and hostnames resolving to those ranges, follows redirects
  manually, and revalidates every hop.
- `web_fetch` and dashboard refresh now both use the shared helper.
- Added focused tests for direct private URLs, private DNS resolution, redirect
  revalidation, public redirect success, and dashboard rejection of an allowlisted
  metadata URL.
