# PR112: Trustworthy app launch and acceptance validation (rethink of the backup QA work)

> Status: **PLANNED** (2026-10-11). Design proposal; no application code changes in this task.
> Unblocks Mission Control ("Processes v2") from shipping: it can spec and build a user story but cannot
> yet honestly *validate* one. Launch and check pieces are also usable from standalone Processes through
> `104` command phases.
> Terms: Feature → Milestone → User story (see the `106.x` rename note).
>
> **Prior art:** branch `backup/qa-109-110-before-rethink-2026-10-04` (~26.5k lines, 188 files) built a
> full version of this — its plans `109`/`109.01`–`109.06` (QA seats, checks, app launch recipes, seat
> browser, proof methods, bundled Playwright) and `110` (wave acceptance gate) — then main was returned
> to the pre-109 baseline for a rethink. Those plan numbers collide with main's `109`/`110`; refer to them
> by branch, e.g. `backup:109.03`. This plan does **not** restart from zero: it salvages what worked and
> changes what didn't.

## Problem

Today a user story's proof step tells QA to "run the tests or commands, read the code"
(`PROOF_STEP_INSTRUCTION`, `src/main/tasks/process/service.ts`). In practice QA re-runs the builder's
tests, which only proves the builder's tests pass. Real validation needs the app running, and QA
writing its own evidence and durable checks the user can re-run.

## What the backup attempt established

**Worked and is worth porting (largely as built):**

- **App launch harness** (`backup:109.03`, `src/main/mission-control/app-launch.ts`): services in their own
  detached process group owned by the phase run, not conversation command sessions (which cap at 10
  minutes); `"auto"` loopback ports probed on IPv4 *and* IPv6 because a bind probe misses `SO_REUSEADDR`
  listeners; `{port}` / `{port:<key>}` substitution as implicit dependencies; HTTP (<500) or log
  readiness; `BROWSER=none` and `CI=1`; SIGTERM→SIGKILL group teardown in the phase `finally` plus
  `will-quit`; `app_start` / `app_status` / `app_stop` tools re-deriving the seat role server-side.
- **Seat browser** (`backup:109.04`): isolated per-seat browsers for Mission Control, separate from chat.
- **Proof methods** (`backup:109.05`): each criterion records *how* it was verified; proofs resting only on
  builder tests or code reading are refused.
- **Bundled Playwright runner** (`backup:109.06`): `@playwright/test` pinned and `asarUnpack`ed, run with
  the app's Electron binary (`ELECTRON_RUN_AS_NODE=1`) so users need no Node; workspace Playwright
  preferred when present; generated config in a temp dir, never written to the workspace.
- **Test browser resolution — keep exactly this order:**
  1. The workspace's own Playwright browser, if installed (probed via `playwright install --dry-run`).
  2. Otherwise the user's installed Chrome (`channel: "chrome"`), no download.
  3. Otherwise **ask**: download Playwright's Chromium headless shell into app data (consent shows size and
     progress; clicking Download is the consent) **or** install Chrome globally themselves. While pending,
     affected checks are `not_verifiable` ("browser not installed") and the phase *waits* with its clock
     paused instead of burning attempts. Surface it before Start as a workspace-analysis blocker for rigs
     with a QA seat.
- **Story-level QA is exploratory; the durable suite lives at the wave** (`backup:110`): QA proves each
  story by driving the running app with evidence; after a wave merges, QA writes/extends one coherent
  Playwright suite against the *integrated* app; failures become fix stories with capped rounds.

**Failed, from three real runs (recorded in `backup:110`):**

1. **No running app in the story worktree** — no recipe yet, or the story that makes the app runnable was
   still building in parallel. Patched with preflights and a greenfield "first story alone" rule, but the
   cause is structural.
2. **Per-story frozen checks contradict each other after merge** — two stories each passed their own
   Playwright checks; merged, one renamed a button the other's check pinned. Both satisfied their
   criteria as written. Hence the wave-level suite.
3. **Per-story checks don't test what the user gets** — the defect only existed in the merged result.

**The remaining gap this plan targets — the recipe itself:** the backup's recipe came from workspace
analysis proposals plus a user-facing **App launch editor**, with commands requiring an explicit
**Apply**. That puts the user in the loop as the recipe's reviewer and author, which fails for
non-technical users, and an analysis-time proposal does not exist for greenfield projects or keep up
as the app evolves. A recipe that silently misses a step (env var, migration, second service, build)
shows up only as confusing QA failures.

