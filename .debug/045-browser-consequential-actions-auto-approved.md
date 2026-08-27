# Browser interactions can commit irreversible actions without approval

> Status: **RESOLVED**
> Severity: **P1 — unauthorized external side effects**
> Area: browser tools and approval policy

## Problem

Browser navigation requires approval, but the local-host policy explicitly
auto-allows subsequent browser clicks and typing. A click can purchase, delete,
publish, send, or grant access, and `browser_type` can press Enter to submit a
form. Approval of a page does not safely imply approval of every action available
on that authenticated page.

The typing action identity and approval detail also omit the typed text, so even
a prompted action would not disclose the payload being submitted.

## Reproduction test

Use a local authenticated-style fixture with harmless navigation followed by
buttons and forms representing delete, purchase, send, and permission changes.
Assert observation remains automatic, while consequential clicks and submitted
typing require a distinct approval that identifies the origin and target.

## Fix direction

Classify browser operations as observation, navigation, reversible interaction,
or consequential commit. Require approval for likely commits and for typing with
`submit: true` unless a narrowly scoped durable rule exists. Include origin,
accessible target label, action type, and a safely redacted payload summary in
the approval action.

## Acceptance criteria

- Merely approving navigation does not approve consequential actions on a page.
- Form submission and destructive or transactional clicks require approval.
- Approval cards disclose origin, target, and a redacted payload summary.
- Snapshotting and clearly reversible local interactions remain usable.

## Resolution

- Added browser interaction classification metadata before click/type execution.
- Consequential click targets and `browser_type` with `submit: true` now require
  a distinct browser approval.
- Browser approval cards show action type, origin, target, and redacted payload
  summary where present.
- Browser remembered approvals are scoped to the current conversation instead of
  the whole workspace.

## Verification

- `npm test -- src/main/agent/approval/approval.test.ts`
- `npm run typecheck`
