# PR109: QA seats that verify independently — checks, running apps, and a seat browser

> Status: **IN PROGRESS** (parent; delivered as `109.01`–`109.06`; `109.01`, `109.02`, and `109.03` done 2026-10-03). Follow-up to `106.3` (playbooks and proofs), `106.5` (worktrees), and `106.11`
> (worktree setup). Uses the current names: Features, Milestones, User stories.

## Context

In Mission Control, the `qa` seat runs the default user story playbook's `test` step and the
milestone's `reverify` step. Both are proof steps. In practice the QA seat can only rerun the tests the
builder wrote and record that they pass. Here's why:

- **Seats have no browser.** Browser tools are offered only when the caller passes `provideBrowser`
  (`src/main/agent/index.ts` ~1215). The live chat path passes it. The Process runner
  (`src/main/tasks/process/service.ts`, the `runAgentLoop` calls) and seat sessions
  (`src/main/mission-control/sessions.ts`) don't. A QA seat never sees a `browser_*` tool.
- **Nothing tells QA how to run the app.** A `work` turn keeps the seat's whole toolset
  (`seat-tool-profile.ts`), so QA can run shell commands, including background ones. But nothing says
  how this project starts, on which port, or when it's ready. In parallel worktrees, two seats starting
  the same dev server would collide on the port. `106.11` worktree setup prepares a worktree's
  *environment* (links, installs). It doesn't describe how to *run* the app.
- **The QA prompt discourages writing checks.** `agents/qa-agent.agent.md` says "you verify and report;
  you do not fix". A model reasonably reads that as "write no files", so it doesn't write Playwright
  scripts, HTTP probes, or scenario scripts either.
- **Independence is checked on identity only.** `proof.ts` refuses a proof whose verifier built the
  user story. If every `met` criterion cites tests the builder wrote, the builder still graded its own
  work.
- **Criteria that only the UI can show have no honest path.** They end up `not_verifiable` (with
  `accept_proof` rights) or `met` on code reading, which the QA prompt forbids but the seat has no
  alternative to.

No accepted-but-broken proof has been observed yet. This is a structural gap, closed before it costs us.

## Goal

A QA seat verifies a user story with evidence it produced itself, against the running app:

1. It writes its **own acceptance checks** from the spec, before the build exists, and the builder
   can't quietly edit them.
2. The **harness starts the app** for it (ports assigned, readiness awaited, torn down afterwards), for
   any kind of project the user builds.
3. It can **drive a browser** in the background, and the user can opt in to watching it.
4. The proof records **how** each criterion was verified. The gate refuses proofs that rest only on the
   builder's tests or on reading code.

We don't know what users will build (web apps, Electron apps, CLIs, APIs, libraries), so nothing here
assumes a web stack. The browser and Playwright are tools for UI projects, not requirements.

## Product decisions

1. **QA writes checks, never product code.** A QA seat can write only under its **checks directory**
   (decision 2) and the run's scratch area. Every other workspace path is read-only to it. This is
   enforced at the tool boundary (write/edit/apply_patch/filesystem lifecycle tools), not just in the
   prompt. Shell commands can't be path-confined, so the prompt also says not to modify product code,
   and the test step's diff check (decision 5) catches violations.
2. **Checks live in the repo, as shared test code.** Default checks directory: `e2e/` (a workspace
   can point it elsewhere). Checks are organized by what they test, not by user story: page objects,
   fixtures, and specs by product area, following the project's own structure when it has one, so
   stories reuse page objects instead of duplicating them. A story is traced by its tag
   `@<feature>.<milestone>.<story>` and its manifest `<checksDir>/stories/<storyRef>.json`. The checks
   are committed on the user story branch, so they merge with the code, the user can re-run them like
   any other tests, and `reverify` can re-run them after a conflict resolution. (Revised during
   `109.01`: originally one hidden folder per story, which duplicated test code.)
3. **Checks are commands.** A check manifest (the story's `stories/<storyRef>.json`) maps each
   acceptance criterion to one or more executable checks. Each check has a command, a cwd, the app
   services it needs (decision 6), and a timeout. Whatever the command runs is up to the check: a
   Playwright spec, `curl` against an API, a CLI invocation with expected output, a pytest file. QA uses
   the project's existing test framework when there is one. When the project has none, QA writes plain
   scripts, or Playwright checks on North Star's bundled runner for UI criteria (decision 11). It
   **does not** add dependencies to the user's project (no `npm i -D @playwright/test` behind the
   user's back). Adding a framework is a proposal (`propose_followup`), not a side effect.
4. **QA writes checks first (new default playbook step).** The default user story playbook becomes
   **Spec → Author checks → Build → Test**:

   | Key | Name (imperative) | Role | Notes |
   |---|---|---|---|
   | `spec` | (unchanged) | builder | |
   | `checks` | Write acceptance checks for each criterion from the spec (do not read or wait for the implementation; edit only the checks directory) | qa | new |
   | `build` | Build the user story to its acceptance criteria; make the QA checks pass without editing them | builder | name updated |
   | `test` | Run the QA checks, test the running app against each criterion, and record the proof | qa | proof step, name updated |

   Some criteria can't be checked mechanically before the code exists (exact copy, visual layout). The
   `checks` step marks those `exploratory` in the manifest, and the `test` step must verify them by
   driving the app. Users who don't want the extra step edit the playbook or write their own (`106.3`:
   playbooks are ordinary after creation).

   **Existing workspaces:** default playbooks already created stay as they are, because they're user
   data now. The new step ships in the template used when a default is created. The Playbook picker gets
   a "Reset to default" action that shows a diff and asks before overwriting.
