# Browser commit classification and remembered approvals are under-scoped

> Status: **CLOSED**
> Severity: **P1 — external side effects without an exact approval**
> Area: browser approval policy and action identity

## Problem

The browser hardening in debug 045 correctly prompts for submitted typing and
click targets containing known commit verbs. Consequential behavior cannot be
reliably inferred from a target-label keyword list, however. Buttons such as
`Post`, `Apply`, `Create account`, `Update`, `Yes`, or icon-only controls can
commit external state while being classified as reversible and auto-approved.

Remembered browser identities are also lossy:

- Clicks use only origin and accessible target label, not the full URL or a
  sufficiently specific element/action identity.
- Identically labelled controls for different records share an identity.
- Submitted text uses a redacted preview and length. Different emails, secrets,
  or long payloads can collapse to the same remembered identity.

An approval remembered for the conversation can therefore authorize a different
target or payload from the one the user reviewed.

## Reproduction test

Use an authenticated-style fixture with commit controls named `Post`, `Apply`,
`Update`, `Yes`, and icon-only buttons. Assert none commits without approval.
Place two identically labelled destructive controls on different records and
verify approval for one does not authorize the other. Submit two distinct
same-length values that produce the same redacted summary and assert their
approval identities differ.

## Fix direction

Treat browser classification as advisory rather than an authorization boundary.
Require approval for all clicks and submissions that cannot be proven read-only,
or remove remembered approval for consequential browser actions entirely.

If remembered approval remains, build identity from an exact, non-disclosing
hash of the original payload plus a stable target identity and full page scope.
Keep the redacted payload summary only for display. Do not persist raw submitted
content or secrets.

## Acceptance criteria

- Unrecognized labels and icon-only controls cannot silently commit external
  state.
- Approval for one same-labelled control does not authorize another record.
- Distinct payloads always have distinct exact approval identities, even when
  their redacted summaries match.
- Approval UI continues to show origin, target, action type, and a redacted
  payload summary without persisting secrets.
- Auto mode remains an explicit user-controlled override, not an accidental
  consequence of the reversible-interaction classifier.

## Resolution

- `browser_click` now requires approval by default; target-label classification
  is no longer an authorization boundary for clicks.
- Browser action identities now include full page URL scope, ref/target
  fingerprint metadata, and exact SHA-256 payload hashes for submitted text.
  Redacted payload summaries remain only in approval display details.
- Snapshot refs carry a target fingerprint built from the ref, role, backend
  node, and best-effort DOM selector/tag metadata, so same-labelled controls on
  different records do not share an approval identity.

## Verification

- `pnpm vitest run src/main/agent/approval/approval.test.ts src/main/browser/session.test.ts`
- `pnpm typecheck`
