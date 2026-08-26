# Concurrent patch destination can be overwritten or deleted

> Status: **CLOSED**  
> Severity: **P1 — data loss**  
> Area: `apply_patch_tool` transaction commit and rollback

## Problem

An `add` or `move` destination is required to be absent while the patch is
planned. That absence is not protected atomically through commit. If another
process creates the destination after validation, the transaction's final
rename can overwrite the external file. If a later operation then fails,
rollback can delete the destination because it assumes that every destination
which did not exist during planning belongs to the transaction.

The vulnerable flow is in
`src/main/agent/tools/file/patch.ts`:

1. `commitPatch` checks revisions before staging.
2. Added targets are represented by an expected revision of `undefined`.
3. Move destinations revalidate their source through `sourceTarget`, not the
   continued absence of the destination.
4. `env.rename(staged, target)` uses normal replacement semantics.
5. Rollback calls `removeFile(target)` for entries recorded as not previously
   existing.

## Impact

- A newly created user or tool file can be overwritten without a stale-file
  error.
- A subsequent commit failure can delete that external file during rollback.
- The advertised validate-then-rollback transaction guarantee is violated.

## Reproduction test

Add a deterministic fake-environment test to `apply_patch_tool.test.ts`:

1. Plan a patch that adds `new.txt` and performs a second mutation.
2. After planning/approval but before the staged rename, simulate another
   process creating `new.txt` with `external\n`.
3. Inject a failure in the later mutation so rollback runs.
4. Assert the patch reports a stale/conflict result and `new.txt` still contains
   `external\n`.

Repeat the case for a move destination.

## Fix direction

- Add an environment primitive with atomic no-replace semantics for installing
  a staged file at a destination expected to be absent.
- Revalidate both move source revisions and move destination absence.
- Record whether each destination was actually installed by this transaction;
  rollback must remove only transaction-owned files.
- Do not implement this as another `stat` followed by normal `rename`; that
  retains the same time-of-check/time-of-use race.
- Verify the primitive's behavior independently on macOS, Linux, Windows, and
  the container backend. If exact parity is impossible, fail closed rather than
  silently replacing a destination.

## Acceptance criteria

- Concurrent creation of an add or move destination never overwrites it.
- The tool returns an actionable `stale_file` or `conflict` result.
- Rollback never deletes a destination created by another actor.
- Existing mixed add/update/move/delete rollback tests continue to pass.
- Failure injection covers every commit step after an external destination is
  introduced.

## Resolution

Implemented in `feat/tool-hardening`:

- Added `Environment.installFileNoReplace`, implemented by local filesystem
  hard-link creation and container `ln -T`, so add/move destinations expected to
  be absent are created without replacement semantics.
- `commitPatch` now revalidates move destination absence before staging and
  uses no-replace install for added/moved targets.
- Rollback tracks transaction-installed destinations and removes only those,
  preserving externally-created files on stale destination failures.
- Added deterministic fake-environment regressions for concurrently-created add
  and move destinations during rollback, plus direct local/container primitive
  tests.

Verification:

- `pnpm exec vitest run src/main/agent/tools/apply_patch_tool.test.ts src/main/agent/env/local.test.ts`
  passed.
- `pnpm exec vitest run src/main/agent/tools/apply_patch_tool.test.ts src/main/agent/env/local.test.ts src/main/agent/env/container.test.ts`
  passed after Docker and Podman were available to the test process.
