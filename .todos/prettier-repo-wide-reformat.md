# TODO: repo-wide prettier reformat (option C)

## Why
`pnpm format` was broken for a while: `.prettierrc` pointed `tailwindStylesheet` at a
non-existent `app/globals.css` (a leftover from the project's Next.js origins), and the
`prettier-plugin-tailwindcss` loader throws `ENOENT` reading that stylesheet for **every** file it
formats — so prettier failed on `.ts`/`.tsx`/`.css` alike, not just Tailwind files.

The **config path is now fixed** (commit on `feat/workspace-indexing`: `tailwindStylesheet` →
`src/renderer/src/globals.css`), so `pnpm format` works again. But because it was broken, the
codebase drifted: **118 of 192 `.ts`/`.tsx` files** are not prettier-clean and would be rewritten by
a `pnpm format` run.

This TODO is the deferred cleanup: actually run the reformat.

## What to do
```bash
pnpm format            # prettier --write "**/*.{ts,tsx}" — rewrites ~118 files
pnpm typecheck && pnpm test   # sanity: formatting-only changes must not break anything
```

## Why it's deferred (not done inline)
- It's a **large, noisy, whole-repo diff** (~118 files) that would bury feature work in review.
- Most of those files are unrelated to the `feat/workspace-indexing` stack that surfaced the bug.
- It touches files "owned" by other branches/history → merge-conflict risk if done on a feature branch.

## How to do it cleanly
- Do it as its **own dedicated commit** (message like `chore: repo-wide prettier reformat`),
  ideally straight on `main` or a short-lived `chore/prettier-format` branch — **not** folded into a
  feature branch.
- Land it when few feature branches are in flight (minimizes rebase pain), or coordinate so open
  branches rebase right after.
- Verify the diff is **formatting-only** (no logic changes): `git diff --stat` should show many files
  with balanced +/- churn; spot-check a couple.

## Prevent regression (do at the same time or right after)
- Add a **pre-commit hook** (or CI check) running `prettier --check` on staged files so the repo
  can't silently drift out of format again. Options: a lightweight `.husky` + `lint-staged`, or a
  simple `prettier --check` step in CI. (Note: the harness supports hooks via `settings.json` — the
  `update-config` skill can wire a Stop/PreToolUse-style check, but a git pre-commit hook is the more
  standard fit here.)

## Context / provenance
- Root cause found 2026-07-01 while trying to `pnpm exec prettier --write` the workspace-indexing
  files (they format fine now; they're part of the 118).
- The one-line config fix is option **A** (done). This file is option **C** (the full reformat),
  split off by request. Option B (reformat only the stack's ~15 files) was declined in favor of A.
