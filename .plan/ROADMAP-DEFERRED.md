# Roadmap — Deferred

- **`110` — Anthropic subscription usage investigation.** Moved from Next on 2026-10-11: Anthropic
  Subscription is hidden in packaged builds and is not the user's daily provider. Revisit only if shipping it
  again is on the table. Start with the cheap discriminating test — the same task through native `claude -p`
  and through North Star — before the full accounting audit; parity with `claude -p` points to headless
  metering, which North Star cannot fix in code. Gates `109.6`.
  [Plan](110-anthropic-subscription-usage-investigation.md).
- **`092.1` — Agent lifecycle hook contract, storage, runner, and safety controls.** Moved from Next on
  2026-10-11: a runner with no lifecycle wiring or UI delivers no user value on its own, and hooks are a
  power-user feature rather than an adoption driver. If revived, prefer a thin vertical slice (one `preTool`
  deny event wired end-to-end with minimal UI) over the foundation-first split.
  [Plan](092-agent-lifecycle-hooks.md).
- **`067` — Conversation-scoped workspace checkpoints.** Add a reversible safety layer for autonomous
  edits using conversation+workspace-scoped, content-addressed app-data manifests and blobs. Provide
  bounded create/list/diff/restore operations with conflict-aware previews, explicit approval, quotas,
  retention, and crash-safe lifecycle handling. Preserve unrelated user changes and never wrap destructive
  `git reset`/`checkout`/`clean` operations. *(2026-10-11: priority candidate after Mission Control validation; Autopilot makes a reliable undo more important. Consider git hidden refs for git workspaces and the blob store only for non-git folders.)*
- **`109.6` — Windows subscription startup optimization — IN PROGRESS, DEFERRED.**
  Paused at the user's direction on 2026-10-10 pending investigation and resolution of unexpectedly rapid
  Anthropic subscription allowance consumption in North Star compared with native Claude Code using Opus;
  the cause is not yet established. Preserve existing implementation and measurement work for resumption.
  Anthropic Subscription remains available for internal testing in unpackaged development builds but is
  hidden from the provider picker in packaged builds. Startup latency improvements do not resolve usage
  efficiency; resume once that concern is understood and addressed. Preserve private-state ACLs,
  managed-policy/auth guards, request isolation and cleanup; native API/helper changes still require
  measured justification and native/packaged regression evidence.
  [Plan](109.6-windows-subscription-startup-optimization.md).
- **`105` — Required skills for individual Process phases.** Let an agent phase explicitly activate one
  required skill for every worker invocation, distinct from the phase-agent skill allowlist. Validate pool
  compatibility, fail before the LLM call when the skill is unavailable, snapshot resolved identity, and
  never offer or propagate the setting on sub-process or deterministic command phases. *(2026-10-11: applies to both Processes and playbooks; pick up if dogfooding shows phases ignoring required skills.)*
- **`069` — Process intake policies and inspectable assumptions.** Give each Process an explicit run-
  entry contract instead of injecting a mandatory Planning phase: **Proceed with assumptions**
  (default, no preflight gate), **Approve initial plan** (side-effect-free execution brief + one durable
  approval/revision loop), or **Strict input contract** (definition-authored required fields validated
  before enqueue). Snapshot supplied inputs on the run; inject intake guidance, definition of done, and
  a shared materiality/authority interruption rule into phase kickoffs. Add a durable, run-scoped
  assumptions log with origin/confidence/impact/status and monitor UI. Human clarification pauses and
  resumes the correct worker; it remains distinct from internal Agent exchanges (`039`). Split strict
  deterministic intake first, then assumptions/questions, then approve-plan preflight. *(2026-10-11: start with the strict input contract only; it makes a Process feel like a callable tool. Assumptions log and plan-approval loop later, if at all.)*
- **`084` — Process import account-remapping UX.** Analyze imported Process runtime selections before
  writing, distinguish locally resolved, matchable, ambiguous, and unresolved provider/model references,
  and let the user map each unresolved reference to a local account/model or choose inheritance. Keep
  account IDs machine-local, preserve portable import/export intent, and avoid raw account-ID failures. *(2026-10-11: matters once Processes/playbooks are shared between users; natural follow-up to `085`.)*
- **`085` — Process template library.** Add a small, polished built-in catalog of portable starter
  Processes backed by the existing import/create validation path. Let users preview and instantiate
  useful workflows without starting from a blank graph; templates inherit runtime by default and never
  hard-code local provider-account IDs. *(2026-10-11: high priority candidate — strongest onboarding lever for other users, since Processes are the main attraction. Templates should work for Processes and as playbooks.)*
