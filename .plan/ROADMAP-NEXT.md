# Roadmap — Next up

> **Note (2026-09-26):** the `106.x` plans predate a rename — Initiatives are now **Features**,
> Missions are **Milestones**, and Slices are **User stories**. Each pending `106.x` plan has a mapping note at the top.

1. **`067` — Conversation-scoped workspace checkpoints.** Add a reversible safety layer for autonomous
   edits using conversation+workspace-scoped, content-addressed app-data manifests and blobs. Provide
   bounded create/list/diff/restore operations with conflict-aware previews, explicit approval, quotas,
   retention, and crash-safe lifecycle handling. Preserve unrelated user changes and never wrap destructive
   `git reset`/`checkout`/`clean` operations.
2. **`111` — Chat worktrees and background delegation opt-in.** Add a default-off North Star chat
   checkbox controlling subagent spawning and associated writer worktrees. Persist the permission snapshot
   through background handoffs, retries, resumes, and restarts; withhold both spawn tools and inject an
   explicit no-worktrees instruction when off. Enabling permits, but does not require, delegation while
   preserving existing isolation and approval safeguards.
   [Plan](111-chat-worktrees-and-background-delegation-opt-in.md).
3. **`092.1` — Agent lifecycle hook contract, storage, runner, and safety controls.** Define versioned
   event/result/metadata schemas, canonical guarded `.hook.cjs` + `.hook.json` storage under
   `~/.<system>/hooks/`, exact-source-hash review state, stable Agent-ref targeting, deterministic matching,
   and safe failure policies. Build the bounded short-lived child-process protocol with cancellation,
   process-tree cleanup, packaged-runtime coverage, and sanitized diagnostics. This slice establishes the
   executable-code boundary but does not yet connect hooks to agent lifecycles or add the full Hooks screen
   and AI authoring wizard; those remain deferred as `092.2` and `092.3`.
4. **`110` — Anthropic subscription usage investigation.** Investigate user-observed rapid Opus
   allowance consumption versus native Claude Code with privacy-preserving per-round accounting and
   explicitly approved, bounded matched trials. Separate uncached input, cache writes/reads, thinking/output,
   retries, auxiliary calls and task quality; establish the cause before proposing remediation. Keep packaged
   provider selection hidden pending evidence and an explicit release decision; `109.6` remains deferred.
   [Plan](110-anthropic-subscription-usage-investigation.md).
