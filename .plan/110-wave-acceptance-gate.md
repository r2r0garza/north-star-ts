# PR110: Wave acceptance gate — exploratory QA per story, Playwright suite per wave

> Status: **PROPOSED** (2026-10-04). Follow-up to `109` (QA seats that verify independently) and
> `106.5` (worktrees and the merge queue). Changes `109.02`'s per-story checks step; keeps `109.03`–
> `109.06`. Uses the current names: Features, Milestones, User stories.

## Context

`109.02` made each user story's QA seat write frozen Playwright checks from the spec, before the build,
in the story's own worktree, and gate the story on them. Three quick-list runs (2026-10-03/04) showed
where that breaks:

1. **No running app in a story worktree.** The first two runs failed QA with
   `ERR_CONNECTION_REFUSED` / "Cannot navigate to invalid URL": the workspace had no app launch recipe,
   and in the second run the story that made the app runnable was building in parallel. Patched in this
   branch (the app launch preflight, the greenfield "first story alone" rule, the reachability lint and
   "couldn't reach the app" classification), but the cause is structural: a story is proven in
   isolation against an app that may not exist there yet.
2. **Two stories, two contracts, one UI.** In the third run `item-management` and
   `responsive-interface` both built the item row. Each passed its own frozen checks. After the merge,
   `item-management`'s AC-2 check (`getByRole("button", { name: /complete/i })`, clicked twice)
   timed out because `responsive-interface` renames the button to "Mark Apples active" after the first
   click — which its own AC-3 check requires. Both behaviors satisfy the criteria as written; the checks
   pinned contradicting details. The conflict re-verify can't edit frozen checks, so the integrator
   reworked `app.js` round after round, health auto-paused on "proof polishing", and the escalation
   offered only Retry / Run integrator / Abandon.
3. **The checks don't test what the user gets.** Per-story checks prove each piece alone. The defect
   that ate the third run only existed in the merged result.

## Goal

Prove acceptance criteria where the product actually exists — on the integration branch, after a wave
of stories merges — with one coherent Playwright suite written by QA against the integrated app. Keep a
fast, honest check per story so obviously wrong work doesn't merge.

1. **Per story:** QA verifies each criterion by exploring the running app (seat browser, app launch
   recipe) and records an evidence-backed proof. No frozen scripts, no checks step.
2. **Per wave:** when the wave's stories have merged, a **wave gate** has QA write (or extend) the
   Playwright suite for every criterion in the wave from the criteria, locate elements in the running
   integrated UI by role and accessible name, and run the whole suite (this wave plus every earlier
   one) against the integration branch.
3. **Failures become follow-up stories** that run as a fix wave before anything else starts. A capped
   number of fix rounds per criterion, then the user decides.

## Product decisions

1. **The story proof is exploratory.** The story playbook becomes `spec → build → test`. The `test`
   step is QA driving the running app in the story worktree (`109.03` services, `109.04` browser) and
   recording a proof whose criteria use `method: "exploratory"` (or `qa_check` only for ad-hoc commands
   QA ran itself), with saved evidence (screenshots, observed text). `109.05`'s rules still refuse
   proofs that rest only on builder tests or code reading. QA writes nothing in the repo at this
   altitude; its scratch area is enough.
2. **A merged story is not done yet.** A story whose merge landed is `merged` (new status): built,
   proven by exploration, on the integration branch, awaiting its wave gate. It becomes `done` when a
   gate passes with all its criteria green (or waived by the user). Readiness of dependents keys off
   `done`, which is what makes the gate a barrier.
3. **One gate per wave, full barrier (v1).** The gate runs when the milestone is quiescent — no story
   running, proving, or integrating — and at least one story is `merged`. Its **batch** is exactly the
   `merged` stories, so membership never depends on re-deriving waves after the plan changes. No new
   story starts while a gate is due, running, or has open fix stories. (A later refinement could start
   next-wave stories whose own dependencies already passed; out of scope here.)
