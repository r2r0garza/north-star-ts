# Roadmap — Next up

1. **`105` — Required skills for individual Process phases.** Let an agent phase explicitly activate one
   required skill for every worker invocation, distinct from the phase-agent skill allowlist. Validate pool
   compatibility, fail before the LLM call when the skill is unavailable, snapshot resolved identity, and
   never offer or propagate the setting on sub-process or deterministic command phases.
2. **`092.1` — Agent lifecycle hook contract, storage, runner, and safety controls.** Define versioned
   event/result/metadata schemas, canonical guarded `.hook.cjs` + `.hook.json` storage under
   `~/.<system>/hooks/`, exact-source-hash review state, stable Agent-ref targeting, deterministic matching,
   and safe failure policies. Build the bounded short-lived child-process protocol with cancellation,
   process-tree cleanup, packaged-runtime coverage, and sanitized diagnostics. This slice establishes the
   executable-code boundary but does not yet connect hooks to agent lifecycles or add the full Hooks screen
   and AI authoring wizard; those remain deferred as `092.2` and `092.3`.
3. **`045` — North Star MCP bridge for CLI providers.** After `042`, make North Star a second, distinct
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
4. **`067` — Conversation-scoped workspace checkpoints.** Add a reversible safety layer for autonomous
   edits using conversation+workspace-scoped, content-addressed app-data manifests and blobs. Provide
   bounded create/list/diff/restore operations with conflict-aware previews, explicit approval, quotas,
   retention, and crash-safe lifecycle handling. Preserve unrelated user changes and never wrap destructive
   `git reset`/`checkout`/`clean` operations.
5. **`069` — Process intake policies and inspectable assumptions.** Give each Process an explicit run-
   entry contract instead of injecting a mandatory Planning phase: **Proceed with assumptions**
   (default, no preflight gate), **Approve initial plan** (side-effect-free execution brief + one durable
   approval/revision loop), or **Strict input contract** (definition-authored required fields validated
   before enqueue). Snapshot supplied inputs on the run; inject intake guidance, definition of done, and
   a shared materiality/authority interruption rule into phase kickoffs. Add a durable, run-scoped
   assumptions log with origin/confidence/impact/status and monitor UI. Human clarification pauses and
   resumes the correct worker; it remains distinct from internal Agent exchanges (`039`). Split strict
   deterministic intake first, then assumptions/questions, then approve-plan preflight.
6. **`039` — Inspectable Process consultations / Agent exchanges.** A running phase may consult a
    **completed phase in the same run** and receive a context-grounded answer. The user observes the
    durable exchange but cannot reply; intervention stays in existing Process controls. Before adding
    consultation, persist an explicit phase result and move downstream aggregation away from "latest
    assistant message," so appended answers never replace official output. Answer turns run under an
    **answer-only capability profile**—no mutation, execution, delegation, user questions, or recursive
    consultation. v1 is synchronous, same-run, completed-target, capped, and read-only in the monitor;
    discovered defects recommend rework through the existing flag policy rather than silently changing
    completed artifacts. Split `039.1` result integrity, then `039.2` consultation/storage/monitor.
7. **`084` — Process import account-remapping UX.** Analyze imported Process runtime selections before
    writing, distinguish locally resolved, matchable, ambiguous, and unresolved provider/model references,
    and let the user map each unresolved reference to a local account/model or choose inheritance. Keep
    account IDs machine-local, preserve portable import/export intent, and avoid raw account-ID failures.
8. **`085` — Process template library.** Add a small, polished built-in catalog of portable starter
    Processes backed by the existing import/create validation path. Let users preview and instantiate
    useful workflows without starting from a blank graph; templates inherit runtime by default and never
    hard-code local provider-account IDs.
