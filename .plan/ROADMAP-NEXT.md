# Roadmap — Next up

1. **`106.4` — Mission Control: seat sessions and Comms.** Long-lived per-seat sessions with
    generations, a durable addressable message bus (idle wake / busy inbox delivery, bounds, no
    authority in messages), answer-only wake for finished workers, read-only Comms feed, and explicit
    user Steer. Supersedes `039`.
2. **`106.5` — Mission Control: worktrees, merge queue, mission merge policy.** Worktree per slice off
    a mission integration branch, serialized dependency-ordered merge queue, integrator-seat conflict
    hook with re-verification, and manual / approved local merge / approved PR landing. Enables parallel
    waves; never destructive to user branches.
3. **`106.6` — Mission Control: Navigator and autonomous drive.** Deterministic, restart-safe Navigator
    computing position and next maneuver; Manual / Co-pilot / Autopilot modes; decision-rights-gated
    map tools for bounded replans; proposals inbox for everything outside a seat's rights; hard budgets
    with auto-pause.
4. **`106.7` — Mission Control: Refocus, follow-ups, seat memory.** Intent-chain reminders at kickoff,
    after compaction, on interval, and on drift; `propose_followup` backlog against scope creep; seat
    memory with provenance, review, explicit sharing lineage, and retraction with contact tracing.
5. **`106.8` — Mission Control: health monitoring.** Progress vs ceremony event classification,
    explainable pathology detectors (bureaucracy, stalls, proof polishing, ping-pong, scope drift,
    approval-by-proxy), context-bearing alert routing, and auto-pause; Health tab.
6. **`106.9` — Mission Control: Processes sunset.** Parity checklist, import Processes as playbooks,
    Quick run, run history in Mission Control, and a reversible setting that hides the Processes sidebar
    button. The Process engine remains as the playbook runtime.
7. **`105` — Required skills for individual Process phases.** Let an agent phase explicitly activate one
   required skill for every worker invocation, distinct from the phase-agent skill allowlist. Validate pool
   compatibility, fail before the LLM call when the skill is unavailable, snapshot resolved identity, and
   never offer or propagate the setting on sub-process or deterministic command phases.
8. **`092.1` — Agent lifecycle hook contract, storage, runner, and safety controls.** Define versioned
   event/result/metadata schemas, canonical guarded `.hook.cjs` + `.hook.json` storage under
   `~/.<system>/hooks/`, exact-source-hash review state, stable Agent-ref targeting, deterministic matching,
   and safe failure policies. Build the bounded short-lived child-process protocol with cancellation,
   process-tree cleanup, packaged-runtime coverage, and sanitized diagnostics. This slice establishes the
   executable-code boundary but does not yet connect hooks to agent lifecycles or add the full Hooks screen
   and AI authoring wizard; those remain deferred as `092.2` and `092.3`.
9. **`045` — North Star MCP bridge for CLI providers.** After `042`, make North Star a second, distinct
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
10. **`067` — Conversation-scoped workspace checkpoints.** Add a reversible safety layer for autonomous
   edits using conversation+workspace-scoped, content-addressed app-data manifests and blobs. Provide
   bounded create/list/diff/restore operations with conflict-aware previews, explicit approval, quotas,
   retention, and crash-safe lifecycle handling. Preserve unrelated user changes and never wrap destructive
   `git reset`/`checkout`/`clean` operations.
11. **`069` — Process intake policies and inspectable assumptions.** Give each Process an explicit run-
   entry contract instead of injecting a mandatory Planning phase: **Proceed with assumptions**
   (default, no preflight gate), **Approve initial plan** (side-effect-free execution brief + one durable
   approval/revision loop), or **Strict input contract** (definition-authored required fields validated
   before enqueue). Snapshot supplied inputs on the run; inject intake guidance, definition of done, and
   a shared materiality/authority interruption rule into phase kickoffs. Add a durable, run-scoped
   assumptions log with origin/confidence/impact/status and monitor UI. Human clarification pauses and
   resumes the correct worker; it remains distinct from internal Agent exchanges (`039`). Split strict
   deterministic intake first, then assumptions/questions, then approve-plan preflight.
12. **`084` — Process import account-remapping UX.** Analyze imported Process runtime selections before
    writing, distinguish locally resolved, matchable, ambiguous, and unresolved provider/model references,
    and let the user map each unresolved reference to a local account/model or choose inheritance. Keep
    account IDs machine-local, preserve portable import/export intent, and avoid raw account-ID failures.
13. **`085` — Process template library.** Add a small, polished built-in catalog of portable starter
    Processes backed by the existing import/create validation path. Let users preview and instantiate
    useful workflows without starting from a blank graph; templates inherit runtime by default and never
    hard-code local provider-account IDs.
