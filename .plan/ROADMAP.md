# Roadmap

Intended order of work. Plan files are numbered by **creation order** (stable IDs —
never renumbered, referenced by number in git history). This file is the **priority
order**, and is meant to be reordered freely as needs change. The number next to each
item is its plan file, not its rank.

## Next up

1. **`036` — Agent import.** Extends `027` (create/edit/delete) with **import** of one-or-more
   **`.agent.md`** files — validate each parses (`parseAgent`) and its frontmatter `name` **equals the
   file stem** (the loader's hard rule), then **copy verbatim** (no `serializeAgent` round-trip — a
   hand-tuned agent imports byte-for-byte) into a writable root (`027`'s `writableAgentRoots()`).
   Simpler than `035` — an agent is a **single flat file, no zip**. Best-effort per file (one bad file
   errors; the rest land). An **Import** affordance beside New agent; collision / name≠stem → **reject
   that file, import the rest** (Q1/Q3). Import-only. Independent.
2. **`038` — Sub-processes. ⚠️ DESIGN-PENDING.** A Process **phase runs another Process** as a nested
   run (composition of `025` with itself) — e.g. an "Implement" phase delegates to a reusable
   best-practices sub-process. `process_phases.subprocess_id` (FK → a definition; mutually exclusive
   with the agent pool) + `process_runs.parent_phase_run_id` (additive `SCHEMA_V20+`). Dispatch branches
   in `makeRunPhase`: a sub-process phase starts a **nested run inline** (the `spawn_subagent` precedent
   — no re-enqueue/deadlock, under the parent's `PER_RUN_CONCURRENCY` pool), whose aggregated output
   becomes the phase's output for downstream `collectUpstream`; completion/fail propagates like a
   fan-out parent. **Bounds mandatory** (the DAG has no cycle guard): a `MAX_PROCESS_DEPTH` counter +
   an **author-time acyclicity check** on `subprocess_id` refs (reject a cycle) + runtime backstop.
   Monitor nests the sub-process's phase-runs under the phase. **Ordered before `037`** so process
   import/export accounts for the `subprocess_id` reference in its format. **Likely splits:** `038.1`
   end-to-end sub-process phase; `038.2` gates/fan-out edge cases + resume-reattach. Open Qs:
   inline-vs-enqueued (lean inline), depth/cycle bounds, per-fan-out-child invocation (deferred).
3. **`039` — Inspectable agent-to-agent messaging. ⚠️ DESIGN-PENDING.** One phase-agent (B) **asks
   another phase-agent (A) a question**, answered **from A's own context** — distinct from
   `spawn_subagent` (a fresh, context-less child). The `025` engine makes each phase-run's **worker
   conversation** addressable (`makeRunPhase` stamps a `taskId`/conversation per phase-run), so a gated
   **`ask_agent`** tool: writes a durable `process_messages` row (`pending`), **injects the question
   into A's existing conversation**, runs **A's `runAgentLoop` one turn** (A answers from its history),
   then returns **{question + A's answer}** to B (B's transcript records both) while A's transcript keeps
   the **{incoming question + answer}** — both sides retain full context. Inline + **bounded** (per-run
   message cap + reentrancy/cycle depth guard — mandatory). v1 **asks only completed phases** (settled
   context, no mid-flight race); same-run targets only. Monitor renders the A↔B thread off a
   `process_phase`-style event (no new channel). **Likely splits:** `039.1` completed-target round-trip
   + storage + monitor; `039.2` asking a running agent (queued) + richer targeting. Open Qs above.
4. **`037` — Process import / export.** Unlike `035`/`036` (files already on disk → import-only), a
   Process lives **only in the DB** (`025` tables), so it needs an explicit **serialize ⇄ deserialize**
   to be shareable — the sharing use case you called out. **JSON** interchange (`ProcessExport`,
   `formatVersion`-guarded): **id-free**, edges reference phases by **`key`** (unique per process) so
   import mints fresh ids collision-free; agent pool carried as **names**. **Export** = build from
   `getProcessGraph`, drop ids, save dialog. **Import** = parse + validate (unique keys, every edge
   endpoint resolves, enums valid) then **replay through the existing granular CRUD in one
   transaction** (`createProcess`→`createPhase`×N→key→newId map→`createEdge`/`createPhaseAgent`) — no
   new write path, same invariants as `026`. Round-trips (export→import ≡ original modulo ids). Missing
   referenced agents → **import + warn** (names resolve at run time; `025.3` router falls back) (Q2).
   Export is *definition only* (not run history). New `process/io.ts` + `processes:export`/`import` IPC +
   builder affordances. **Ordered after `038`** so the format carries a phase's `subprocess_id` — a
   sub-process reference exports **by definition identity** (name/a stable ref), and import resolves or
   flags a missing referenced sub-process (like `037`'s missing-agent warning).
5. **`033` — Live dashboards.** A new top-level surface (a **Dashboards** button in the sidebar footer,
   the 5th overlay alongside Processes/Agents/Skills/Settings) where a user **prompts an agent to author
   a dashboard** — a saved layout of widgets + a per-widget **data-fetch recipe** describing *how to
   pull the data*. **Data-source-agnostic by construction:** the agent fetches through whatever tools it
   has (today `run_shell`/Azure CLI, `web` fetch; **later MCP servers** — Jira, Azure DevOps), so
   dashboards inherit new sources **for free** as they land — this plan builds **no connectors** (MCP is
   its own effort). `recharts` is **already a dep** (no new chart lib). Mirrors `025`'s definition-vs-run
   split + bare-`TEXT`-repo-validated statuses: new `dashboards`/`dashboard_widgets`/
   `dashboard_widget_data` (cache) tables (additive, `SCHEMA_V20+`), a gated **`dashboard_write`** agent
   tool (like `todo_write`/`present_plan`), and a `dashboard_refresh` `009` durable task kind that
   **replays each widget's stored recipe** (deterministic-first, bounded-LLM-normalize only where
   declared) into the cache the view reads. **v1 "live" = manual/on-open/poll-while-open** (true cron is
   the backlog `cron` item). Full-viewport takeover (`dashboards-screen.tsx`, the `023` Radix pattern +
   `NativeSelect`). **Likely splits** (`025.x` pattern): `033.1` storage + overlay + view + a
   manually-authored widget; `033.2` the `dashboard_write` authoring tool; `033.3` the refresh executor.
   **Crux Open Qs:** how re-runnable a recipe is without an LLM; approval/allowlist safety of a stored
   recipe re-running unattended on refresh; fixed grid vs drag-resize lib. Independent of the Process
   cluster.
6. **`034` — CLI-agent providers (Claude Code / Codex / Copilot).** Three new **provider kinds** that
   aren't LLM-API accounts but local **agentic CLIs** driven as subprocesses (`claude -p`,
   `codex exec`, `copilot -p`) — each *is* the agent (own loop + tools + approvals, editing files
   **in the project dir**). Selecting one **routes turns away from `runAgentLoop`** to a new subprocess
   runner (`agent/cli/`, per-CLI adapters behind one interface + `005`'s detached-process-group kill),
   **locks the backend to Local**, and **disables Chat mode** (these CLIs need a working directory;
   Chat has no workspace). Two consequences of never entering `runAgentLoop`: **(a) none of our
   internal tools / skills / index / `ContextBuilder` sections / approval gate apply** — the CLI brings
   its own tools, prompt, and context; **(b) every turn is always "auto"** — a no-TTY subprocess can't
   prompt, so auto-allow is **inherent, not a choice** (no "Ask" mode to add later). Both surfaced in
   the UI. **Research done (verified live 2026-08-07; pin versions):** session continuity is
   **non-uniform** — Claude + Copilot **self-assign** a UUID we generate (`--session-id`), Codex
   **mints its own** `thread_id` we must **parse from turn-1 JSONL and resume** (`codex exec resume
   <id>`). So a per-conversation **`cli_session_id`** (additive `SCHEMA_V20+`) is assigned-by-us OR
   captured-from-turn-1. No API key — a **binary path + `--version` health check** + default model +
   auto-posture permissiveness (`--permission-mode`/`--allowedTools`; Copilot **requires**
   `--allow-all-tools`; Codex `-s workspace-write`). **Likely splits:** `034.1` Claude Code end-to-end
   (+ backend-lock + mode-gate + tools-bypass + auto UI), `034.2` Copilot (same self-assign model),
   `034.3` Codex (extract-then-resume). Open Qs: default auto-posture permissiveness (lean
   workspace-write/edits-allowed); streaming fidelity (text-first; Copilot JSONL fields unverified);
   out-of-band CLI auth. Independent of the Process cluster / dashboards.
7. **`032` — Process visual canvas.** The explicitly-deferred half of `026` (which shipped the
   **list-based** DAG builder and recorded a **visual node/edge canvas** as "later"). Renderer-first +
   one additive migration; **no engine/scheduling/routing change**. Phases become draggable **nodes**,
   dependencies **edges** drawn between handles (same `on_complete`/`on_each_subtask` trigger, same
   per-phase routing/gate/fan-out/agent-pool inspector), all mapping 1:1 onto the existing
   `db:processes:*` CRUD (mutate-then-refetch). Net-new: `SCHEMA_V19` adds nullable `pos_x`/`pos_y` to
   `process_phases` (a plain `ADD COLUMN` — the `025` tables avoid CHECK-rebuilds by design) so layout
   persists, with deterministic **auto-layout** for legacy definitions (`NULL` coords) + a **Tidy**
   action; a new `process-canvas.tsx` + the phase inspector extracted for reuse by both the list card
   and the canvas node. Open Qs: canvas lib (lean **`@xyflow/react`** lazy-loaded, `dagre`/built-in for
   layout — watch the ~2.6 MB renderer bundle) vs hand-rolled SVG; keep the list builder as a coexisting
   toggle vs replace (lean **coexist**). The Radix-`Dialog` takeover means the inspector keeps
   `NativeSelect` (the `023`/`026` `pointer-events:none` finding). **Live-run-on-canvas deferred** — v1
   keeps the `026` nested-list monitor. Independent of `029`/`031`.
8. **`020` — Durable memories.** The cross-conversation memories section `014` reserved: small,
   persisted facts the agent writes (a **gated, explicit** `remember` tool — no silent profiling)
   and that inject into future turns, **scoped** global / workspace / conversation (mirrors the
   `action_allowlist` scoping). New `memories` table + a list/delete surface (durable +
   cross-conversation ⇒ must be auditable/revocable); a `memoriesSection` renderer with an injection
   cap. Split out of `014` Q2.
9. **`010` — Container runtime profiles.** Decouple Workspace (the files) from Runtime (the env a
   tool call executes in). Replace the raw container `image` string with a named **profile**
   (`node` | `python` | `fullstack`), resolved to an image in the env factory; default/fallback =
   `fullstack` (Node + Python) so a Node repo that later adds a Python backend doesn't wedge.
   One profile per conversation, user-overridable in settings. Kills the "one workspace = one image
   forever" assumption **without** building auto-routing or image management (both deferred). Small
   refactor of `env/factory.ts` + `container.ts` + execution settings (JSON blob — no migration).
10. **`005.1` — ContainerEnvironment stop in-flight.** The deferred half of `005`: killing the host
   `docker/podman exec` client doesn't stop the in-container process. Needs its own kill mechanism
   (in-container PID tracking / `exec kill`, or marker `pkill`). Out of scope when `005` shipped.
11. **`007` — Slash commands for skills.** Let users force a skill with `/skill-name …` (pre-inject
   the `read_skill` call), keeping today's model-discretionary path for plain messages. Adds a
   `skills:list` IPC channel + composer autocomplete. Independent — schedule freely.
12. **`018` — Agentic goal mode. ⚠️ SUPERSEDED by `025`** (the general Process engine — 018's fixed
   pipeline becomes one built-in Process *template*; kept as a stable-ID file per convention, not
   built as its own orchestrator). An opt-in **execution mode** (orthogonal to chat/interactive/
   north_star): `simple` (today's one-pass behavior, default) vs `goal` (bounded **plan → execute →
   review → fix → finalize**, capped by `maxIterations` — never unbounded). Modeled as a task-level
   orchestrator inside the runner's `runOne` (one task / one forked conversation, calling
   `runAgentLoop` once per phase), so it works for foreground AND background and inherits durable
   events, crash-resume, and cancellation for free. First real consumer of the unused `checkpoints`
   table (one checkpoint per phase = the resume cursor) and a new `phase_change` task event. Reviewer
   is **deterministic-first** — tests/lint/build/file-existence/`git diff` via `Environment.exec`,
   with an LLM review that *supplements* (can't flip a hard check failure). Manual invocation only this
   PR (`/goal <request>` — reuses `007`'s composer slash-command affordance — + a "Run with review
   loop" button); the Always/Ask/Manual/Off **setting is deferred** to its own plan. Placed by `007`
   since both add `/`-command composer UI.
13. **`024` — Index filesystem/git watcher.** The "live file watching" follow-up `008` deferred (and
   `014` re-deferred). Today the workspace index — and the compact summary `buildIndexSummary`
   injects into the system prompt on every message send — only refreshes when `IndexService.
   ensureRunning` is called, which fires on conversation create/update or manual Start/Rebuild;
   **nothing watches the filesystem or git**. So the injected summary drifts (file counts, metadata,
   symbol count, and most visibly the **git branch** — the one field that changes on a `git checkout`
   with an identical working tree, so the hash-skip `file_map` finds zero dirty files and never
   re-runs). Adds an `IndexWatcher` (main-process, long-lived listener — not a `009` task) that
   debounces workspace changes and kicks an **incremental** `ensureRunning` (`low` priority), plus a
   targeted `.git/HEAD`+refs watch for branch/sha freshness (metadata-only refresh seam so a branch
   flip needn't pay for a tree walk). Reuses `loadGitignore`/`DEFAULT_SKIP_DIRS` + `readGitBranch`;
   gated by a new **"Watch workspace for changes"** toggle in the Workspace Indexing settings group
   (global store, no migration). Open Qs: watcher mechanism (`chokidar` vs core `fs.watch` vs
   `@parcel/watcher`), watch scope/lifetime, debounce window, churn backpressure. Placed after `018`.

## Done

- **`035` — Skill import (.md / .zip) with drag-and-drop upload modal.** Built on `feat/skill-import`
  (off `main`; commit `4fc4a39`; not yet merged). Extends `028`'s create/delete with **import from
  disk**. New **`agent/skills/import.ts`** — `importSkillFromMarkdown` (read → `parseSkill` frontmatter
  → `validateName` → collision-check via `existsSync` → write the file **verbatim** as
  `<root>/<name>/SKILL.md`) and `importSkillFromZip` (**`adm-zip`**, main-process only). The zip path
  enforces **entry-count / per-entry / total-size caps** (zip-bomb guard), a **zip-slip guard**
  (`normalizeEntryName` rejects absolute / `..`-escaping paths), and a **single-`SKILL.md` layout
  normalize** — accepts the archive root **or** one wrapping top-level folder (`foo/SKILL.md`), rejects
  zero/multiple/mixed. **macOS Finder cruft** (`__MACOSX/`, `.DS_Store`, `._*` AppleDouble forks) is
  filtered before the layout check + extraction, so a Finder-"Compress"'d folder imports cleanly
  (extract-to-temp then `cpSync` into place so a partial extraction never pollutes the root). Reuses
  `028`'s `writableSkillRoots()`; the loader's `parseSkill` + `MAX_SKILL_FILE_SIZE` were **exported**
  for the validation path. **IPC/preload:** `skills:import` (dispatch on extension), `pick-skill-import`
  (native single-select `.md`/`.markdown`/`.zip` picker), `skills:reveal` (`shell.showItemInFolder` —
  Finder/Explorer), plus `getPathForFile` (a `webUtils` bridge — **Electron 37 removed `File.path`**, so
  a dropped file's path comes from `webUtils.getPathForFile`). **Decisions (Open Qs):** Q1 collision →
  **reject with a message**; Q2 zip layout → **accept root or one wrapping folder**; Q3 name → **from
  frontmatter, authoritative**; Q4 unzip lib → **`adm-zip`**. **Renderer:** a new
  **`skill-upload-modal.tsx`** — the "Upload skill" `Dialog` with a dashed **drag-and-drop OR
  click-to-pick** drop zone, a `NativeSelect` location picker (>1 writable dir; `NativeSelect` not Radix
  `Select` per the `023`/`026` `pointer-events:none` finding), and a file-requirements list; an
  **Import** button in the Skills toolbar (replaced the earlier in-panel import mode); and a **"Show in
  Finder/Explorer"** button in the skill view header. Also **hid the conversation-specific
  Info/Browser/Changes mode dropdown + the right-panel toggle** while the Skills/Agents/Processes
  overlays are open (theme toggle kept, via a `showModeSelect` prop on `SidebarModeToggle`). Verified:
  `pnpm typecheck` + `pnpm build` clean (the 3 residual typecheck errors — `open.test.ts`,
  `service.test.ts`, `runner.test.ts` — are **pre-existing on clean HEAD**, confirmed via `git stash`);
  new **`import.test.ts` (16 pass)** — md happy-path + verbatim write, bad frontmatter / bad name /
  collision; zip root-layout with a `scripts/helper.sh`, wrapping-folder flatten, **zip-slip reject**
  (crafted via mutated `entryName` since adm-zip sanitizes `../` on `addFile`), multiple/mixed/no
  `SKILL.md`, too-many-entries, **macOS `__MACOSX`/`.DS_Store` cruft ignored**; plus the exported
  `parseSkill`. **Live-verified** by the user (import works correctly). **Out of scope (as planned):**
  skill export (a folder is already shareable); marketplace / remote fetch; editing workspace-root
  skills. Agent import → `036`; process import/export → `037`.
- **`031.2` — Process cross-phase flag-back (+ autonomous routing, full container support).** Built on
  `feat/process-validator` (branches off `feat/process-engine-planning`; not yet merged to `main`). The
  riskier half of `031`: a phase-worker that finds a defect an **earlier** phase owns **flags it back**
  instead of fixing out of lane; the engine resets the target phase (or a single fan-out sub-task) **and
  everything transitively downstream** to `pending`, then re-walks. Generalizes the `029`/`031.1`
  reopen→feedback→bounded-re-run primitive **backward across the DAG**. **Storage** (`SCHEMA_V22`, two
  additive `ADD COLUMN`s + one new table, no rebuild — the `V19-V21` pattern):
  `process_definitions.require_flag_approval` (per-process autonomy toggle, default 1 = confirm);
  `process_phase_runs.source_child_run_id` (**first-class on_each_subtask lineage** — which source
  fan-out child a consumer instance consumes; promoted from the append-only `eachsubtask:` checkpoint so
  the **per-child** reset is a direct query); and a `process_flags` table (durable flag records, lifecycle
  pending→applied|dismissed, bare-TEXT status). **The reset core** is a new **`flagback.ts`** — one code
  path shared by the autonomous scheduler route and the human-confirm service route: `ancestorsOf`
  (reject a forward/self/unknown target — flags only go upstream), `downstreamClosure` (forward-edge BFS
  with a mandatory visited-set — the DAG has no cycle guard), `descendantChildRuns` (per-child downstream
  via `source_child_run_id`), and `applyFlagBack` branching **per-child** (reset only the flagged child +
  reopen its container `completed→running` + **delete** the descendant on_each_subtask instances so they
  re-trigger fresh from the reworked child's new output — siblings untouched), **whole-phase** (reset +
  `reworkNote`), and **whole-container** (delete children + `deleteCheckpoint` the `fanout:`/`eachsubtask:`
  rows so it re-decomposes/re-triggers clean — the previously-unused `deleteCheckpoint` is the key
  enabler). **Tool + threading:** a gated **`flag_for_rework({target, reason})`** tool (registered
  `otherTools`, marked UNIVERSAL so a restricted agent keeps it, offered **only** to a phase worker via a
  new `processRunId`/`processPhaseRunId` threaded through `RunAgentLoopOptions`→`ToolContext`→
  `makeRunPhase`); it validates the target via `resolveTarget`, writes a pending flag, and enforces a
  per-run cap (`MAX_FLAGS_PER_RUN=10`). Because a phase worker runs in `autoMode` (where `ctx.gate`
  auto-approves), the flag is **recorded durably and processed by the deterministic scheduler**, never
  resolved in the agent loop. Prompts gained a **"Phases you may flag for rework"** section listing
  upstream phases by **`key`** (the stable target vocabulary; `UpstreamResult` gained `phaseKey`, and the
  on_each_subtask kickoff carries its source phase's key). **Scheduler** routes pending flags at
  **quiescence** (the terminal-check branch, on an otherwise-successful run): autonomous → `applyFlag`
  inline + `continue`; confirm → `raiseFlagGate` (a distinct `process_flag_gate` approval kind carrying
  target+reason, so `gateRows`/`validatorGateRows` never cross-count) + `GateBlockedError` (run pauses).
  **Service** `confirmFlag`/`dismissFlag` (IPC `process:confirmFlag`/`dismissFlag` + preload) settle the
  gate and apply/skip the reset then resume. **Renderer:** an **"Autonomous rework routing"** `Switch` in
  the builder's definition meta, and a monitor **flag confirmation card** (target + reason + Approve
  send-back / Dismiss) built off a `flagGates` map reconciled from the durable approvals, mirroring the
  029 gate card. The `fanout:`/`eachsubtask:` checkpoint labels + state shapes were extracted to a shared
  `checkpoints.ts` (no import cycle). Verified: `pnpm typecheck` + `pnpm build` clean (the 3 residual
  errors — `open.test.ts`, `service.test.ts` `createPhaseRun({error})`, `runner.test.ts` — are
  **pre-existing on clean HEAD** and unrelated); new tests — **`flagback.test.ts`** (the correctness
  spike: traversal, target resolution incl. the per-child `sourceChildRunId` case, and all three reset
  branches with checkpoint surgery), `scheduler.test.ts` (+3: autonomous apply, confirm-gate,
  no-op-when-empty), `service.test.ts` (+3: confirm applies + resumes, dismiss leaves target intact,
  unknown-requestId no-op), `flag_for_rework.test.ts` (records/validates/rejects/cap/unavailable),
  `prompts.test.ts` (+2: flag section lists keys / omitted when no upstream), `migrations.test.ts` (v22
  table + columns + defaults); the latest-`user_version` assertions bumped 21 → 22 (×5). **Full suite 671
  pass** against a node-ABI `better-sqlite3` rebuild, Electron ABI restored after with
  `@electron/rebuild` (the 1 flaky `local.test.ts` SIGKILL timing test passes in isolation). Manual E2E
  deferred to a live session. **v1 scope-outs (documented):** mixed on_complete+on_each_subtask edges into
  one phase fall back to a whole re-run; a flag may target only a **completed** upstream phase/sub-task;
  LLM-agent flag sources only (no deterministic tests-as-flagger). **Completes `031`.**
- **`031.1` — Process per-phase validator.** Built on `feat/process-engine-planning` (branch
  `feat/process-validator`; not yet merged to `main`). The automatic same-phase half of `031` (the
  agent quality loop): an optional per-phase toggle runs a **second reviewer agent** after a phase's
  worker completes; it either approves the output or sends it back with feedback (reusing `029`'s
  `reworkNote` kickoff channel), bounded — on exhaustion the phase **escalates to a human gate**.
  Generalizes the superseded `018` `review → fix → review` loop. **Storage** (`SCHEMA_V21`, four
  additive `ADD COLUMN`s, no rebuild — the `029`/`030` pattern): `process_phases.validator` (toggle) +
  `validator_max_iterations` (0 = engine default `DEFAULT_VALIDATOR_ITERATIONS`=3; **never unlimited**
  — the DAG has no cycle guard) + `validator_agent` (the dedicated reviewer; NULL → the phase's
  `pool[0]`), and `process_phase_runs.validator_round` (the review-round counter, kept **separate from
  `rework_round`** so it never perturbs `029`'s count-based gate re-detection). **Engine:** a new
  injected `ctx.validate` (optional, like `decompose`/`buildEachSubtaskPrompt`, so inert when unwired);
  `makeValidate` forks a **reviewer worker** (mirrors `makeDecompose` — a real `runAgentLoop` so it can
  inspect the workspace/files, a *separate* conversation that does **not** overwrite the phase-run's
  taskId) and parses a strict JSON verdict (`validatorPrompt` + `parseVerdict`, a tolerant
  brace-matched scan mirroring `parseDecomposition`); an **unparseable verdict / errored reviewer fails
  OPEN (approve)** so a broken reviewer never wedges the run. The loop lives in `runPhaseWithRetry`'s
  success branch: reject → stash feedback + bump `validatorRound` + re-run the worker (kickoff re-reads
  `reworkNote` **fresh** from the DB); at the cap → `raiseValidatorGate` (a distinct
  `process_validator_gate` approval kind so `gateRows`/`needsGate` never cross-count) parks the
  phase-run `waiting_for_approval` and throws `GateBlockedError` (run settles `paused`). Dependents are
  held by the non-`completed` status alone (no new ready-set predicate); a walk-top
  `reconcileValidatorGates` flips an approved-gate phase → `completed` on resume. `requestChanges`
  (`029`) also resets `validatorRound: 0` so a human send-back grants fresh review rounds. **Renderer:**
  a **Validator** `Switch` in the phase inspector (non-fan-out only) revealing a reviewer-agent
  `NativeSelect` (default "Phase's own agent") + a "Max iterations" `Input`, plus a `validator` summary
  badge; threaded through the phases create/update CRUD (db-handlers + preload). Verified: `pnpm
  typecheck` + `pnpm build` clean (the 3 residual typecheck errors — `open.test.ts`, `service.test.ts`
  `createPhaseRun({error})`, `runner.test.ts` — are **pre-existing on clean HEAD** and unrelated); new
  tests — `scheduler.test.ts` (**+7**: reject-then-approve re-run, cap-then-escalate-to-gate,
  approve-gate-releases-dependents, engine-default cap, reviewer-error fails open, toggle-off no-op,
  `validatorRound` bumped/`reworkRound` untouched), `service.test.ts` (**+2**: full-executor
  reject-then-approve with feedback injected into the re-run kickoff; unparseable verdict fails open),
  `prompts.test.ts` (**+8**: `validatorPrompt` shape, `parseVerdict` tolerant cases),
  `migrations.test.ts` (v21 column presence + defaults); the latest-`user_version` assertions bumped
  20 → 21 (×3, plus two long-dormant `settings.test.ts`/`index-runs.test.ts` assertions that surfaced
  once the node-ABI rebuild let the DB suites run — 17 → 21). **Full suite 646 pass** against a node-ABI
  `better-sqlite3` rebuild, Electron ABI restored after with `@electron/rebuild`. Manual E2E deferred to
  a live session. **Deferred (as planned):** cross-phase flag-back + autonomous routing → `031.2`;
  deterministic/tests-as-validator reviewer.
- **`030` — Process artifacts: dot-folders + file chips + name-derived keys.** Built on
  `feat/process-engine-planning` (commit `882cdcc`; not yet merged to `main`). A `026` follow-up making
  a phase's *output* visible and openable, mostly renderer + one additive column. **030a — dot-folder
  toggle:** additive `SCHEMA_V20` `process_phases.dot_folder INTEGER NOT NULL DEFAULT 0` (pure
  `ADD COLUMN`, no rebuild — the `029` V19 pattern), threaded through `ProcessPhase`/repo (row/mapper/
  `createPhase`/`updatePhase`)/IPC/preload + a builder **Dot-folder** `Switch` and a `.<key>/` summary
  badge; `kickoffPrompt`/`eachSubtaskKickoffPrompt` gain an optional "Where to write files" section
  steering the agent to write under `.<phase.key>/` (an **agent convention**, not FS-enforced).
  **030b — file chips:** each phase card **and** each fan-out/on_each_subtask child row shows the files
  that phase produced as clickable chips — click opens in the selected IDE, hover shows a git-diff
  preview. **No new git machinery:** a new `PhaseFileChips` derives the list from the phase-run worker's
  own transcript (`phaseRun.taskId` → `tasks.get` → `messages.list` → `buildTimeline` →
  `changedFilesFromCalls`), fetched lazily per `(taskId, status)` so a running phase's chips refresh on
  completion; `ChangedFilesBar` refactored to accept a precomputed `files: ChangedFile[]`
  (backward-compatible with the two `App.tsx` `calls` call sites); `RunMonitor` resolves the run's
  workspace path via `workspaces.list()` (no `get`). **030c — human-readable phase keys** (added in
  build; drives 030a so the folder reads `.plan/` not `.phase_1_1/`): a `deriveKey(name, otherKeys)`
  (reuses `slugifyKey`, collision-suffixes `_<n>` against the DB's `UNIQUE (process_id, key)`); `addPhase`
  and the phase-name `onBlur` derive the key from the name, and the manual key field becomes a read-only
  display. Safe because the key is only display/telemetry on the `process_phase` event — edges reference
  phases by **id**, resume keys off `phaseRunId`/`taskId`. Verified: `pnpm typecheck` + `pnpm build` clean
  (the three residual typecheck errors — `open.test.ts`, `service.test.ts`, `runner.test.ts` — are
  **pre-existing on clean HEAD**, confirmed via `git stash`, and unrelated); DB suite **42 pass** (new
  `dot_folder` v20 migration column-presence test; `processes.test.ts` latest-`user_version` bumped
  19 → 20; +2 `prompts.test.ts` dot-folder section present/absent) + **66** process-module tests, run
  against a node-ABI `better-sqlite3` rebuild with the Electron ABI restored after via `electron-rebuild`;
  `migrations.test.ts` `user_version` assertions bumped 19 → 20 (×2). Manual E2E deferred to a live
  session. **Deferred (as planned):** FS-enforcing the dot-folder; workspace-wide git-diff / shell-written
  file detection (the noted chip gap); open-at-line in the IDE.
- **`029` — Process review feedback loop.** Built on `feat/process-engine-planning` (not yet merged to
  `main`). A `026` follow-up: a gated phase gains a third decision beside Approve/Deny — **Request
  changes** — a feedback note that re-runs the gated phase's own worker (note injected into its kickoff)
  and re-gates, bounded by a **per-phase** cap. **Storage** (`SCHEMA_V19`, three additive `ADD COLUMN`s,
  no rebuild): `process_phase_runs.rework_note` (the feedback, read by `makeRunPhase`) +
  `rework_round` (the bound counter), and `process_phases.max_rework_rounds` (0 = unlimited, editable in
  the builder). **Gate re-detection is count-based, not timestamp-based** (the crux): `needsGate` raises
  a fresh gate when `gateRows(phaseRun) <= reworkRound` — each send-back settles exactly one gate row and
  bumps the round, so a re-completed phase owes a new gate; `gateResolved` releases dependents when **any**
  gate row is `approved` (a denied row never flips; you can't request changes on an approved gate) — both
  **exact at any millisecond resolution**, avoiding an initial `finishedAt` vs `requestedAt` comparison
  that flaked on equal-ms ties. **No new `ApprovalStatus`**: `requestChanges` reuses `"denied"` with a
  `decision` blob `{feedback, rework:true}` for the audit trail. New `ProcessService.requestChanges`
  (modeled on `restartRun`): guards (reject a **container** fan-out/on_each_subtask phase — sub-DAG replay
  is `031`; reject at the cap) → one transaction (settle the row denied + reset the phase-run to `pending`
  with the note/round + flip the run to `running`) → `runner.resume` after commit (the paused task
  re-derives from the DB and re-runs the phase). **Renderer** (`process-screen.tsx`): a collapsible
  textarea + **Request changes** button in the gate card (hidden for a container or at the cap →
  Approve/Deny only), a **Max rework** builder input (shown for approve gates), and a **fix to the remount
  gate reconcile** — it dropped a re-raised gate because it keyed on `phaseRunId` alone (a phase-run now
  has both a denied and a fresh-pending row); now matches the displayed `requestId`. New IPC
  `process:requestChanges` + preload bridge; `maxReworkRounds` threaded through the phases create/update
  CRUD (db-handlers + preload). Builds the **reopen → inject feedback → bounded re-run** primitive `031`
  generalizes. Verified: `pnpm typecheck` + `pnpm build` clean (the three residual errors — `open.test.ts`,
  `service.test.ts` `restartRun`'s `createPhaseRun({error})`, `runner.test.ts` — are **pre-existing on
  clean HEAD** and unrelated); new tests — `scheduler.test.ts` (**27**; +2: full request-changes re-gate
  cycle, and denied-without-rerun does-not-re-raise), `service.test.ts` (**+5**: requestChanges settles/
  resets/resumes, rejects at cap, rejects a container, injects the note into the re-run kickoff end-to-end,
  no-op on unknown requestId), `prompts.test.ts` (**+3**: kickoff rework-note section present/ordered/
  blank-ignored), `migrations.test.ts` (v19 column presence + defaults); the three latest-`user_version`
  assertions bumped 18 → 19. DB suite run against a node-ABI `better-sqlite3` rebuild, Electron ABI restored
  after with `electron-rebuild`. Manual E2E deferred to a live session. **Deferred (as planned):**
  cross-phase send-back + per-phase validator + autonomous rework → `031`; request-changes on a container
  phase.
- **`028` — Skill authoring.** Built on `feat/process-engine-planning` (not yet merged to `main`).
  Extended the Skills view (`skills-screen.tsx`, previously View + **Edit** only) with **create** +
  **delete**, mirroring `027`'s agent editor and closing the loop so an authored agent's `skills[]` can
  reference skills that exist. **Main:** `validateName` + a new **`skillScaffold`** exported from
  `agent/skills/loader.ts` (kept beside the parser so a scaffold change and its round-trip test live
  together; description YAML-serialized so special chars quote correctly, commented `allowed-tools`
  hint); two IPC channels in `index.ts` — `skills:create` (scaffolds `<dir>/<name>/SKILL.md`, validates
  the target dir is writable + the name matches the loader's rules + rejects a same-dir collision,
  returns the new path) and `skills:delete` (removes the skill's whole **folder** via `rm -r`) — guarded
  by a new `writableSkillRoots()` (**user + custom only**, mirroring `writableAgentRoots`) +
  `assertSkillWritablePath` (basename `SKILL.md`, resolves under a writable root). **Decisions (Open
  Qs):** target dir → **user default** with a source dropdown when custom folders exist; delete
  protection → writable source kinds only (workspace/`.github` skills viewable but read-only); name
  rules → reuse the loader's `validateName` + same-dir collision reject. **Renderer:** `skills-screen.tsx`
  gained a **New skill** button + a create form (name / location `Select` / description) that scaffolds
  then drops into the existing raw-text editor on the fresh file, and a hover **delete** (writable rows
  only, with confirm) — the `SkillRow` now carries the folder `kind`, and `CatalogSkill` is tagged so
  writability reads off the source. **Preload:** `skills.create`/`skills.delete` bridges. Verified:
  `pnpm typecheck` + `pnpm build` clean (the three residual typecheck errors — `open.test.ts`,
  `process/service.test.ts`, `runner.test.ts` — are **pre-existing on clean HEAD** and unrelated); new
  `agent/skills/loader.test.ts` (**8** — `validateName` accept/reject cases + `skillScaffold` round-trips
  through the real `listSource`, incl. a placeholder-description case and a YAML-special-char description
  that still parses); the agent suite is otherwise green (sole failure is the known flaky real-process
  SIGKILL timing test in `local.test.ts`, passes in isolation). Manual E2E in the running app deferred to
  a live session. **Deferred (as planned):** editing skills in workspace roots; skill sharing /
  import-export / marketplace.
- **`027` — Agent management UI.** Built on `feat/process-engine-planning` (commit `a6e60cc`; not yet
  merged to `main`). In-app **create/edit/delete** of the file-based `<name>.agent.md` agents, mirroring
  the skills editor and closing the loop so `025`/`026` phases can reference authored agents (was
  disk-only + a read-only Settings folder table). **Main:** a new **`serializeAgent`** in
  `agent/agents/loader.ts` (the exact inverse of `parseAgent` — preserves the load-bearing tri-state
  `undefined`→omit / `[]`→empty-list, hyphenated `user-invocable` key, raw body; `validateName` exported
  for hard name↔stem enforcement); `AgentFolder`/`AgentTree` types + an exported `TOOL_CATEGORIES`; and
  five IPC channels in `index.ts` — `agents:tree`/`read`/`save`/`create`/`delete` — guarded by
  `assertAgentPath` (any known root, read) and `assertAgentWritablePath` (**user + custom only**, write),
  with `save` taking **structured fields** (serializer stays in main, no YAML in the renderer).
  **Decisions (Open Qs):** editor style → **structured form** (not raw text); writable roots → **user +
  custom only** (workspace/`.github` agents are viewable but read-only). **Renderer:** new
  `agents-screen.tsx` — clones the Skills full-viewport takeover shell + two-level tree, with a
  structured main pane: description Textarea, user-invocable Switch, **All/None/Choose** tri-state
  pickers (shadcn `Select` + checkbox grids) for tools (8 categories) / skills (`skills:list`) /
  children (agent names), a markdown body Textarea; **New agent** (full form) + hover **delete**
  (writable rows only, with confirm). Mounted in `main.tsx`; a **Bot**-icon "Agents" footer button in
  `sidebar.tsx` (between Processes and Skills); types re-exported via `renderer/src/types.ts`. Verified:
  `pnpm typecheck` + `pnpm build` clean (sole error, `src/main/ide/open.test.ts`, is pre-existing +
  unrelated); `loader.test.ts` **serializeAgent** round-trips (tri-state omit/[]/list, hyphenated key,
  verbatim body) + `validateName` (23 pass). DB suite run against a node-ABI `better-sqlite3` rebuild,
  Electron ABI restored after. Manual E2E in the running app deferred to a live session. **Deferred (as
  planned):** editing agents in workspace roots; a per-agent `model` field; versioning/import-export.
  **Shipped alongside** (same commit `a6e60cc`, from the same session): **process run titles** (a
  `process_runs.title` column, `SCHEMA_V18`; `startRun` awaits `generateTitle` so the run selector shows
  a short LLM title, not the raw objective), **fan-out decomposition robustness** (a tolerant
  `parseDecomposition` — scans all fences, string-aware balanced-bracket match, accepts object arrays —
  plus a tightened prompt + corrective-retry note), a **transient-turn retry fix** (`isTransientError`
  now walks the error `cause` chain + matches transient messages, so a mid-stream "terminated" undici
  socket death is retryable and a phase worker retries instead of failing on attempt 1), and **retry a
  failed run** (`runner.restart` re-queues a failed task in place — preserving its `taskId`-keyed
  checkpoints; `ProcessService.restartRun` resets the failure frontier — failed/cancelled phase-runs +
  container children — and re-drives the same task; `process:restart` IPC + a **Retry** button on failed
  runs in the monitor).
- **`026` — Process UI.** Built on `feat/process-engine-planning` (not yet merged to `main`). The
  **renderer** for the `025` engine — purely additive, **no backend/IPC/schema change** (the
  `process:*` control verbs, `db:processes:*` CRUD, the `api.process` + `api.db.processes` preload
  bridge, and the `process_phase` task event all already existed from `025`/025.x; this PR consumes
  them). **Placement:** a **Processes** button in the sidebar footer (`Workflow` icon, above Skills)
  opens a full-viewport **overlay** (`processOpen` boolean in `Shell()`, `<ProcessScreen>` rendered
  alongside `<SkillsScreen>`) — the Skills-screen takeover pattern, **not** a 4th `Mode`/`View` (a
  process isn't a conversation, so `Mode`/`conversations.mode`/`VIEW_TO_MODE` are untouched). **New
  `src/renderer/src/components/process-screen.tsx`:** a left rail listing definitions (New + hover
  delete-with-confirm), a **list-based DAG builder** (phases as cards; dependencies as per-phase
  **"depends on"** checkboxes so the graph is implicit in the edges, each with an `on_complete` /
  `on_each_subtask` trigger dropdown; a per-phase inspector for **routing** `single`/`dispatch`,
  **gate** `auto`/`approve`, **fan-out** toggle, and an add/remove **agent pool** off `agents:list`),
  and a **run monitor** (run selector + pause/cancel; phase-run rows colored by status off the
  `process_phase` events on the run's backing task tail — `tasks.onEvent` filtered by `run.taskId`, no
  new channel — with fan-out / on_each_subtask **children nested** under their container; gated phases
  get an **inline approval card** wired to `process.approve`/`process.deny`, the gate `requestId`
  reconstructed from the replayed + live task-event stream into a `phaseRunId → requestId` map, mirroring
  `tasks-section.tsx`'s `latestGate`). Every builder mutation is **mutate-then-refetch** (agent-pool +
  edge rows have no update verb → edit = delete+recreate). Uses `NativeSelect` (not the Radix `Select`)
  to sidestep the modal-dialog `pointer-events:none` interaction the `023` takeover documented. Wired
  through `main.tsx` (state + render + `onProcessClick`) and `sidebar.tsx` (prop + footer button);
  Process types re-exported via `src/renderer/src/types.ts`. **Decisions (Open Qs):** Q1 → overlay;
  Q2 → list-based builder; Q3 → monitor is the single gate surface for v1 (activity-panel echo
  deferred); Q4 → footer button leaves the North Star brand-relabel untouched. Verified: `pnpm
  typecheck` clean (sole error, `src/main/ide/open.test.ts`, is **pre-existing on clean HEAD** and
  unrelated) + `pnpm build` clean; `router.test.ts` (10) still green; renderer has no in-repo component
  test harness and DB-backed process tests stay ABI-skipped. **Manual E2E in the running app deferred**
  to a live session. **Deferred (as planned):** a polished visual node/edge canvas; per-pool-agent
  skills/tools tri-state overrides (fields exist, default to the agent's own definition — v1 adds bare
  pool members); gate-approval echo in the activity panel.
- **`025.3` — Process dispatch routing.** Built on `feat/process-engine-planning` (not yet merged to
  `main`). Fast-follow on `025`/`025.1`/`025.2`, **no migration** (`process_phases.routing` +
  the N-row `process_phase_agents` pool were laid down in `SCHEMA_V15`). A `routing:'dispatch'` phase
  now picks the **best-fit agent per (sub-)task** via a new `src/main/tasks/process/router.ts`
  `route()` — a single **bounded, non-streaming `createCompletion`** (mirrors `SummaryService`) over
  the pool agents' `description`s + the (sub-)task prompt, returning the chosen `agent_name`.
  **Deterministic fallback to `pool[0]`** on empty/parse-miss/unknown-name/`NoActiveProviderError`/
  aborted-signal/any classifier error, so a `dispatch` phase never wedges; a **single-agent pool
  short-circuits** (no LLM call). `matchAgent` is tolerant — exact case-insensitive match first, else a
  whole-word token match (longest-name-first so a substring name can't shadow), handling
  `"Agent: backend."`-style replies; an unloadable pool agent keeps its slot with an empty description
  (stays selectable). **`service.ts`:** `resolveAgent` is now **async** and branches on `phase.routing`
  — `single` (or no routing context, e.g. a fan-out phase's decomposition pass) → `pool[0]`; `dispatch`
  → `route()`. `makeRunPhase` was reordered so the **kickoff/sub-task prompt is built first** (it's the
  routing signal), then the agent is resolved, then the worker is forked + stamped. **Per-sub-task
  granularity:** a fan-out **child** routes independently (the decomposition pass stays `pool[0]`); the
  chosen `agent_name` is recorded on the phase-run and rides the `process_phase` event. Classifier model
  **inherited** from the run's source-conversation selection. Rule-based routing stays deferred.
  Verified: `pnpm typecheck` + `pnpm build` clean; new `router.test.ts` (**10**) + `service.test.ts`
  (**2**, full-executor integration: a `dispatch` phase records the classifier's non-`pool[0]` pick on
  its phase-run + event; a `single` phase ignores the classifier). Full suite **565 pass** (1 unrelated
  flaky real-process SIGKILL timing test in `local.test.ts`, passes in isolation). DB suite run against
  a node-ABI `better-sqlite3` rebuild, Electron ABI restored after with `@electron/rebuild`. Manual E2E
  deferred to the `026` UI. **Completes the `025` fast-follow trilogy** (fan-out + on_each_subtask +
  dispatch).
- **`025.2` — Process `on_each_subtask`.** Built on `feat/process-engine-planning` (not yet merged to
  `main`). Fast-follow on `025`/`025.1`, **no migration** (the `process_edges.trigger` enum +
  `process_phase_runs.parent_id` were laid down in `SCHEMA_V15`). A downstream phase `V` joined to a
  **fan-out** phase `C` by an `on_each_subtask` edge now runs **once per completed `C` sub-task** —
  picking up each piece as it lands — instead of waiting for `C`'s whole phase. **Key decision:** each
  per-child `V` run is a **child `process_phase_runs` row** (`parentId` = `V`'s own top-level
  *container* run), so the existing generic `pendingChildren` loop + `dispatchChild` + `childPrompts`
  dispatch them **verbatim** and the one-run-per-phase invariant (`runByPhaseId`/`statusOf`) stays
  intact. **Unifying simplification:** `fanOut` was generalized to an `isContainer(phase)` predicate,
  so fan-out parents (025.1) and each-subtask consumers share the container lifecycle — crash-reset,
  abort sweep, and the derive-settle (`deriveFanoutParents` → `deriveContainers`, run to a **fixpoint**
  so a consumer whose source settles in the same pass is re-evaluated before the walk's terminal
  check). Reactivity is free off the scheduler's existing **race-on-first-completion**:
  `triggerEachSubtask` spawns the owed `V`-instances when a `C` child lands. **Correctness guards:**
  a **count guard** (settle a consumer only once sources are all terminal AND one terminal instance
  exists per completed child — closes the last-child race); `skipped` only when sources are terminal
  with **zero** completed children; the container `pending → running` event emits **once**; the fan-in
  trigger creates the instance + flips the container + writes an **append-only**
  `eachsubtask:<container>` checkpoint in **one transaction**, and recovery **unions all rows** (vs
  fan-out's latest-wins) into `childPrompts` + a `triggeredPairs` dedupe set so resume never
  double-fires; and an undefined-vs-empty-string prompt fallback. `collectUpstream` broadened from
  `src.fanOut` to "source has children" so a phase downstream of any container gets a real aggregated
  digest. **v1 scope-outs (graceful fallback, documented):** mixed `on_complete` + `on_each_subtask`
  edges into one phase; a **gated** fan-out source (`needsGate` fires only after `C` fully completes,
  so it can't hold `V` back). New in `scheduler.ts` (`eachSubtaskConsumerPhaseIds`/`isContainer`/
  `onCompleteSources`, `triggerEachSubtask`, `deriveContainers` + `eachSubtaskSourceState`,
  `EachSubtaskCheckpointState` + recovery, `BuildEachSubtaskPrompt`), `service.ts`
  (`makeBuildEachSubtaskPrompt`, broadened `collectUpstream`), `prompts.ts` (`eachSubtaskKickoffPrompt`).
  **Verified:** `pnpm typecheck` + `pnpm build` clean; `scheduler.test.ts` **20 pass** (7 new); full
  suite **553 pass** (1 unrelated flaky real-process SIGKILL timing test in `local.test.ts`, passes in
  isolation). DB suite run against a node-ABI `better-sqlite3` rebuild, Electron ABI restored after.
  Manual E2E deferred to the `026` UI. **Deferred to `025.3`:** `dispatch` routing of each child.
- **`025.1` — Process fan-out.** Built on `feat/process-engine-planning` (not yet merged to `main`).
  Fast-follow on `025`, **no migration** (`process_phases.fan_out`, `process_phase_runs.parent_id`,
  `idx_process_phase_runs_parent` were laid down in `SCHEMA_V15`). A `fan_out=1` phase runs a
  **decomposition pass** — its own forked worker via `runAgentLoop` (so it can inspect the workspace),
  whose final message is parsed for a JSON array of sub-task briefings (`fanOutDecomposePrompt` +
  `parseDecomposition`, capped `MAX_FAN_OUT=8`) — and each briefing becomes a **child
  `process_phase_runs` row** (`parent_id` set) backed by its own worker. **Key decision:** children are
  **first-class dispatchable units in the existing ready-set loop**, sharing `PER_RUN_CONCURRENCY` and
  the one `Promise.race`, so `025.2`'s `on_each_subtask` inherits child-completion reactivity with no
  new machinery (vs. the simpler-but-limiting alternative of fanning out inside a phase's `runPhase`).
  A `running` fan-out parent settles **completed** only when every child is terminal (a failed/cancelled
  child fails/cancels the parent — v1). Four validated correctness fixes: **(R1)** parent-completion
  derivation guards on `children.length > 0` so an in-flight decompose can't vacuously settle the parent
  and orphan the children about to be created; **(R2)** empty/malformed decomposition fails the parent
  (retryable), never a silent no-op; **(R3)** child rows + their prompt-checkpoint persist in one
  `getDb().transaction`, so a crash can't orphan prompt-less children; **(R4)** resume recovers the
  **latest** `fanout:<parentRunId>` checkpoint per label (`createCheckpoint` only inserts). Children are
  dispatched off their **own** run id (never `dispatch()`/`runByPhaseId`, which resolve to the parent —
  children share the parent's `phaseId`), and `collectUpstream` aggregates a fan-out source's
  **children's** outputs so a downstream phase gets a real digest, not the sub-task list (R7). New in
  `scheduler.ts` (`Decompose`/`DecomposeResult`, `dispatchDecompose`/`dispatchChild`,
  `runDecomposeWithRetry`, `createChildrenAtomic`, `deriveFanoutParents`, widened crash-reset +
  checkpoint recovery, cancellation settling fan-out parents), `service.ts` (`makeDecompose`,
  subtask-prompt-aware `makeRunPhase`, `aggregateChildContent`), `prompts.ts` (fan-out prompt + parser).
  The `process_phase` event now carries `parentId` on every transition (already in the `025` union) so
  the `026` monitor can nest children. Verified: `pnpm typecheck` + `pnpm build` clean; `scheduler.test.ts`
  **13 pass** (6 new: N-children/parent-completion, failed-child-fails-parent, empty-decomposition (R2),
  in-flight-decompose-not-settled (R1), cancel-mid-fan-out, resume-without-re-decompose); full suite
  **547 pass** (1 unrelated flaky real-process SIGKILL timing test in `local.test.ts` — passes in
  isolation). DB suite run against a node-ABI `better-sqlite3` rebuild, Electron ABI restored after with
  `@electron/rebuild`. Manual E2E deferred to the `026` UI. **Deferred to `025.2`/`025.3`:**
  `on_each_subtask` partial-completion triggers; `dispatch` routing of each child.
- **`025` — Process engine (v1 core).** Built on `feat/process-engine-planning` (commit `a06c7e4`;
  not yet merged to `main`). A user-defined **agentic DAG**: reusable Process *definitions* (phases +
  dependency edges + per-phase agent pool + skills/tools + routing + gate policy + fan-out) split from
  *run* instances, driven by a new `process_run` task kind on the runner's **deterministic executor
  seam**. The scheduler runs a **ready-set walk** over the edges — **sequential chains, parallel
  independent phases, and multi-dependency joins** (Publish ← Construct AND Validate) all fall out of
  the "every incoming edge satisfied" predicate, no special-casing. **Key decision:** phases run
  **inline** via `runAgentLoop` in forked worker conversations (the `spawnSubagent` precedent — the
  codebase's documented ruling against re-enqueuing, which "would deadlock under the concurrency cap on
  a blocking wait"), governed by a per-run promise pool (`PER_RUN_CONCURRENCY = 4`) under the global
  cap, so the whole run holds one global slot regardless of internal fan width. Per-phase
  **human-in-the-loop gates** (`auto`/`approve`) reuse the `012` durable-approval dual-write on the
  `process_run` task; a gate throws `GateBlockedError` → the task settles `paused` (freeing its slot),
  and `process:approve` settles the row + resumes the task, which re-derives the ready-set and releases
  the gated phase's dependents. **Crash-resume at phase granularity** is the **first real consumer of
  `task_checkpoints`**: on `autoResume`, `completed` phases aren't re-run, a mid-flight phase resets to
  `pending`, and a per-iteration frontier checkpoint accelerates re-derivation. New **`SCHEMA_V15`**
  (all 6 tables — `process_definitions`/`process_phases`/`process_phase_agents`/`process_edges`/
  `process_runs`/`process_phase_runs` — **laid down whole** so the fast-follows need no migration; bare
  `TEXT` status columns validated in the repo layer to avoid a v8-style CHECK-widening rebuild) + a
  `src/main/tasks/process/` module (`service`/`scheduler`/`prompts`) + `processes` repo + `process:*`
  control / `db:processes:*` CRUD IPC + preload (`api.process` + `api.db.processes`). A new
  `process_phase` `task_events` type rides the `process_run` task's tail (no new event channel — the
  `026` monitor filters `task:event`). `enqueueKind` gained an optional `sourceConversationId` so a run
  is user-facing (activity panel + completion notification). **Supersedes `018`** — 018's fixed
  `plan→execute→review→fix→finalize` becomes one built-in Process *template* over this engine.
  **Deferred to fast-follows** (additive on `SCHEMA_V15`, no migration): runtime **fan-out** → `025.1`;
  **`on_each_subtask`** partial-completion triggers → `025.2`; **`dispatch` routing** across an agent
  pool → `025.3` (v1 ships `routing:'single'`). Verified: `pnpm typecheck` + `pnpm build` clean; **541
  tests pass** (20 new — process repo v15 migration/CRUD/tri-state skills-tools + scheduler
  ready-set/parallel/multi-dep-join/approve-gate-block-then-release/resume-without-rerun/cancel/
  failed-phase + a runner pause→resume gate-contract case); stale `user_version` assertions bumped
  10 → 15 (they'd been dormant behind the SQLite-ABI test skip). Manual E2E deferred to the `026` UI.
- **`019` — Conversation summaries.** Filled the rolling-summary section `014` reserved: a compact,
  periodically-regenerated digest of the turns scrolling out of the ContextBuilder's recent-message
  walk-back, so a long conversation keeps its early thread. **Storage** (`SCHEMA_V10`): a new
  `conversation_summaries` table, one row/conversation (`ON DELETE CASCADE`), tracking
  `covers_through` (the incremental-regeneration cursor + debounce baseline), `message_count`, and
  `token_estimate`. **Generation** (out of band): a new `summarize` `009` task kind
  (`autoResume:false` — a stale summary is harmless) whose deterministic-`run` executor makes exactly
  **one** bounded, non-streaming LLM call (no agentic loop) using the conversation's own model, folds
  prior-summary + only-new-turns incrementally, and upserts — never on the user's turn latency. The
  **trigger** runs post-turn from the `chat` IPC handler: fires only at ≥10 msgs AND (≥20 fresh turns
  OR ≥6k fresh tokens past `covers_through`), deduped against an in-flight run. **Wiring into `014`**:
  `SECTION_PRIORITY.summary` (highest — compressed older context dropped last), a `summarySection`
  renderer, mode-gated and **additive** to the walk-back (safe overlap, never a gap). **Prompt
  hardening found in live testing** (the schema/wiring worked first try; the first *summaries* didn't):
  (1) the transcript was rendered as a bare `user:/assistant:` log ending in an `UPDATED SUMMARY:` cue,
  so the model *continued the transcript* before summarizing — burning the output budget and
  truncating the digest → fence inputs as data (`<prior_summary>`/`<new_turns>`) + imperative, no cue;
  (2) guard on `finish_reason==="length"` (retryable error, never store a truncated summary);
  (3) `stripPreamble` (drop anything before the first `##`); (4) instruct the model to omit — and
  actively drop from a prior summary — volatile repo-state facts (branch, file/symbol counts, paths)
  the live index section already supplies fresh (the deeper index staleness is `024`'s scope).
  Verified: `pnpm typecheck` + `pnpm build` clean; repo (upsert/cascade) + `summarySection` + 16
  `SummaryService` tests (trigger threshold/debounce/dedupe; executor incremental/error/truncation/
  preamble/prompt-shape); three "latest `user_version`" assertions bumped 9 → 10; and **live-verified
  end to end** against the real dev DB (threshold fires, task runs out of band, a clean non-meta
  seeded conversation produced a complete, faithful, non-echoed digest). Split out of `014` Q1. Built
  on `feat/conversation-summaries` (commit `68066c4`; not yet merged to `main`).
- **`023` — Settings revamp (full-screen takeover).** UI-only (renderer); no backend/IPC/schema
  change — the same `settings.*`/`providers.*`/`models.*` surface reused verbatim. Replaced the
  cramped ~448px right slide-out `Sheet` with a **full-viewport takeover**: `settings-sheet.tsx` →
  **`settings-screen.tsx`** with a **left vertical nav rail** (the six sections via
  `Tabs orientation="vertical"`, so Radix keyboard nav + selected-state carry over) + a `max-w-2xl`
  centered content column. All six `TabsContent` bodies and the delegated `ProvidersTab`/`ModelsTab`
  are **reused verbatim**; only the container + tab strip changed. Built on the **raw Radix `Dialog`
  primitive** (Portal + Content), not the shared `DialogContent` — `cn`/`twMerge` can't strip the
  `zoom`/`slide` `tw-animate-css` utilities baked into it, so the primitive gives a clean
  `fixed inset-0` panel (subtle fade + slide-up, no modal zoom) while keeping the focus-trap /
  Escape / portal for free. Header doubles as the window drag region (`h-11`, `pl-20` clears the
  macOS traffic lights; close **[X]** opts out via `no-drag`); inline bodies scroll their own
  overflow. `main.tsx`: `<SettingsSheet>` → `<SettingsScreen>` (state/props/open-paths unchanged);
  `ui/sheet.tsx` left in place. **Post-merge fix** (`c5e901a`): an open modal Radix `Select` sets
  `pointer-events:none` on `<body>`, so a click dismissing the dropdown resolved to `<body>` — read
  as an outside-click that closed the whole screen; a takeover has no meaningful "outside", so
  `onInteractOutside` is `preventDefault`'d (Escape + [X] still close). Verified: `pnpm typecheck` +
  `pnpm build` clean, manually verified in the running app. Merged to `main` `--no-ff` (merge
  `1ea9445`; commits `b96b9b4` + `c5e901a` on `feat/settings-revamp`). Content redesign within
  sections remains deferred to a later polish pass.
- **`022` — Orphaned task cleanup on session delete.** Found verifying `021`. Deleting a session
  nulled its tasks' `source_conversation_id` (FK `ON DELETE SET NULL`) but left the forked **worker
  conversation** + task rows behind — invisible to the UI (panels fetch by `sourceConversationId`;
  workers aren't sidebar-listed), unbounded, and a latent hazard: an orphaned non-terminal
  **auto-resume** kind (`todo_run`) could silently re-queue on boot with no panel to cancel it.
  **Shipped both parts.** *(A) Delete path* — threaded the `taskRunner` singleton into
  `registerDbHandlers` (type-only import, no cycle) so `db:conversations:delete` routes through a new
  `TaskRunner.deleteSourceConversation(id)`: a **transitive** BFS over source links collects every
  descendant worker conversation, cancels each task, **awaits any in-flight run's settle** (a new
  `inflight` map — so a running task's post-abort writes finish before its row is deleted, no FK
  throw), then deletes worker conversations + the source in one transaction (`deleteConversations`
  repo helper; runtime FK cascade clears tasks/messages/todos/approvals/task_events/task_checkpoints).
  A `reapOrphans()` step at the top of `start()` is the safety net: it deletes any source-less task of
  a kind with **no independent UI surface**, guarded by a new `hasIndependentSurface` capability flag
  so `workspace_index` (born source-less by design, observable in the indexing panel) is exempt.
  *(B) One-time reap* — `SCHEMA_V9` (`user_version` → 9): a recursive-CTE sweep with **explicit** child
  deletes (migrations run `foreign_keys = OFF`, so a plain `DELETE` won't cascade), seeded excluding
  `workspace_index`, reaping descendants transitively so no dangling `source_conversation_id` survives.
  **Decisions:** delete *all* sourced tasks regardless of status; *reap* (not re-home) source-less
  surface-less tasks. Verified: `pnpm typecheck` + `pnpm build` clean; new runner tests (cascade +
  child rows, in-flight abort-before-delete, transitive nested reap, `todo_run` reaped vs.
  `workspace_index` kept) + new `migrations.test.ts`; two pre-existing `user_version` assertions
  bumped 8 → 9. **Verified against the real dev DB**: v9 applied, orphaned tasks now 0, all 15 chat +
  7 interactive sessions intact, `foreign_key_check` + `integrity_check` clean (after clearing
  unrelated `pr21-test-task` manual-test debris). Built on `feat/orphaned-task-cleanup` (commit
  `95f05e0`; not yet merged to `main`).
- **`021` — Approvals context section.** Built on `pr21-approvals-context-section` (commit ref pending
  merge). Filled the last `014`-reserved section slot (`SECTION_PRIORITY.approvals = 20`): a read-only,
  advisory section giving the agent visibility into what the user has **already granted/denied**, so it
  doesn't re-request an allowlisted action or retry a denied one. **Shipped both halves.** (1) *Allowlist*
  — a new `listRules({ workspacePath, conversationId })` read on `action-allowlist.ts` returning all
  in-scope grants (global + matching workspace + matching conversation), mirroring `findMatch`'s scope
  logic but returning every match and **not** touching `last_used_at` (a display read must not mark rules
  used). Meaningful on any non-chat turn. (2) *Task approvals* — recent/pending `approvals` rows
  (`009`/`012`) surfaced only when the turn belongs to a durable task; an optional `taskId` was threaded
  into `RunAgentLoopOptions` and set by the runner's `runOne`; pending decisions render as "NOT yet
  granted". Both fold into an `approvalsSection` in `context/sections.ts` (deduped by kind/identity/scope,
  capped), pushed in `runAgentLoop` at the existing `showTodos` gate; returns null (no block) for a bare
  turn. **No schema change, no migration.** Advisory only — never bypasses the live gate
  (`agent/approval` unchanged). Verified: `pnpm typecheck` + `pnpm build` clean; 15 unit tests
  (`action-allowlist.test.ts` scope resolution + no-touch-`last_used_at`; `sections.test.ts`
  renderer/dedup/gating); manual E2E (grant line appears in-scope, absent cross-workspace and in bare
  chat; task half renders on resume). Testing surfaced an unrelated data-lifecycle bug → `022`.
- **`014` — Context builder (framework + available sources).** Built on `feat/workspace-indexing`
  (commit `aff2db5`; not yet merged to `main`). Evolved the `ContextBuilder` from a single-budget
  history walk-back into a section assembler: a `ContextSection` abstraction, one global token budget
  with an explicit **drop order** (a section-budget share admitted highest-priority-first that can
  never starve the recent-message walk-back — the non-droppable core, tool-call integrity preserved),
  and an include/drop log (no silent truncation). Migrated `runAgentLoop`'s ad-hoc `systemPrompt +=`
  appends (skills, todos, workspace-index summary) into sections and added a **task-state** section
  (active durable tasks spawned from the session, so the agent doesn't re-start running work). The
  **workspace-index consumption** side shipped alongside `008` (commit `a57fe48`, fixes `a2ba066`):
  the injected index summary + the `index_query_tool` (find-symbol / what-imports / list-files /
  metadata — advisory, with live-fs fallback and honest truncation/counts). `SECTION_PRIORITY`
  centralizes the order: index → approvals → task-state → todos → skills. Verified: `pnpm typecheck`/
  `build` clean, section-framework + renderer + query-tool tests, and live in the app. **Deferred to
  their own plans** (sections reserved): rolling **conversation summary** → `019`, **durable
  memories** → `020`; the **approvals section** is recorded in `014` as additive future work (not a
  plan — the tables already exist).
- **`008` — Workspace indexing (slice 1).** Built on `feat/workspace-indexing` (commit `591e9e2`;
  not yet merged to `main`). A background, incremental, deterministic (no LLM in the build path)
  workspace index run as a `009` durable task. **Ships Stages 1 (file map) + 2 (metadata)**: a
  recursive walk (shared `walkFiles`, factored out of `LocalEnvironment.search`, `.gitignore` via the
  `ignore` dep) upserts one `index_files` row per file with an incremental **hash-skip** — `(size,
  mtime)` fast path → `sha1` only on a miss, drop deleted, add new — then parses `package.json`/
  `tsconfig`/`vite`/`README`/`pnpm-workspace`/git-branch into `index_metadata`. The **crux** is a
  deterministic **executor seam** on the runner: `TaskKindCapability.run` — `runOne` drives it for the
  `workspace_index` kind and leaves the `runAgentLoop` path unchanged for LLM kinds; `enqueueKind` is a
  lean message-free enqueue, config in the input blob (015 contract). **Pause is a real task state**
  (`SCHEMA_V8` widens the task-status CHECK via a tasks-table rebuild; `PAUSE_ABORT_REASON` +
  `pause()`, `resume()` accepts `paused`, reconcile leaves it put across restart). Four v8 tables
  (`index_runs`/`index_files`/`index_metadata`/`index_symbols` — symbols unpopulated, schema leaves
  room). Controls: auto-index on workspace-open (North Star `high` / Interactive `low`),
  pause/resume/cancel-keeps-partial/clear/start-rebuild, per-workspace disable — via reused `task:*`
  verbs + new `index:*` handlers and a Workspace-Activity status strip; plus a Workspace Indexing
  settings group. Agent consumption is a **compact system-prompt summary only** (indexed status,
  file counts by ext, package/framework/config metadata, git branch), gated by "Use index for
  context" and advisory (the agent still uses real file tools). Verified manually (index on select,
  cross-session reuse, auto-resume after quit/reopen, pause/resume, cancel, clear) + `pnpm typecheck`/
  `build` clean and **276 unit tests** (migration-over-v7 incl. `paused`, repos, walk/gitignore,
  `classifyFile`, full IndexService incremental flow + restart-after-cancel/clear, runner executor
  seam + pause/resume). **Follow-up shipped in `014`** (commit `a57fe48`): Stage 3 (symbols +
  Extractor registry + `typescript` promoted to a runtime dep) now populates `index_symbols`, and the
  `index_query_tool` queries it. **Still deferred:** Stage 4 embeddings, live file watching,
  extractors beyond TS/JS + fallback.
- **`017` — Todo-run follow-ups.** Two gaps surfaced testing `016`, shipped as one PR. (1) **Robust
  large-file writes** (steer + append): `write_file_tool` gained an optional `mode: "create" | "append"`
  (default `create`) — append re-reads the file and rewrites the concatenation via the existing
  `atomicWrite`, so a large file is built across small, parseable calls instead of one oversized JSON
  argument that truncates at the output cap. No `Environment` change; gate identity stays
  `file_write:${path}` so one approval covers a multi-chunk write. Tool descriptions + both system
  prompts steer toward `edit_file_tool` for existing files. (2) **Live todo progress in the panel**: the
  Todos panel now reads the latest `todo_run` task's *fork* todos (was reading the frozen *source*
  snapshot), so it shows real `[ ] → [>] → [x]` progress and the final list on completion; the **Run all
  in background** button is disabled while a live task exists. Refresh rides the existing `tasks.onEvent`
  tail — no backend/preload change. Verified: typecheck clean; 40 tool tests (9 new in
  `write_file_tool.test.ts`).
- **`016` — Todo → background handoff.** Run a whole todo list as one durable background task. The
  agent builds a list with `todo_write`, then either it calls the new gated `run_todos_in_background`
  tool (the **delegation** is the approved action — a new `delegate` approval kind that always prompts,
  never sandbox-downgraded or allowlisted; the turn pauses on the live-chat approval card, which omits
  "always allow") or the user clicks **Run all in background** on the new **Todos** panel (explicit
  intent → no gate). Both converge on `TaskRunner.enqueue` with `kind: "todo_run"` (`registerKind`,
  auto-resume) and a **seed** mechanism: since `enqueue` forks an empty worker conversation, the
  current list is snapshotted into `TaskInput.seedTodos` and seeded into the fork. `enqueueTask` is
  injected into `ToolContext` (the agent layer can't import the runner — cycle), supplied by both
  `runChat` and the runner's `runOne`. New `db:todos:list` read path + Todos panel. Verified:
  typecheck + 209 tests (runner seed/auto-resume, tool gate/deny/fail-closed, delegation classifier).
  Follow-ups → `017` (large-file write robustness — immediate cap-bump+truncation-detection fix shipped
  here; live todo progress in the panel).
- **`015` — Task producer API.** Stated + lightly enforced the contract that *every* background
  producer creates work through `TaskRunner.enqueue` (never the DB or `runAgentLoop` directly), so
  approvals, events, recovery, transcript, and history stay consistent. The audit found the runner
  already general (no hardcoded origin, headless-capable, open `kind`); the gap was a
  `registerKind(kind, { autoResume })` affordance (registry moved from a private const to a per-instance
  map; `agent_chat` pre-registered) for producers whose kind should re-queue on restart. Also fixed a
  real FK bug it exposed: `enqueue` wrote `source_conversation_id` to a non-existent source under
  `foreign_keys = ON`; now links back only when the source exists (else self-sourced). No schema change.
  `016` is its first consumer.
- **`013` — Task history in the panel.** Built on `feat/task-history-panel`. A collapsible **History**
  section in the Workspace Activity panel lists terminal tasks (`completed`/`failed`/`cancelled`) for
  the active source conversation, newest first, capped at 25 ("Showing last 25"), each row opening the
  existing read-only transcript viewer. The Tasks section stays actionable-only. Replaced the per-task
  "Background task completed" cards (which didn't scale — one dismissable card per finished task) with
  a **single** toast: reusing a fixed Sonner toast id means there's never more than one on screen — one
  aggregate toast on opening a session with unseen terminal history, one coalesced toast when tasks
  finish live, both with a **View history** action that opens the panel + expands History. Renderer-only,
  no schema/IPC change (reuses `listTasks` + the transcript sheet + the `tasks.onEvent` tail). Verified:
  `pnpm typecheck` + `pnpm build` clean, 140 tests passing.
- **`012` — Durable approval recovery.** Built on `feat/durable-approval-recovery` (commit `7bc7f78`;
  merged to `main`). A background task blocked on an approval gate now survives an app
  restart: quit while it asks → reopen → Resume → it **re-prompts**, and on approval completes. Three
  layers: (1) the runner dual-writes the gate to the existing `approvals` table (`createApproval` on
  the `approval` event, `recordApprovalDecision` on the user's choice, reconcile/cancel sweeps stale
  rows) — runner-side because `approvals.task_id` is `NOT NULL`, so the live chat path is untouched;
  (2) `will-quit` now aborts with a `SHUTDOWN_ABORT_REASON` sentinel so the gate is left *unresolved*
  instead of fabricating an `ERROR[denied]` result that wedged resume; (3) two-mode dangling
  tool-call repair in `runAgentLoop` (`agent/repair.ts`) — task **resume rolls back** the incomplete
  turn so the agent re-issues the gated tool (re-prompt), live chat **synthesizes** an interrupted
  result and lets a new message drive. Renderer shows a reloaded mid-gate tool-call as `interrupted`
  rather than a stuck spinner. No schema change. Verified: `agent/repair.test.ts` + runner cases
  (194 passing) and E2E (`delete build/` → quit at prompt → Resume → re-prompt → approve → deleted).
  Spun off `015` (task producer API).
- **`011` — Task retry with backoff.** Built on `feat/task-retry` (merged to `main`).
  Transient failures (HTTP `408`/`429`/`5xx`, connection-layer codes / SDK connection errors) retry
  with capped exponential backoff + full jitter (max 3 attempts), in-memory in the runner and
  recorded as `attempt` events in `task_events`; deterministic failures (other 4xx, provider config)
  and user Stop never retry. Classification lives in `isTransientError` (`agent/providers`) at the
  catch block where the raw `.status`/`.code` survives, surfaced via a new `ChatResult.retryable`.
  The slot frees during backoff while the DB row stays `running` (crash → `interrupted`); `takeNext`
  treats backing-off conversations as busy to preserve per-conversation serialization. No schema
  change. Verified: classifier + 7 runner unit tests (183 passing) and E2E against a local 5xx/401
  server.
- **`009` — Durable task execution (Phase 1).** Built on `feat/durable-tasks` (commits `03257c3`
  runner, `a33d5ac` UI; merged to `main`). Activated the storage-only task tables with a
  real runner: FIFO queue + concurrency cap, background execution (progress in `task_events`,
  live-tailed over `task:event`), and crash-resume (orphaned tasks reconcile to `interrupted`,
  manual resume; auto-resume is a per-task-kind capability). `runChat` refactored to a shared
  `runAgentLoop` core; resume replays the persisted transcript. **Task isolation** (`SCHEMA_V7`):
  each task runs in its own forked conversation (`source_conversation_id` links back), so a
  background task never interleaves with the live chat. **Workspace Activity panel** (right-hand,
  collapsible) with a Tasks section, Resume/Cancel, inline approval + ask_user_question gates
  (`task:approve`/`deny`/`answer`), a "Run in background" composer entry point, source-chat
  completion cards, and a read-only task transcript viewer. Verified end-to-end on local + Podman.
  Follow-ups: retry → `011` (built), durable approval recovery across restart → `012`, terminal-task
  history → `013`.
- **`001` — SQLite persistence layer.** Shipped. Foundation everything else builds on.
- **`002` — Shell execution + approval gating.** Shipped (`main`, merge `7ce97d6`).
- **`003` — todo_tool.** Shipped (merge `51699ac`). Also in that merge: unbounded agent
  loop, Stop button (LLM/loop cancel), pop-out approval prompt, and `ask_user_question`.
- **`006` — Execution environments (Local / Docker / Podman).** Shipped (`main`, merge `828a397`).
  `Environment` interface under the machine-touching tools, `LocalEnvironment` + a minimal
  `ContainerEnvironment`, bulk `search`, and an `exec` abort seam. Section E (settings + sandbox
  approval) was deferred into `004` and has since shipped (see below).
- **`004` — Settings pane.** Shipped on `feat/settings-pane` (merged to `main`).
  - *Slice 1* (commit `213654e`): first persisted settings store (`SCHEMA_V4`), execution-backend
    choice in the UI (replacing the `COWORK_ENV_RUNTIME` env var), file-permission toggles, and the
    sandbox-aware approval downgrade (the `006`-E payoff — config-driven by category, hardline
    never bypassed).
  - *LLM slice*: multi-provider LLM layer (`SCHEMA_V5` — `provider_accounts` + `models`),
    safeStorage-encrypted API keys (strict, no plaintext fallback, env no longer a runtime
    fallback), a provider routing layer (`agent/providers`) replacing the env-keyed `getClient()`
    singleton, dual-source model management (user-maintained + optional gateway import, custom
    `model_name` labels), Providers/Models settings tabs, a filterable composer model picker, and
    first-launch provider setup. **Per-conversation model selection** (`SCHEMA_V6`) — each session
    keeps its own provider+model, with the Settings choice as the default for new sessions.
    Q1→safeStorage, Q3→both sources, selection scope→per-conversation.
- **`005` — Stop in-flight tool calls (Local).** Shipped on `feat/stop-tools-mid-flight` (commit
  `d572805`, merged to `main`). The abort signal was already threaded end-to-end
  (`ctx.signal` → `env.exec` → `captureSpawn`); the real fix was process-group orphaning —
  `LocalEnvironment.exec` now spawns `detached` and abort/timeout SIGKILL the whole group, so a
  pipeline/build's grandchildren die instead of being reparented to PID 1. The container half is
  split out to `005.1` (in Next up).

## Backlog (not yet planned)

Tracked in `IMPLEMENTED-TOOLS.md` → "Not yet implemented". Near-term tool candidates:
`apply_patch`, `read_extract`, `session_search`, `process_registry`, `tool_result_storage`. Larger:
`skill_manager`, `tool_search`, `cron`/`blueprints`, `code_execution`. Deferred:
web/SSRF, memory, subagents, MCP, browser/computer-use, media, integrations.

## How to use this file

- Reorder the **Next up** list whenever priorities shift — no file renames needed.
- When a plan starts, keep its status in the plan file itself; move it to **Done** here
  when shipped (with the merge/commit ref).
- New work gets the next plan number (`007`, …) and an entry here.