5. **The builder can't silently change QA's checks.** When the `checks` step completes, the harness
   records a content hash of the checks directory on the phase run. At the start of `test`, it rehashes.
   If the checks changed, the test step's kickoff lists the changed files, and the proof can't be
   `accepted` until QA reviews the diff and either re-freezes the checks (QA edited them for a
   legitimate reason) or rejects. That's the same idea as freeze-on-accept for proofs. The builder may
   *read and run* the checks, which is the point.
6. **The harness starts and stops the app (app launch recipe).** It lives on the workspace, next to
   `worktreeSetup`: `appLaunch: { services: AppService[] }`, where each service has:
   - `key`, `label`, `command`, `cwd`;
   - `port`: `"auto"` (harness picks a free port) or a fixed number, plus `portEnv` (default `PORT`).
     `{port}` and `{port:<serviceKey>}` placeholders are substituted in `command` and `env`, so a
     frontend can find its backend;
   - `ready`: `{ http: "/health" }` or `{ log: "<regex>" }`, plus a timeout;
   - `dependsOn: string[]`.

   A new **`app_start` / `app_status` / `app_stop`** tool family (QA and builder seats, `work` profile
   only) starts the services in the current worktree, waits for them to be ready, and returns their
   URLs. All services a phase started are torn down when the phase ends, whatever the outcome, through
   the existing command-session process-tree cleanup. Checks that declare `services` get them started
   automatically by the check runner. `106.11` workspace analysis gains a finding type that proposes an
   `appLaunch` recipe from evidence (`package.json` scripts, `Procfile`, `docker-compose.yml`, framework
   defaults). Like setup steps, it persists commands, so it always needs an explicit **Apply**.
   Projects with nothing to launch (libraries, CLIs) leave it empty. Their checks just run commands.
