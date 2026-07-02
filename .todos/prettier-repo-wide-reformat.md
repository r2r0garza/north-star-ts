# TODO: repo-wide prettier reformat (option C)

## Status: DONE (reformat) — regression guard deferred

The repo-wide reformat is complete as of 2026-07-01 (commit `chore: repo-wide
prettier reformat`, branch `chore/pnpm-prettier`): all 118 drifted `.ts`/`.tsx`
files were rewritten by `pnpm format`. Verified formatting-only (line wrapping,
`es5` trailing commas, no logic changes); `pnpm typecheck` passes and the test
suite passes (one unrelated flaky process-timing test in `local.test.ts` passes
in isolation).

## Remaining (deferred): prevent regression
Not yet done — no husky/lint-staged/CI exists in the repo. When picked up, add a
**pre-commit hook** or CI `prettier --check` so the repo can't silently drift out
of format again. Options: lightweight `.husky` + `lint-staged`, or a
`prettier --check` step in CI.

---

## Original context / provenance
- `pnpm format` was broken for a while: `.prettierrc` pointed `tailwindStylesheet`
  at a non-existent `app/globals.css` (leftover from the project's Next.js
  origins), and `prettier-plugin-tailwindcss` threw `ENOENT` for **every** file —
  so prettier failed on `.ts`/`.tsx`/`.css` alike.
- Config path fixed (option **A**): `tailwindStylesheet` → `src/renderer/src/globals.css`.
- This file was option **C** (the full reformat), split off by request. Option B
  (reformat only the stack's ~15 files) was declined in favor of A.
- Root cause found 2026-07-01 while trying to `pnpm exec prettier --write` the
  workspace-indexing files.
