# PR98: Browser network request lifecycle and idle semantics

> Status: **DEFERRED**. Bound abandoned browser request bookkeeping and prevent stale or intentionally long-lived requests from making `network_idle` waits time out forever.

## Goal

Give browser network-idle waits a documented, robust meaning across navigation, failed/abandoned requests, redirects, SSE, and WebSockets while keeping bounded network evidence.

## Activation condition

Activate when a reproducible stale-request/network-idle failure is captured or when browser automation work next changes network tracking. Do not apply a blind `networkByRequest.clear()` on `did-navigate`: it can erase valid requests for the new document and report idle too early.

## Required plan/analysis pass

Capture the CDP event ordering for normal navigation, redirects, aborted navigation, reload, same-document navigation, SSE, and WebSocket traffic. Determine whether generation tracking, age-based sweeping, resource-type exclusions, or a combination best matches the product's intended idle semantics. Define which requests count before implementation.

## Acceptance

- Abandoned old-document requests cannot remain indefinitely or block future idle waits.
- New-document requests are not accidentally discarded at navigation commit.
- Long-lived transport behavior is explicit and tested.
- Request bookkeeping has a deterministic bound or stale-eviction policy.
- Network evidence remains ring-capped and correctly updated where completion events arrive.

## Likely files

- `src/main/browser/session.ts`
- Browser session network/wait tests

## Out of scope

- Capturing response bodies.
- Replacing CDP network instrumentation.
