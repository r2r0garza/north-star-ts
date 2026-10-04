# Roadmap — Next up

> **Note (2026-09-26):** the `106.x` plans predate a rename — Initiatives are now **Features**,
> Missions are **Milestones**, and Slices are **User stories**. Each pending `106.x` plan has a mapping note at the top.

1. **`110.03` — Fix stories and the fix-round cap.** Each `app_bug` becomes a follow-up user story in
   the current milestone (`origin: "gate"`, the failed criterion as acceptance, the original's touch
   hints), applied automatically in Copilot and Autopilot and proposed in Manual. Fix stories run as the
   next wave. After `maxGateFixRounds` (default 2) on the same criterion, the gate escalates to the user
   with **Accept as is**, **I'll fix it**, or **Drop the criterion**.
2. **`110.04` — Exploratory story proof.** Drop the `checks` step from the default story playbook
   (`spec → build → test`). The `test` step becomes QA driving the running app in the story worktree
   (seat browser, app launch recipe) and recording an evidence-backed exploratory proof; `109.05`'s
   method rules stay. Retire freeze, drift, and refreeze from the story flow and rewrite the QA prompt
   and step notes.
3. **`110.05` — Lighter conflict resolution and health de-duplication.** The `after_each_user_story`
   re-verify becomes a smoke step (the app starts, the project's tests pass, QA spot-checks the
   conflicted story by exploration), and its escalation offers the same three actions as `110.03`. Health
   no longer auto-pauses an anchor that already has a pending user decision, and proof-polishing counts
   reset when the user decides.
4. **`092.1` — Agent lifecycle hook contract, storage, runner, and safety controls.** Define versioned
   event/result/metadata schemas, canonical guarded `.hook.cjs` + `.hook.json` storage under
   `~/.<system>/hooks/`, exact-source-hash review state, stable Agent-ref targeting, deterministic matching,
   and safe failure policies. Build the bounded short-lived child-process protocol with cancellation,
   process-tree cleanup, packaged-runtime coverage, and sanitized diagnostics. This slice establishes the
   executable-code boundary but does not yet connect hooks to agent lifecycles or add the full Hooks screen
   and AI authoring wizard; those remain deferred as `092.2` and `092.3`.
5. **`045` — North Star MCP bridge for CLI providers.** After `042`, make North Star a second, distinct
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
6. **`067` — Conversation-scoped workspace checkpoints.** Add a reversible safety layer for autonomous
   edits using conversation+workspace-scoped, content-addressed app-data manifests and blobs. Provide
   bounded create/list/diff/restore operations with conflict-aware previews, explicit approval, quotas,
   retention, and crash-safe lifecycle handling. Preserve unrelated user changes and never wrap destructive
   `git reset`/`checkout`/`clean` operations.