## Principles

1. **Verify by running, not by review.** Nobody is trusted to judge a recipe by reading it. The harness
   starts the app and observes outcomes. The user is never asked for commands; at worst they answer a
   plain-language question.
2. **The recipe is a living contract.** Builders create and maintain it; the harness verifies it before
   validation; QA only consumes it.
3. **"The app didn't run" is not "the feature is wrong."** Environment failures route to recipe repair and
   never count against a story or burn its attempts.
4. **Prove where the product exists.** Exploratory proof per story; the durable Playwright suite at the
   wave, against the integrated app (`backup:110`).
5. **Report what's true.** If the app cannot be run, UI criteria are `not_verifiable` with a reason and the
   story is shown *unverified* — never accepted.
6. **Measured, not patched.** Port the proven harness pieces; judge every behavior change against the
   fixed scenario scorecard (see Method), not against whichever run failed last.

## Design delta (on top of the salvaged pieces)

### A. Recipe ownership and verification

- Keep `backup:109.03`'s recipe shape and validation. Change who writes it: deterministic detectors
  (Procfile, `package.json` scripts with framework port styles, Django, compose as non-automatic) produce
  a draft; **agents** complete and maintain it; the **harness verifies** it. The App launch editor stays
  as an advanced escape hatch, not the primary path.
- **Verification** = start → readiness → smoke (HTTP status plus one load of each declared smoke path in
  a seat browser, collecting console errors and failed requests) → stop. Recipe state per
  workspace/branch: `absent`, `unverified`, `verified (commit)`, `broken (failure summary)`.
- **Commands without user review:** recipe commands still pass command policy and run in the selected
  Environment. Instead of an explicit Apply per command, verification runs them under the same
  policy/approval rules that apply to the builder's own shell commands in that run. (Open question 1.)
- **Recipe additions the backup lacked:** an idempotent `setup` list (migrations, seed, build) and
  `prerequisites` (e.g. a database), and `env` values that reference `.env`/`.env.local` keys or service
  URLs, never secrets.

### B. Failure classification and the repair loop

| Class | Signals | Route |
|---|---|---|
| Environment | early exit, readiness/smoke timeout, connection refused, startup 5xx, missing env key, `net::ERR_*` before the first assertion | Recipe repair |
| Feature | assertion failures or observed misbehavior against a running, smoke-passing app | Story/wave rejected with evidence |
| Test defect | syntax/import errors in QA's own check | QA fixes its check |

**Repair** is a bounded loop (e.g. 3 attempts) by a seat with a recipe-only objective, given captured logs
and the classification. If it still fails, escalate through the existing inbox in plain language ("The app
needs a Postgres database. Start one with Docker?"). Unresolved → affected criteria `not_verifiable` and
the story ends *unverified*, distinct from rejected. Repair attempts never count against a story's proof
revisions.

### C. Lifecycle

- **Greenfield:** keep the backup's "first story alone" rule, framed as a **runnable skeleton** story that
  must end with a *verified* recipe and one smoke check. Nothing that needs the app runs until it does.
- **Builder definition of done:** a story that changes how the app runs updates the recipe; the
  pre-proof gate (below) catches drift.
- **Pre-proof gate:** an app-check phase (`104`) before the story `test` step and before the wave gate.
  Failure → repair, not rejection.
- **Story proof:** exploratory, per `backup:110` decision 1 and `backup:109.05` methods.
- **Wave gate:** per `backup:110` — QA writes/extends the Playwright suite against the integrated app, the
  suite's `webServer` config is **generated from the verified recipe** so `npx playwright test` works for
  the user too (when the workspace has Playwright; otherwise it runs on the bundled runner).

### D. Worktree dependencies

`prepareWorktreeEnvironment` (`src/main/mission-control/worktree-env.ts`) symlinks `linkPaths` such as
`node_modules`/`.venv` from the main checkout. A story that adds a dependency installs into the shared
directory, visible to parallel stories and the user's checkout, and left behind if the story is
abandoned. When a story's manifest/lockfile diverges from the main checkout, replace the link with a
worktree-local install before the app check.

### E. Overlapping stories

The button-rename failure is two stories shaping the same UI in parallel, each validated against its own
picture of it. The wave suite fixes *where* tests live (one owner, the integrated app, free to update an
earlier test when a later story legitimately changes the UI). Also prevent it upstream: at planning time,
stories whose touch hints overlap on the same UI surface get a `depends_on` edge (serialized), so the
later story is built and explored against the earlier one's result. Wave-suite tests locate elements by
role and accessible name; when a later story changes a name an earlier test relied on, the wave QA updates
the test only if the earlier criterion still holds, and otherwise raises the conflict as a spec question,
not an integrator rework loop.

## Method: scenario fixtures instead of "how about this"

The backup work iterated by real-run trial and error: run, observe a failure, patch, re-run something
different. This plan is validated against a fixed set of reproducible scenarios, built in 112.1 before any
behavior changes, and re-run on every slice:

1. **Greenfield web app** (empty folder → small CRUD app): needs the skeleton rule and a verified recipe.
2. **Two stories, one UI** — the backup's third run (`item-management` vs `responsive-interface`, renamed
   button): must be serialized or caught at the wave without an integrator loop.