7. **Seats get a background browser, with origin limits.** Seat turns in a `work` profile get the
   browser tools, minus `browser_handoff`. There's no human waiting in a headless phase. A login wall
   becomes an escalation through seat comms, or `not_verifiable` with a reason. A seat browser:
   - gets **its own tab per seat run**, keyed by the worker conversation (the existing `BrowserManager`
     tab model), with a **non-persistent partition per run** (`agent-browser-seat:<runId>`, no
     `persist:`). It never shares the user's `persist:agent-browser` cookies or logins, and parallel QA
     seats never see each other's state;
   - may navigate only to **loopback origins** (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`) and
     origins the launch recipe produced. Anything else is refused at the tool with a clear error.
     A seat verifying the user's app has no business on the open web, and this keeps an autonomous,
     auto-mode browser away from real accounts;
   - runs with `backgroundThrottling: false`, so a hidden page still paints, screenshots, and runs
     timers;
   - is closed (tab and partition) when the phase ends;
   - is subject to a global cap on concurrent seat browser tabs (default 3). Further browser calls wait
     for a free slot instead of failing.
8. **A setting to watch it, off by default.** **Settings → General → Browser** gets a second switch
   under "Show the browser when the agent uses it":

   > **Show the Mission Control browser when the agent uses it**
   > Show a seat's browser tab when a Mission Control agent (such as QA) drives the app it's testing.
   > When off, seat browsers run hidden in the background.

   `BrowserSettings` gains `revealMissionControl: boolean` (default `false`), loaded and normalized like
   `revealOnAgentUse`. When on, a seat's tab is created as a visible tab in the **Agent Browser window**
   (not the sidebar, which follows the conversation being viewed), labelled with the seat address and
   user story (`qa@pod-1 · US-12`). The window comes forward on the seat's first navigation, not on
   every one. Toggling the setting mid-run applies at the seat's next navigation. The user can watch
   but must not interfere: user input on a seat tab is allowed (it's their machine), but the seat's
   next snapshot shows the real page state, so nothing breaks.
9. **Proofs record how each criterion was verified.** Each proof criterion gets
   `method: "qa_check" | "app_exercised" | "builder_tests" | "command" | "code_read"`. For
   `qa_check`, it also gets `checkIds`. For `app_exercised`, it gets artifacts (screenshots, console and
   network excerpts, saved in app data under `evidence/<phase-run-id>/`, not in the repo). The gate in `proof.ts`:
   - `code_read` alone can't be `met`. It must be `not_verifiable` with a reason;
   - a criterion the manifest covers with a QA check can't be `met` unless that check ran and passed in
     this test step (the check runner records results on the phase run; the model can't claim them);
   - an `exploratory` criterion needs `app_exercised` evidence with at least one artifact;
   - `builder_tests` alone is allowed for `met`, but adds a proof warning shown on the user story.
     Some criteria really are internal.
10. **The QA agent prompt is rewritten** around this: write checks first; run the app through
    `app_start`; drive it through the browser for UI work; save evidence; never touch product code;
    report what wasn't verified. Remove "you do not fix" phrasing that blocks writing checks, and keep
    "you do not fix product code."
11. **North Star bundles the Playwright test runner, not the Playwright MCP.** QA can write Playwright
    checks in any workspace, whether or not the project has Playwright, without adding a dependency to
    the user's project (decision 3 still holds). The app ships `@playwright/test` without browsers and
    runs it with its own Electron as Node, so users don't need Node installed. Browsers come from the
    workspace's own Playwright, the user's installed Chrome, or a one-time consented download into app
    data, in that order. Details in `109.06`.

    **The Playwright MCP was considered and rejected.** It does the same job as the seat browser
    (`109.04`): live, ref-based page driving. Shipping both would give the model two overlapping
    browser toolsets to choose between inconsistently. It would also mean a second safety model: the MCP
    launches its own Chromium, so the origin guard, per-run partitions, concurrency cap, phase-end
    teardown, and the reveal setting would all need to be rebuilt as MCP flags and kept in sync. The
    runner adds what the seat browser can't (durable, re-runnable checks, and Electron apps through
    `_electron.launch`). The MCP adds nothing it can't.
12. **Each tool's job is stated where the model chooses it.** QA has two ways to test a UI: Playwright
    checks through `run_checks`, and the seat browser. The rule is **explore with the browser, assert
    with Playwright**. It's stated in three places: the tool descriptions, the QA agent prompt, and each
    step's kickoff (`109.06`).

## Slices

The work ships as six slices, each in its own plan file, in dependency order. This file holds the
shared context, product decisions, risks, and scope. The slice files hold the implementation detail.

| Slice | Plan | Delivers | Decisions |
|---|---|---|---|
| `109.01` | [QA write scope and prompt](109.01-qa-write-scope-and-prompt.md) | QA can write only to its checks directory; the QA agent prompt is rewritten | 1, 2, 10 |
| `109.02` | [Acceptance checks and the checks step](109.02-acceptance-checks-and-checks-step.md) | Check manifest, `run_checks`, the new `checks` playbook step, freeze hash | 3, 4, 5 |
| `109.03` | [App launch recipes](109.03-app-launch-recipes.md) | Per-workspace launch recipe, `app_start` / `app_status` / `app_stop`, teardown | 6 |
| `109.04` | [Seat browser](109.04-seat-browser.md) | Background browser for seats, origin guard, the Mission Control reveal setting | 7, 8 |
| `109.05` | [Verification method in proofs](109.05-proof-verification-method.md) | `method` per proof criterion and the stricter proof gate | 9 |
| `109.06` | [Bundled Playwright runner](109.06-bundled-playwright-runner.md) | Playwright checks in any workspace, browser resolution, tool-choice guidance | 11, 12 |

`109.01` must land before `109.02`, because the `checks` step needs the write scope. `109.03` and
`109.04` are independent of `109.02` and of each other, but `109.04`'s origin guard allows the URLs
that `109.03` returns, so `109.04` should land after `109.03`. `109.05` needs `109.02`'s recorded check
results and `109.04`'s saved evidence. `109.06` needs `109.02`'s manifest and `109.03`'s app URLs, and
its tool-choice guidance assumes `109.04`'s browser, so it lands last.

## Risks and open questions

- **Electron apps under test.** The seat browser can't drive an Electron app. `109.06` covers them with
  Playwright's `_electron.launch` through the bundled runner. Until `109.06` ships, QA falls back to
  scripted checks plus code-level evidence, and the proof says so honestly.
- **Shell escapes the write scope.** A QA seat can still `echo > src/x.ts`. The prompt, the diff
  reported in the test step, and the builder/QA split make this visible, not impossible. Is visible
  enough? (We think yes. Real sandboxing is `067`'s territory.)
- **CLI-provider seats** (Claude Code, Codex) run their own loop. Proof steps on them are already
  refused (`106.3`). The `checks` step on a CLI seat gets the scope only in the prompt. Getting browser
  and app tools to them would go through the `045` MCP bridge, which is out of scope here.
- **Flaky checks.** `run_checks` reruns a failing check once and records both results. Persistent flake
  is a finding, not a pass.
- **Cost.** One more phase per user story. Accepted: users can drop the step from the playbook.

## Out of scope

- Visual regression, screenshot diffing, and video recording.
- Testing mobile apps (simulators/emulators).
- Letting seat browsers reach non-local origins (staging URLs). Could become an allowlist on the launch
  recipe later.
- Changing who fixes failures: a rejected proof still flows back to the builder as today.
