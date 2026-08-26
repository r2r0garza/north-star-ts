# PR44: Persisted provider ordering

> Status: **IMPLEMENTED** on `feat/cli-agents`.

## Context

Provider accounts were ordered only by `created_at`. Settings and the
conversation model picker both consumed that repository order, but users could
not author it. As CLI providers expand the list, creation order is no longer a
useful navigation policy.

## Goal

Let users drag provider cards into their preferred order in Settings →
Providers and use that exact order everywhere provider groups are displayed,
especially the conversation model dropdown.

## Decisions

- Persist order on `provider_accounts.position` rather than in a settings JSON
  side list. Ordering is provider-domain state and should cascade naturally when
  an account is deleted.
- Existing rows migrate to position `0`; `created_at` remains the stable
  tie-breaker, preserving their historical order until the first drag.
- New accounts append at `MAX(position) + 1`.
- A reorder submits the complete ordered id list through one
  `providers:reorder` IPC call. The repository validates that it exactly matches
  the current account set and writes all positions in one SQLite transaction.
  A stale renderer fails clearly and reloads instead of losing an account.
- Reuse the Process builder's accessible `dnd-kit` pattern: pointer activation
  distance, keyboard sortable coordinates, vertical strategy, optimistic UI,
  and a dedicated grip handle.
- Disabled accounts retain their position in Settings. They are filtered from
  conversation pickers, while the remaining enabled accounts preserve relative
  order automatically through `listAccounts()`.

## Implementation

- Schema v30 adds `provider_accounts.position`.
- `ProviderAccount` and its repository mapper carry `position`.
- `listAccounts()` orders by `position ASC, created_at ASC`.
- `reorderAccounts()` validates and writes an atomic complete ordering.
- Preload/main IPC expose `providers.reorder(orderedIds)`.
- Settings provider cards are sortable; `providers:listWithModels` already uses
  `listAccounts()`, so conversation dropdown propagation requires no second
  ordering path.

## Verification

- Repository tests cover append positions, reordering, returned order, and
  rejection of stale/incomplete id sets.
- Production build succeeds.
- Full suite: 831 pass; only the existing environment-dependent Docker/Podman
  container setup suites fail.