4. **The milestone gate is the last wave's gate.** Every gate re-runs the accumulated suite, so the
   last one is the full regression for the milestone. Landing (`106.5`) requires every story `done`, as
   today; `after_all_user_stories` summarises from the gate reports.
5. **The gate's checks are written from the criteria, against the running UI.** QA writes each check
   from the criterion's words (what must be true, not how the code did it), but it may look at the
   running integrated app to find roles, accessible names, and text to locate by. A control whose
   label changes with state is located by a name valid in both states, or re-located after each
   action. Checks live where `109.02` put them (`e2e/`, page objects and fixtures shared, a manifest per
   story at `<checksDir>/stories/<storyRef>.json`, tests tagged `@<storyRef> @AC-n`).
6. **The suite is committed to the integration branch at the end of every gate, pass or fail.** Fix
   stories branch from the integration head, so their builders can run the exact failing checks
   (`run_checks` with the story's tag, read-only to the builder by convention and diff review).
7. **QA triages every failing criterion into one of four outcomes:**
   - `passed` — green on this run.
   - `app_bug` — the app doesn't meet the criterion. Becomes a fix story (decision 8).
   - `check_fixed` — the check over-specified (asserted a detail the criterion doesn't ask for); QA
     corrected it in this gate and it now passes. Recorded with the diff and a one-line justification,
     shown in the gate report. Changing a check of an **earlier, already-passed** criterion is allowed
     only with the same justification and is highlighted to the user.
   - `unreachable` / `not_verifiable` — setup, not evidence (`109.06`'s browser, `unreachable`
     classification from this branch). Blocks the gate and goes to the user as setup, not as a fix
     story.
8. **Fix stories, not reopened stories.** Each `app_bug` becomes a new user story in the current
   milestone, created by the harness from QA's triage: title `Fix <story key> <AC-n>: <short>`, the
   failed criterion as its acceptance (plus "the gate check `<id>` passes"), the original story's touch
   hints, `origin: "gate"`, a link to the original story and gate. Fix stories have no dependencies
   (everything before them is merged) and run as the next wave. They're applied automatically in
   Copilot and Autopilot (they are repairs, not scope); in Manual they're proposals. The original story
   stays `merged` until a gate passes its criteria; its proof notes "AC-2 failed at gate N, fixed by
   <fix story>".
9. **Capped fix rounds, then the user.** If the same criterion is still `app_bug` after
   `maxGateFixRounds` (default 2) fix waves, the gate escalates instead of creating a third fix story.
   The decision shows the criterion, the failing check, its error, and the evidence, with three
   actions: **Accept as is** (waive the criterion with a note; the story becomes `done`),
   **I'll fix it** (pause; resuming re-runs the gate), **Drop the criterion** (a plan edit on the story;
   re-runs the gate). The same three appear on a merge conflict escalation's re-verification failure.
10. **Conflict resolution gets lighter.** The `after_each_user_story` hook keeps `resolve` (integrator)
    but its `reverify` proof step becomes a **smoke step**: the app starts from the recipe, the
    project's own tests pass, and QA spot-checks the conflicted story's criteria by exploration. No
    frozen contracts to satisfy, so the loop that ate quick-list run 3 can't form. The gate is the
    real check.
11. **Health doesn't double-stop.** A detector doesn't auto-pause for an anchor (story or milestone)
    that already has a pending user decision (gate escalation, merge conflict). Proof-polishing counts
    reset when the user takes a decision on that story. Gate fix rounds are governed by decision 9's
    cap, not by `proof_polishing`.
12. **Opt-in through the playbook.** The gate exists when the milestone playbook has an
    `after_each_wave` hook. The shipped default milestone playbook gets it and the default story
    playbook drops the `checks` step. Playbooks live in the database and aren't snapshotted per feature
    (`playbookFor` / `ensureDefaultPlaybook`), so existing installs keep their stored playbooks — and
    today's behavior (stories go straight to `done` on merge) — until the user applies `109.02`'s
    **Reset to default**, which already shows the step and hook changes before applying them.

## Proposed shape

### Story status `merged`

- `UserStoryStatus` gains `merged`. `integration.ts` sets it where it sets `done` today, when the
  milestone playbook has an `after_each_wave` hook; otherwise `done` as before.
- Readiness (`waves.ts` `readySet`, `position.ts` dispatch, `user-story-runner.ts` blockers) treats only
  `done` as satisfying a dependency. `merged` counts as settled for health (`settled()`), as landed for
  the merge queue, and as not-yet-done for milestone completion.
- UI: a "Merged · awaiting gate" badge; the milestone shows the batch and the gate state.

### The `after_each_wave` hook

- New `PlaybookHookName` `after_each_wave`. Default milestone playbook step:
  `{ key: "accept", role: "qa", proofStep: true, name: "Write and run the acceptance suite for the merged stories against the integrated app, triage every failure, and record the gate result" }`.
- **Position:** when the milestone is quiescent and `merged` stories exist and no gate is open, the
  maneuver is `run_hook after_each_wave` (Autopilot runs it; Copilot/Manual get the existing
  `hook_due` decision — see open question 1). While a gate runs or its fix stories are open, dispatch
  is empty with the reason "waiting for wave N's acceptance gate".
- **Worktree:** the hook runs in a fresh worktree at the integration head (like conflict resolution),
  with the workspace's environment (`106.11`) and services started from the recipe. QA's write scope is
  the checks directory and scratch, as in `109.01`.
- **Kickoff note** (replaces `authorStepNote`): the batch's stories and criteria, the existing suite
  and page objects to reuse, decision 5's locating rules, the no-recipe fixture guidance from this
  branch when there's no recipe, `run_checks` (whole suite by default), and the triage outcomes.
- **Recording:** a new tool `record_gate` (or `record_proof` with a gate shape): per story, per
  criterion — outcome (decision 7), `checkIds`, evidence, and for `app_bug` a short description of what
  the app does wrong; for `check_fixed` the justification. The harness verifies it against the step's
  recorded `run_checks` results: a `passed` or `check_fixed` criterion needs a passing result after the
  last change to its checks; an `app_bug` needs a failing one; every criterion in the batch and every
  earlier criterion whose check failed this run must be classified.
- **After the step:** the harness commits the checks directory on the integration branch (fast-forward;
  the barrier guarantees nothing else merged meanwhile), stores the gate record, marks batch stories
  `done` whose criteria all passed, and creates fix stories (decision 8) or the escalation (decision 9).

### Gate record

New table `wave_gates`: `id`, `milestone_id`, `round` (1, 2, … per milestone), `story_ids` (the
batch), `status` (`running` | `passed` | `fixing` | `escalated` | `failed`), `playbook_run_id`,
`report` (JSON: per story/criterion outcome, check ids, evidence, check changes), `checks_commit`,
`created_at`, `finished_at`. Fix stories carry `gate_id` and `fixes: { userStoryId, criterionId }`; the
cap counts gates where a criterion was `app_bug`.

### What happens to `109.02`'s machinery

- **Kept and reused at the gate:** the manifest format and validation, `run_checks`, the Playwright
  runner, retries/flake, `unreachable` classification, the no-recipe reachability lint (moves from
  `completeAuthorStep` to gate recording), evidence directories.
- **Removed from the story flow:** the `checks` step, freeze/drift/refreeze, `checksDriftBlock`,
  `builderStepNote`'s "make the QA checks pass without editing them", `outsideWrites` on the checks step.
  Freeze stays meaningful at the gate only as "the checks committed by gate N", which the next gate
  diffs to show changes to already-passed checks.
- **Kept from this branch:** the app launch preflight and the greenfield "first story alone" rule
  (story-level exploration still needs a running app); the planner's walking-skeleton guidance.

## Slices

| Slice | Delivers | Decisions |
|---|---|---|
| `110.01` | `merged` status, readiness/barrier in position and runner, `wave_gates` table, `after_each_wave` hook plumbing and Navigator maneuver (gate step can be a no-op that passes) | 2, 3, 4, 12 |
| `110.02` | The gate step: worktree at the integration head with services, kickoff note, `record_gate` and its verification, committing the suite | 5, 6, 7 |
| `110.03` | Fix stories from `app_bug`, fix-round cap, the gate escalation and its three actions | 8, 9 |
| `110.04` | Story-level exploratory proof: drop the `checks` step from the default story playbook, rewrite the `test` step note and the QA prompt for exploration | 1 |
| `110.05` | Conflict resolution smoke step, the same three actions on its escalation, health de-duplication and reset | 10, 11 |

`110.01` first (everything keys off `merged`). `110.02` needs `110.01`. `110.03` needs `110.02`'s
triage. `110.04` can land with `110.02` — until then stories still author checks, and the gate simply
starts from them. `110.05` is independent after `110.01`.

## Tests

- Position: a quiescent milestone with `merged` stories yields `run_hook after_each_wave`; dispatch is
  empty while a gate is due/running/fixing; a dependent of a `merged` story isn't ready; the last gate
  passing makes the milestone complete-able.
- Integration: a merge lands as `merged` with the gate hook present, `done` without it.
- Gate recording: each outcome's evidence rule; unclassified failing criteria refused; `check_fixed`
  on an earlier criterion flagged; the suite committed on the integration branch, pass or fail.
- Fix stories: one per `app_bug`, correct acceptance/touch hints/origin; applied in Copilot/Autopilot,
  proposed in Manual; the cap escalates with the three actions, and each action does what it says.
- Story proof: an exploratory proof with evidence is accepted; one citing only builder tests is
  refused (`109.05` unchanged).
- Conflict smoke step: no proof gate on frozen checks; app start + project tests; escalation actions.
- Health: no auto-pause on an anchor with a pending user decision; polishing counts reset on decision.
- Regression replay: quick-list run 3's two stories — the gate writes one AC-2/AC-3 suite against the
  merged UI and passes, or creates one fix story, never loops.

## Risks and open questions

1. **Copilot and Manual.** Hooks run themselves only in Autopilot today. Should the gate also run
   itself in Copilot (it's verification, not a decision), leaving Manual to the user? Recommendation:
   yes for Copilot.
2. **Checks written after the build can confirm the build.** Mitigated by decision 5 (criteria words
   first, the UI only for locating) and by a different seat (QA) writing them than built the code.
   Visible, not impossible — same stance as `109`.
3. **QA weakening checks.** `check_fixed` is the escape valve for over-specified checks and also the
   path to weakening a real check. Justification + diff in the report + highlighting changes to
   already-passed checks. Should changes to earlier checks need the lead's approval? Start with
   visibility.
4. **Later feedback.** A badly wrong story is caught at story exploration, but a subtle one only at
   the gate, after it merged. Fix stories handle it; undoing a merged story stays manual.
5. **Gate cost.** One extra QA run per wave plus the growing suite. Bounded by suite runtime; the
   gate can run only the batch's tags plus a smoke subset if suites get slow (later).
6. **No recipe at the gate.** The gate needs the app. With no recipe, the no-recipe fixture guidance
   applies; the preflight from this branch should already have offered a recipe after the first wave.
7. **In-flight features.** The gate is decided when a merge lands, by the milestone playbook at that
   moment. Resetting playbooks mid-milestone means stories already `done` stay `done` and later merges
   become `merged`, so the first gate's batch is only the later stories; it still re-runs any suite
   that exists. Stories authored under `109.02` already have manifests in the same format, so the
   first gate adopts them as its starting suite. Should Reset to default warn when a milestone using
   the playbook is in flight?

## Out of scope

- Partial barriers (starting next-wave stories whose own dependencies passed while the gate runs).
- Running the gate's suite in CI or on landing to `main`.
- Automatic reverts of merged stories.
- Visual regression and screenshot diffing (as in `109`).