3. **App needing setup**: a database prerequisite plus a migration; the recipe misses one, and repair or
   plain-language escalation must recover without user-supplied commands.
4. **Two services** (API + frontend wired via `{port:api}`).
5. **Non-UI project** (library or CLI): no browser, no recipe services, proofs still independent.
6. **Builder misread a criterion** (with matching builder tests): must be rejected.

Each scenario has deterministic expected outcomes (story/wave status, failure class, no orphan processes,
attempts burned) recorded as a scorecard. A change is kept only if it improves the scorecard without
regressing another scenario. Live-model runs are noisy, so each scenario runs more than once and the
scorecard records rates, not single results. **Stop rule:** if two consecutive changes don't move the
scorecard, stop patching and revisit the design section they belong to.

## Slices

### 112.1 — Scenario fixtures, then port the harness and browser resolution

Build the scenario fixtures and scorecard first, and record the baseline on main. Then port
`backup:109.03` (harness, tools, recipe storage/validation) and the `backup:109.06` runner plus the
three-step browser resolution and consent wait, with their tests. No user-facing editor requirement.
Acceptance: the backup's harness tests pass on main; fixture projects start, smoke and tear down with no
orphans; browser resolution picks workspace → Chrome → consent in that order.

### 112.2 — Self-verifying recipes and repair

Detectors → agent completion → verification; recipe state; failure classification; bounded repair loop
with plain-language escalation; the *unverified* outcome. Acceptance: deliberate breakages (missing env
key, missing migration, wrong port, second service missing) are classified as environment failures and
fixed by repair or escalated without user-supplied commands; no story attempt is burned by them.

### 112.3 — Exploratory story proofs

Port `backup:109.04` seat browser and `backup:109.05` proof methods; app-check gate before the `test`
step (needs `104`). Acceptance: a story whose builder misread a criterion is rejected on exploratory
evidence; proofs citing only builder tests or code reading are refused.

### 112.4 — Wave gate and durable suite

Port `backup:110` and the overlapping-story serialization (section E) with the suite's `webServer` generated from the verified recipe, plus the greenfield
skeleton rule and worktree dependency divergence (section D). Acceptance: replay the backup's third-run
scenario (two stories shaping the same UI) — the wave suite catches the merged defect and produces a fix
story; the suite runs identically under the user's own `npx playwright test` when Playwright is installed.

## Open questions

1. **Approval model for recipe commands** run during verification/repair: same policy as the builder's
   shell commands in that run, or a dedicated, explained one-time consent per workspace.
2. ~~What triggered the 2026-10-04 rethink?~~ **Answered (2026-10-11):** the recipe problem and
   per-story tests trampling each other, worked on by trial-and-error patching. Size was not the
   issue, so 112.1 ports the backup code largely as built. The process answer is the scenario
   fixtures and stop rule above.
3. Container Environments: port publishing and reachability from the seat browser.
4. Whether the repair seat is a dedicated role or the builder seat with a recipe-only objective.
5. Fixed-port apps under parallel stories: serialize per workspace, or rewrite config per worktree.

## Out of scope

Deploying apps, production environments, load/performance testing, visual-regression baselines,
mobile/native app UI, and asking users to write or review commands.