- **`098` — Browser network request lifecycle and idle semantics.** Activate after capturing a stale-request
  failure or when network tracking next changes. Define CDP behavior across navigation, redirects, abandonment,
  SSE, and WebSockets before choosing generations, stale sweeping, or resource exclusions; do not blindly clear
  the active map at `did-navigate` and risk false idle.
- **`100` — Measured index import lookup optimization.** Activate only when representative large-workspace
  query plans and latency show `findImportsOf()`'s JSON expression scan is material. Compare an SQLite expression
  index with a stored module column, then adopt the smallest measured design without changing lookup semantics.
- **`101` — Browser chrome sandbox hardening.** During an Electron security/browser-window pass, test enabling
  sandboxing for the trusted browser-chrome renderer, whose preload currently appears IPC-only. Verify development
  and packaged behavior before changing it; retain the main window's documented file-drop tradeoff unless
  `webUtils.getPathForFile` receives a tested replacement.
- **`092.2` — Agent lifecycle integration and observability.** After `092.1` proves the executable hook
  boundary, connect outer events across internal live/durable/Process/subagent paths without duplicates;
  add lifecycle-safe internal `preTool`/`postTool`, outer CLI events, North Star MCP-bridge coverage,
  bounded invocation summaries, compatibility reporting, cancellation, quarantine, and restart behavior.
- **`092.3` — Hooks screen and AI-assisted authoring.** After the runner and lifecycle integration are
  established, add the Hooks management/detail/editor/test/history surface, agent targeting and provider
  compatibility matrix, then an isolated iterative Ask AI wizard that creates inert validated drafts with
  no write/run/enable authority. New and generated code remains disabled until exact-revision review and
  explicit enablement.
- **`032` — Process visual canvas.** The explicitly deferred visual half of `026`: draggable phase nodes,
  dependency edges, persisted layout, deterministic auto-layout, and a shared phase inspector over the
  existing Process CRUD. Re-analyze its stale schema/version assumptions before implementation, choose the
  canvas/layout library deliberately, retain the proven keyboard-friendly list builder, and keep live-run
  visualization out of the first canvas slice. *(2026-10-11: still expensive, but a visible workflow graph sells and explains Processes; revisit after a Process UX dogfooding pass identifies the real friction.)*
- **`068` — Progressive tool discovery.** Implement only after measurements show the growing catalog
  hurts context or selection. `tool_search` searches/activates only the already-authorized catalog
  after mode/workspace/agent/MCP policy; denied tools are neither revealed nor activated, and stale
  activations invalidate on policy/runtime changes.
- **`045` — North Star MCP bridge for CLI providers.** After `042`, make North Star a second, distinct
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

## Dropped — pending re-review (2026-10-11)

Removed from the active roadmap; plan files are kept with status **DROPPED — PENDING RE-REVIEW**.

- **`109.4` — Claude Code inference across authentication and managed-policy configurations.** Managed-policy/enterprise auth is a deep compatibility problem; Portkey/API providers already cover non-personal accounts. [Plan](109.4-claude-code-authentication-and-managed-policy.md).
- **`087` — Request-scoped skill opportunities and opt-in drafting.** Speculative; adds hidden model work to requests without a demonstrated need. [Plan](087-request-scoped-skill-opportunities.md).
- **`066` — Notebook editing and cell execution.** No current need for notebook editing/execution. [Plan](066-notebook-editing-and-execution.md).
- **`043` — Copilot CLI provider.** No demand for a Copilot provider; unsafe tool posture unresolved. [Plan](043-copilot-cli-provider.md).
- **`053` — Linux Local sandbox adapter.** Large native effort; containers remain the supported sandbox path. [Plan](053-linux-local-sandbox-adapter.md).
- **`054` — Windows Local sandbox adapter.** Large native effort; containers remain the supported sandbox path. [Plan](054-windows-local-sandbox-adapter.md).
- **`055` — Local filesystem openat helper.** Large native effort for an unusual threat (mid-operation parent swaps); revisit with a concrete threat. [Plan](055-local-filesystem-openat-helper.md).
- **`010` — Container runtime profiles — RE-ANALYSIS REQUIRED.** Design is stale (marked re-analysis required); rewrite from scratch if the goal returns. [Plan](010-container-runtime-profiles.md).
