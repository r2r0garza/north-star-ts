---
status: CLOSED
severity: P2
trigger: "Support/export records do not yet include app build and nested process failure identity"
created: 2026-09-02
updated: 2026-09-02
---

# Include nested process failure identity in support exports

## Evidence

[069](./069-process-failures-lose-stage-and-attempt-context.md) requires a
support/export record that includes app build and nested failure identity so an
incident from another computer can be investigated without speculation. The
current process export path is definition-oriented and does not package runtime
failure diagnostics.

## Proposed direction

Add a support/export path for process run incidents. It should include app
version/build information, process definition/run ids, nested run ids, phase ids,
phase-run ids, worker task ids, attempt records, stage/code/retryability, and
safe timestamps. Keep prompts, provider bodies, credentials, and large tool
payloads out of the export.

## Acceptance criteria

- [x] A failed top-level run export includes app build/version and process run identity.
- [x] A nested sub-process failure export includes both parent and child run identity.
- [x] Attempt history is included with stage/code/attempt metadata.
- [x] Exported diagnostics use sanitized bounded failure records.
- [x] Tests can investigate a copied/exported record without requiring the original DB.

## Likely files and dependencies

`src/main/process/io.ts`, process IPC/preload, process screen actions, package
metadata access, and process export tests. Depends on redaction work from
[092](./092-process-failure-redaction-and-size-limits.md).
