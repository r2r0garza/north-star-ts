# Roadmap — Deferred

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
- **`010` — Container runtime profiles — RE-ANALYSIS REQUIRED.** The original plan predates substantial
  improvements to execution environments, runtime selection, Process runtime overrides, provider routing,
  and settings. Its `node` / `python` / `fullstack` profile model, per-conversation scope, image migration,
  and operational assumptions must be re-audited against the current architecture and the plan rewritten
  before implementation. Preserve the underlying goal—decouple Workspace files from execution Runtime—but
  do not implement the stale design as written.
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
  visualization out of the first canvas slice.
- **`087` — Request-scoped skill opportunities and opt-in drafting.** Reuse the existing first-message
  title-model round trip for a structured opportunity signal, validate positive candidates against the
  actual successful run, and ask whether to draft before generating any skill content. Retain inert,
  versioned review and exact-revision installation through `077`/`028`; a separate user setting disables
  both hidden detection and recommendations without affecting explicit skill authoring. Do not require
  three global repetitions or classify every conversational utterance.
- **`070` — Pods: autonomous agent teams with mutable work graphs. DEFERRED SEED.** A Pod is not a
  saved roster or a loose Process: it owns an objective and may create, split, assign, cancel,
  reprioritize, and revisit work within a charter, budget, and externally defined completion contract.
  Reuse the task/agent runtime, `069` intake/assumptions, and `039` result/exchange foundations; net-new
  concepts are the durable mutable work board, bounded coordinator replan loop, independent completion
  evaluator, and charter enforcement. Activate only after `069`/`039` land, three concrete objectives
  demonstrate runtime topology change beyond Process fan-out/rework, and a bounded prototype materially
  outperforms the equivalent Process without unacceptable cost, thrash, or user confusion.
- **`066` — Notebook editing and cell execution.** Depends on `063`'s safe reader and a reviewed
  Environment-backed kernel contract. Adds revision-safe structured cell edits and separately
  execution-gated cell runs with Stop/timeouts/output caps; never installs kernels or treats notebook
  reading as permission to execute code.
- **`068` — Progressive tool discovery.** Implement only after measurements show the growing catalog
  hurts context or selection. `tool_search` searches/activates only the already-authorized catalog
  after mode/workspace/agent/MCP policy; denied tools are neither revealed nor activated, and stale
  activations invalidate on policy/runtime changes.
- **`053` — Linux Local sandbox adapter.** Future hardening for `052`'s stronger Local
  runtime profiles on Linux. Docker/Podman remains the supported Linux sandbox path for now; this
  plan only becomes active if we decide Local should enforce `read-only` / `workspace-write` without a
  container. Candidate adapters include Bubblewrap/namespaces and Landlock, but the acceptance bar is
  real OS enforcement for filesystem, network, and process-tree cleanup. Unsupported Linux hosts must
  continue to fail closed and point users to containers or explicit host access.
- **`054` — Windows Local sandbox adapter.** Future hardening for `052`'s stronger Local
  runtime profiles on Windows. Docker/Podman remains the supported Windows sandbox path for now; this
  plan only becomes active if we decide Local should enforce `read-only` / `workspace-write` without a
  container. Likely requires more than Job Objects: process-tree cleanup plus filesystem and network
  restrictions may need AppContainer/restricted-token support or a packaged native helper. Unsupported
  Windows hosts must continue to fail closed and point users to containers or explicit host access.
- **`055` — Local filesystem openat helper.** Future hardening required to close debug
  `054` completely. The current Node local filesystem backend now revalidates after a deterministic
  pre-syscall seam, but complete workspace confinement needs validation/use binding through opened
  directory handles and directory-relative primitives (`openat`/`renameat`/`linkat`/`unlinkat` or
  platform equivalents). Add a packaged native helper or addon for local host filesystem operations,
  preserve missing-leaf/no-replace/atomic-staging behavior, and prove parent swaps cannot redirect
  reads, writes, chmods, renames, links, unlinks, mkdir, list/stat, or search roots outside the
  workspace.
- **`043` — Copilot CLI provider.** Split out of `034` but parked for now.
  Probes under `cli_probes/copilot/` confirmed no-tool JSONL streaming, caller-assigned
  `--session-id`, resume, assistant message deltas, final `assistant.message`, and final `result`.
  Tool support is deliberately deferred: a shell-tool probe with `--allow-tool=shell` was rejected as
  too risky in an escalated signed-in environment, and the minimum safe non-interactive permission
  posture needs a separate decision. Revisit after Claude Code and Codex CLI are working.
