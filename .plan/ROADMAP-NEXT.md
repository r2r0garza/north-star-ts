# Roadmap — Next up

1. **`102` — Atomic summary-boundary admission.** Fix the confirmed context-integrity gap where a
   rolling summary can be dropped by section budgeting while its coverage boundary still excludes the
   transcript rows it replaces. Complete the required analysis pass, choose a non-droppable replacement unit
   or an admission-aware gap-free fallback, and preserve `094`'s SQLite tail query whenever the summary is
   admitted.
2. **`099` — Hardened host attachment reads.** In a focused filesystem-hardening pass, distinguish user
   attachments from trusted skill resources and share a no-follow, handle-validated attachment opener across
   text and document tools. Coordinate with `055` if active, but do not require it; preserve workspace,
   container, and packaged skill-resource behavior.
3. **`097` — Transcript render boundaries and measured virtualization.** With `095` and the overlapping
   `093` transcript work complete, profile a reproducible long conversation. First extract memoized settled-
   transcript and live-turn boundaries so token deltas do not reconcile unchanged rows; add variable-height
   virtualization only if measured cost remains, with explicit scroll-anchor, selection, browser-find,
   expansion, and accessibility behavior.
4. **`033.4` — Agent-readable live dashboards. DISCUSSION REQUIRED BEFORE IMPLEMENTATION.** Add a
   read-only `dashboard_read` tool so agents can discover saved dashboards and answer questions from a
   selected dashboard's latest cached widget data without triggering refreshes. Do not begin implementation
   until this plan has been discussed with the user; at minimum, decide the mode/plan-mode/custom-agent
   offering policy and the deterministic context-size behavior (limits, paging/filtering/truncation, and
   explicit omission metadata). The proposed default omits refresh recipes, captured paths, and layout-only
   details while preserving cache status, errors, and fetch timestamps.
5. **`104` — Deterministic command phases.** Let a Process phase execute a persisted, user-reviewed
   workspace command directly through the existing Environment and command-policy boundary, without an LLM
   worker call. Persist bounded structured results for downstream phases and the monitor, and do not blindly
   replay a command whose side effects are ambiguous after interruption.
6. **`105` — Required skills for individual Process phases.** Let an agent phase explicitly activate one
   required skill for every worker invocation, distinct from the phase-agent skill allowlist. Validate pool
   compatibility, fail before the LLM call when the skill is unavailable, snapshot resolved identity, and
   never offer or propagate the setting on sub-process or deterministic command phases.
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
9. **`082` — Runtime-aware Process run-monitor badges.** Render each phase's actual persisted runtime
   provider/model from `process_phase_runs.runtime_snapshot` instead of the stale/default agent badge path.
   Preserve a sensible fallback for historical runs without snapshots and add focused display regressions;
   execution and runtime selection remain unchanged.
10. **`083` — Per-agent runtime override UI.** Expose the existing
    `process_phase_agents.runtime_config` capability in the Process builder so each phase-pool agent may
    select a worker provider/model or inherit phase/run defaults. Reuse the existing runtime picker and
    persistence/import-export paths, keep orchestration slots at phase/run scope, and preserve precedence:
    phase-agent override → phase override → run default → source/global fallback.
11. **`067` — Conversation-scoped workspace checkpoints.** Add a reversible safety layer for autonomous
    edits using conversation+workspace-scoped, content-addressed app-data manifests and blobs. Provide
    bounded create/list/diff/restore operations with conflict-aware previews, explicit approval, quotas,
    retention, and crash-safe lifecycle handling. Preserve unrelated user changes and never wrap destructive
    `git reset`/`checkout`/`clean` operations.
12. **`069` — Process intake policies and inspectable assumptions.** Give each Process an explicit run-
    entry contract instead of injecting a mandatory Planning phase: **Proceed with assumptions**
    (default, no preflight gate), **Approve initial plan** (side-effect-free execution brief + one durable
    approval/revision loop), or **Strict input contract** (definition-authored required fields validated
    before enqueue). Snapshot supplied inputs on the run; inject intake guidance, definition of done, and
    a shared materiality/authority interruption rule into phase kickoffs. Add a durable, run-scoped
    assumptions log with origin/confidence/impact/status and monitor UI. Human clarification pauses and
    resumes the correct worker; it remains distinct from internal Agent exchanges (`039`). Split strict
    deterministic intake first, then assumptions/questions, then approve-plan preflight.
13. **`039` — Inspectable Process consultations / Agent exchanges.** A running phase may consult a
    **completed phase in the same run** and receive a context-grounded answer. The user observes the
    durable exchange but cannot reply; intervention stays in existing Process controls. Before adding
    consultation, persist an explicit phase result and move downstream aggregation away from "latest
    assistant message," so appended answers never replace official output. Answer turns run under an
    **answer-only capability profile**—no mutation, execution, delegation, user questions, or recursive
    consultation. v1 is synchronous, same-run, completed-target, capped, and read-only in the monitor;
    discovered defects recommend rework through the existing flag policy rather than silently changing
    completed artifacts. Split `039.1` result integrity, then `039.2` consultation/storage/monitor.
14. **`084` — Process import account-remapping UX.** Analyze imported Process runtime selections before
    writing, distinguish locally resolved, matchable, ambiguous, and unresolved provider/model references,
    and let the user map each unresolved reference to a local account/model or choose inheritance. Keep
    account IDs machine-local, preserve portable import/export intent, and avoid raw account-ID failures.
15. **`085` — Process template library.** Add a small, polished built-in catalog of portable starter
    Processes backed by the existing import/create validation path. Let users preview and instantiate
    useful workflows without starting from a blank graph; templates inherit runtime by default and never
    hard-code local provider-account IDs.
