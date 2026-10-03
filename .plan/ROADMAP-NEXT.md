# Roadmap — Next up

> **Note (2026-09-26):** the `106.x` plans predate a rename — Initiatives are now **Features**,
> Missions are **Milestones**, and Slices are **User stories**. Each pending `106.x` plan has a mapping note at the top.

1. **`109.01` — QA write scope and prompt.** First slice of `109` (QA seats that verify
   independently). A `qa` seat can write only to its user story's checks directory
   (`.mission-control/checks/<story>/` by default, configurable per workspace), enforced at the
   write-family tools with real-path checks. Rewrite the bundled QA agent: write and run checks, never
   edit product code.
2. **`109.02` — Acceptance checks and the checks step.** A validated `checks.json` manifest maps each
   criterion to command checks (any framework) or exploratory notes. `run_checks` records results on the
   phase run, with one retry to expose flakes. The default user story playbook becomes
   Spec → Author checks → Build → Test, and existing defaults get a "Reset to default" with diff. The
   checks are frozen by hash when authored, so builder edits surface at the test step.
3. **`109.03` — App launch recipes and app lifecycle tools.** A per-workspace `appLaunch` recipe
   (services, auto ports with placeholders, HTTP/log readiness, dependencies). `app_start` /
   `app_status` / `app_stop` for builder and QA seats, with teardown at phase end. An App launch editor
   on Feature home, and a workspace-analysis finding that proposes a recipe (explicit Apply).
4. **`109.04` — Seat browser and the Mission Control reveal setting.** Seat `work` turns get the
   browser tools (no `browser_handoff`), with a non-persistent partition per run, loopback-plus-`app_start`
   origins only, a concurrency cap, and teardown at phase end. New setting "Show the Mission Control
   browser when the agent uses it", off by default, shows seat tabs in the Agent Browser window.
   Screenshots are saved as proof evidence.
5. **`109.05` — Verification method in proofs.** Proof criteria record `method` (`qa_check`,
   `app_exercised`, `builder_tests`, `command`, `code_read`). The gate refuses code-read-only `met`,
   covered criteria whose checks didn't pass in this step, and exploratory criteria without evidence.
   Builder-tests-only acceptance gets a warning and a Health detector.
6. **`109.06` — Bundled Playwright runner.** Ship `@playwright/test` without browsers and run it with
   the app's Electron as Node, so QA can write Playwright checks in any workspace (the workspace's own
   Playwright is preferred when present). Browsers come from the user's Chrome or a consented one-time
   download into app data. Electron apps are checked through `_electron.launch`. The Playwright MCP was
   rejected because it duplicates the seat browser. Tool descriptions, the QA prompt, and step kickoffs
   state the rule: explore with the browser, assert with Playwright.
7. **`092.1` — Agent lifecycle hook contract, storage, runner, and safety controls.** Define versioned
   event/result/metadata schemas, canonical guarded `.hook.cjs` + `.hook.json` storage under
   `~/.<system>/hooks/`, exact-source-hash review state, stable Agent-ref targeting, deterministic matching,
   and safe failure policies. Build the bounded short-lived child-process protocol with cancellation,
   process-tree cleanup, packaged-runtime coverage, and sanitized diagnostics. This slice establishes the
   executable-code boundary but does not yet connect hooks to agent lifecycles or add the full Hooks screen
   and AI authoring wizard; those remain deferred as `092.2` and `092.3`.
8. **`045` — North Star MCP bridge for CLI providers.** After `042`, make North Star a second, distinct
   MCP role: it remains a client of user-configured external servers, and also hosts a lazy,
   authenticated Streamable HTTP server on an ephemeral `127.0.0.1` port for the Claude Code and Codex
   subprocesses we launch. Inject the endpoint per turn (`claude --mcp-config`; Codex transient `-c`
   override), never modify project/global CLI configs, and bind a short-lived bearer capability to the
   server-known conversation/workspace/tool allowlist. Explicit adapters only—no blanket `runTool()`
   export, no external MCP proxy, and no duplicate filesystem/shell tools. Side-effect policy remains
   enforced server-side. **`045.2` is done**: the slices were inverted because `index_query` needs its
   own changes first, so the bridge foundation shipped alongside the renderer-backed
   `ask_user_question` round trip (conversation-scoped question broker, per-turn grants, Claude
   `--mcp-config` / Codex `-c` injection, `will-quit` teardown). Registering the tool proved not to be
   enough — both CLIs default to asking in prose — so the slice also ships three steering levers, of
   which only a one-sentence Claude `--append-system-prompt` actually moves Claude (measured 0/6 without
   it, 4/4 with); `045`'s out-of-scope line is amended to permit exactly that narrow steer.
   **`045.1` remains**: extract the shared `index_query` service, add its adapter, widen the grant, add
   the CLI-provider UI copy, and close the Codex steering gap (no per-run append flag exists).
9. **`067` — Conversation-scoped workspace checkpoints.** Add a reversible safety layer for autonomous
   edits using conversation+workspace-scoped, content-addressed app-data manifests and blobs. Provide
   bounded create/list/diff/restore operations with conflict-aware previews, explicit approval, quotas,
   retention, and crash-safe lifecycle handling. Preserve unrelated user changes and never wrap destructive
   `git reset`/`checkout`/`clean` operations.
