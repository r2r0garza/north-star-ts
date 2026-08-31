---
status: RESOLVED
severity: P2
trigger: "A dashboard-generation run repeatedly attempted to create one HTML file while the transcript reported each failed attempt as a changed file"
created: 2026-08-31
updated: 2026-08-31
---

# Failed file writes look successful and encourage repeated revision errors

## Symptoms

- Expected: creating a new file omits revision preconditions, and a rejected
  write is clearly presented as a failed attempt rather than a changed file.
- Actual: `write_file_tool` received `mode: "create"` with
  `expected_revision: ""` more than once and rejected each call with
  `ERROR[bad_args]` because the value was not a 64-character SHA-256 digest.
- Actual: a later retry substituted an invented all-zero revision and failed
  with `ERROR[stale_file]` because the destination was missing.
- Actual: each rejected write was labeled `Wrote financial-dashboard.html`, and
  the transcript displayed `1 file changed` plus `Review all` even though the
  tool reported an error and made no change.
- The captured transcript explicitly exposes three rejected creation calls. It
  contains additional collapsed write groups, but their results are not present
  in the export, so their success or failure cannot be established from that
  evidence alone.
- The run eventually recovered by using an `apply_patch_tool` add operation,
  which successfully created the file and returned a real revision.

## Current Focus

- resolved: create-mode `write_file_tool` now documents that revisions must be
  omitted, tolerates an empty create placeholder as absent for compatibility,
  rejects empty overwrite/append revisions with corrective guidance, and still
  rejects invented create revisions as stale.
- resolved: changed-file pills are derived only from completed successful
  mutation calls. Failed, running, and interrupted edit/write/patch calls no
  longer appear in the changed-files bar.
- resolved: tool labels now distinguish running, successful, failed, and
  interrupted write/edit/patch mutations in both live streaming and replayed
  transcripts.
- resolved: successful `apply_patch_tool` add/update/move operations are now
  surfaced as changed files; failed patch attempts are not.
- verification: `npm test -- src/main/agent/tools/write_file_tool.test.ts
  src/renderer/src/lib/changed-files.test.ts` passed 38 tests.
- verification: `npm run typecheck` passed.

## Previous Focus

- hypothesis: the file-tool contract and transcript presentation fail at two
  separate boundaries. The flat write schema lets a generator populate an
  irrelevant optional revision with an empty placeholder during create, while
  the changed-files UI derives success from attempted tool arguments instead of
  completed tool results.
- test: issue create, append, overwrite, edit, and patch calls that succeed,
  fail validation, return `stale_file`, or are interrupted; inspect both the
  model-visible result and the transcript's labels and changed-file bar.
- expecting: create calls do not require or encourage a revision placeholder;
  repeated identical `bad_args` calls are avoided; only successful mutations
  appear as changed files; running and failed rows never claim that a file was
  written.
- next_action: add regression tests around irrelevant create revisions and
  errored changed-file derivation, then tighten the schema/error guidance and
  make transcript mutation status result-aware.
- reasoning_checkpoint: revision validation itself is functioning as designed.
  The defects are the conditional argument contract, failure recovery behavior,
  and optimistic UI wording—not a filesystem permission or path-confinement
  failure.

## Evidence

- timestamp: 2026-08-31
  observation: `write_file_tool` exposes `expected_revision` alongside every
  mode in one flat object schema even though create-only writes do not need a
  prior file revision.
- timestamp: 2026-08-31
  observation: `write_file_tool.execute` validates every supplied
  `expected_revision`, including the empty string on a create call, before it
  inspects destination state.
- timestamp: 2026-08-31
  observation: the tool returned the actionable error
  ``ERROR[bad_args]: `expected_revision` must be a 64-character SHA-256 hex
  digest.``, but an identical call was submitted again.
- timestamp: 2026-08-31
  observation: replacing the empty string with 64 zeroes changed the failure to
  `ERROR[stale_file]`; the reported current revision was `missing`, proving the
  placeholder did not describe any observed file state.
- timestamp: 2026-08-31
  observation: `changedFilesFromCalls` filters only on the tool name and path.
  It does not require `call.status === "done"` or otherwise exclude structured
  error results and interrupted calls.
- timestamp: 2026-08-31
  observation: `deriveLabel` renders `write_file_tool` as `Wrote <name>` before
  a result exists and retains the same past-tense label after an error.
- timestamp: 2026-08-31
  observation: existing `changed-files.test.ts` fixtures use only `status:
  "done"`; there is no regression case for errored, running, or interrupted
  mutation calls.
- timestamp: 2026-08-31
  observation: the targeted existing suites passed 29 tests across
  `write_file_tool.test.ts` and `changed-files.test.ts`, confirming that the
  current coverage does not detect this behavior.
- timestamp: 2026-08-31
  observation: revision-aware writes were introduced by commit `8aa4be0`; the
  shared North Star prompt still describes chunked create/append behavior but
  does not say to omit `expected_revision` for create or to reuse returned
  revisions between append chunks.

## Proposed Direction

1. Model create, append, and overwrite as distinct argument contracts where
   provider compatibility allows it. At minimum, explicitly state that create
   calls must omit `expected_revision` and must never send empty or invented
   placeholder revisions.
2. Consider treating an empty revision as absent only when the mode is create,
   where no prior revision can be meaningful. Preserve strict digest validation
   for overwrite and revision-protected append operations.
3. Make `bad_args` guidance corrective: for a create call, tell the model to
   omit the field. Add general agent guidance not to repeat an identical call
   after deterministic argument validation fails.
4. Filter the changed-files bar to completed, successful mutation calls. Failed
   and interrupted calls must not produce file pills or `N files changed`.
5. Make activity labels status-aware, for example `Writing`, `Wrote`, and
   `Write failed`, or use neutral wording until a result arrives.
6. Ensure structured patch adds receive equivalent UI treatment; successful
   adds should be discoverable without making failed attempts look successful.

## Acceptance Criteria

- `write_file_tool` with `mode: "create"` and no revision creates a missing
  file successfully.
- Tool documentation explicitly says to omit `expected_revision` for create and
  never use empty, zero-filled, or otherwise invented revisions.
- An empty or malformed revision on overwrite/append remains a deterministic
  validation error.
- A repeated call with the same deterministic `bad_args` payload is not issued
  without changing the relevant arguments.
- A write/edit call returning `ERROR[...]` does not appear in the changed-files
  bar and does not produce `N files changed`.
- A running or interrupted write/edit call does not appear as a completed file
  change.
- A successful create, append, overwrite, edit, or patch still appears exactly
  once for its path in the appropriate turn/run summary.
- Tool rows visually distinguish running, successful, failed, and interrupted
  mutations without requiring the user to expand the row.
- Regression tests cover `done`, `error`, `running`, and `interrupted` statuses,
  including a structured `ERROR[bad_args]` result.

## Eliminated

- hypothesis: the destination was outside the workspace or blocked by
  filesystem permissions.
  reason: every visible rejection was argument or revision validation, and the
  final add operation succeeded.
- hypothesis: the all-zero digest is a valid sentinel for a missing file.
  reason: the tool treats revisions as hashes of observed content; the error
  explicitly reported the destination revision as `missing`.
- hypothesis: every `1 file changed` entry proves a successful chunk write.
  reason: changed-file pills are derived from attempted call arguments and do
  not inspect the call's error status.
