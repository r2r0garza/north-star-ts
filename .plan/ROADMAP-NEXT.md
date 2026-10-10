# Roadmap — Next up

> **Note (2026-09-26):** the `106.x` plans predate a rename — Initiatives are now **Features**,
> Missions are **Milestones**, and Slices are **User stories**. Each pending `106.x` plan has a mapping note at the top.

1. **`109.4` — Claude Code inference across authentication and managed-policy configurations.**
   Deferred follow-up for API-key, Team/Enterprise, token-only and unknown/new auth states: support official
   CLI inference with capability-based setup, policy-preserving routing and accurate billing semantics.
   Separate work-machine qualification; no policy bypass or broader auth enablement in personal-account v1.
   Independent of `109.3`; depends on `109.1`/`109.2`.
   [Plan](109.4-claude-code-authentication-and-managed-policy.md).
2. **`109.5` — Host image vision and durable media history.** Address standalone image vision and
   durable screenshot/scanned-PDF pixels together through bounded provider-neutral host storage, canonical
   replay and transcript rendering. User accepted current limitations for completed `109.2`; this follow-up
   remains separate from that slice's accepted native Linux/Windows qualification. Distribution checks remain deferred until all 109.X work is done.
   [Plan](109.5-host-images-and-durable-media.md).
3. **`109.6` — Windows subscription startup optimization.** Measure and reduce remaining Windows
   generation/setup/discovery latency while preserving private-state ACLs, managed-policy/auth guards,
   request isolation and cleanup. The request-scoped PowerShell worker is already implemented and user-accepted;
   further optimization is not a latency gate for `109.2`. Native API/helper changes require measured justification
   and native/packaged regression evidence.
   [Plan](109.6-windows-subscription-startup-optimization.md).
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
