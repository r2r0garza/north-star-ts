# PR92: Agent lifecycle hooks and AI-assisted authoring

> Status: **PLANNED**. Add user-authored executable lifecycle extensions with guarded discovery,
> out-of-process execution, exact-revision activation, inspectable outcomes, and an AI-assisted creation
> wizard. This is an application extension surface, not a way to bypass agent capability or approval
> policy.

## Problem

North Star agents currently follow application-defined lifecycle and tool behavior. Users can shape an
agent with its prompt, tools, skills, children, and MCP servers, but cannot run a small local policy or
integration at a lifecycle boundary. Common needs include rejecting a tool call that violates a local
rule, attaching project context when a session starts, recording a bounded audit annotation after a tool
finishes, or notifying a local integration when an agent produces its final response.

Requiring users to patch North Star for each need does not scale. Requiring them to hand-author an
executable extension format is also a poor product surface: event payloads and return contracts are easy
to misunderstand, and unsafe defaults can turn a useful customization into an opaque source of failures.
The product needs both a narrow hook contract and a guided authoring experience.

Hooks are executable code. They must not be treated like passive agent or skill metadata, imported into
Electron's main process, or presented as sandboxed when they still execute with the local account's
operating-system authority.

## Product contract

Hooks live globally under `~/.<system>/hooks/`, where `<system>` comes from the existing
`dataDirName()` resolver. No code may hard-code `.cowork` or `.north-star`.

Each hook is an explicit pair:

- `<slug>.hook.cjs` contains executable CommonJS code.
- `<slug>.hook.json` contains versioned, non-executable metadata: display name, description, enabled and
  review state, subscribed events, scope, selected agent references, run-kind filters, priority, failure
  policy, declared event-data needs, and the approved code hash.

Use `.cjs`, not `.js`. Hook files live outside a package boundary, and explicit CommonJS avoids ambient
`package.json` `type` behavior while providing one stable `module.exports` contract. V1 does not
transpile TypeScript or install hook dependencies.

A hook may target **all agents** or a list of **selected agents**. Selected targets use stable,
source-qualified `AgentRef` identities rather than display names. The built-in main agent needs an
explicit stable target identity so it can participate in the same scope control. Scope is matched when a
run starts and rechecked before every invocation; renaming, deleting, or hiding an agent cannot cause a
name collision to select a different one.

Discovery reads and validates metadata and source as data; it never imports or executes a hook. File
operations are atomic, create-only or stale-safe as appropriate, symlink-aware, and confined to the
canonical hooks root. A missing half of a pair, malformed metadata, invalid slug, oversized file, unknown
schema version, or hash mismatch appears as a diagnostic and cannot execute.

## V1 event catalog

### `sessionStart`

Fire once when an agent execution session starts or resumes, before its first model request. The payload
identifies the run kind, provider/runtime family, conversation/task/process identifiers where applicable,
workspace identity, agent reference, and whether this is a resume. It does not contain a complete
transcript or model prompt.

### `onMessageSent`

Fire after a user or root input has been durably accepted but before it is sent to the model. The default
payload contains bounded direct input plus provenance and run metadata. A hook may return bounded
additional context; it cannot replace, hide, or reinterpret the canonical message stored in history.

### `preTool`

Fire after tool arguments parse successfully and the call is confirmed to be in the offered toolset, but
before North Star's policy/approval gate and before execution. A matching hook may continue or veto the
call with a bounded reason.

A `preTool` hook is never an approval authority. `continue` still passes through the normal policy engine,
plan-mode classifier, environment confinement, and any required human approval. A hook cannot approve a
call, weaken a decision, change the offered toolset, rewrite arguments, or convert a previously blocked or
unknown operation into success. Vetoes are recorded as canonical not-started/blocked outcomes rather than
fabricated tool executions.

### `postTool`

Fire after the canonical tool outcome and lifecycle state are durably settled, before the next model
round. It may emit a bounded annotation or additional context but cannot replace the persisted result,
change success/error/unknown state, trigger reconciliation, or mutate approval records.

### `onAgentResponse`

Fire after the canonical final assistant response is durably stored. It may emit diagnostics or perform
its own local integration work, but cannot rewrite the response shown to the user or added to history.

### `sessionEnd`

Fire once for every terminal exit: success, stop, cancellation, or failure. It receives a bounded outcome
summary and does not change the run's canonical status.

### `onError`

Fire for bounded structured failures. Payloads contain stable error category/stage and sanitized context,
not raw stack traces, credentials, environment dumps, or unrestricted command/model output. Errors raised
by an `onError` hook do not recursively dispatch `onError`.

## Deferred event surfaces

Defer `preModel` and `postModel`, token-stream hooks, approval/question hooks, application startup or
shutdown hooks, scheduled hooks, remote/webhook triggers, and arbitrary custom event names. Raw model
requests and responses expose broad prompts, history, provider details, and potentially sensitive data;
token hooks also sit on a latency-critical path. Add any of these only after a concrete use case defines a
least-data payload and intervention contract.

## Hook API and result semantics

The initial source contract is deliberately small:

```js
module.exports = async function hook(event, api) {
  return { action: "continue" }
}
```

`event` is a frozen, versioned, JSON-serializable DTO. Every event schema has least-data defaults and hard
field, item, and byte limits. Metadata declares any optional data class a hook needs; the UI describes the
privacy effect before activation. Complete prompts, complete transcripts, credentials, process
environments, unrestricted file contents, and unrestricted tool output are never supplied by default.

`api` initially exposes only app-owned bounded logging helpers and cancellation state. It exposes no
Electron/main-process objects, renderer handles, database handles, approval APIs, provider clients,
secrets, or unrestricted internal services. Hook code remains ordinary local JavaScript and may still use
Node capabilities available in its worker process; the UI must not imply that this small app API removes
its operating-system authority.

Results use event-specific discriminated unions. Exact names may be refined during implementation, but
supported effects are limited to:

- `continue` for no intervention;
- `block` for events that explicitly support veto, initially `preTool`;
- `context` for bounded model-visible supplemental context at documented lifecycle boundaries; and
- `annotation` for bounded user/diagnostic visibility without changing canonical state.

Unknown actions, extra fields, oversized values, non-JSON values, and schema-version mismatches are
invalid results. Hooks never replace canonical messages, assistant responses, tool results, lifecycle
rows, approval decisions, or run statuses.

Dynamic model-visible hook output receives explicit `hook` provenance and is treated as untrusted derived
data. This prevents a hook that processed a hostile filename, diff, page, or tool result from laundering
that content into approved instructions. Hook context may inform work but cannot grant authority, expand
tools or filesystem scope, alter policy, install persistent instructions, or approve an action.

## Ordering, filtering, and recursion

Matching hooks execute sequentially by ascending numeric `priority`, then slug for deterministic ties.
Parallel hook execution is deferred because intervention ordering and diagnostics need to be explainable.

Metadata can filter these run kinds:

- live internal conversations;
- durable tasks;
- Process phase/decompose/validate workers;
- subagents; and
- Claude Code or Codex CLI-backed conversations.

The dispatcher computes one normalized run identity so wrappers around `runAgentLoop` do not double-fire
outer lifecycle events. Hook execution, hook testing, the hook-authoring model call, title/metadata calls,
commit-message Ask AI, and hook-produced diagnostics never recursively dispatch hooks.

## Failure behavior

Every hook declares an allowed failure policy. Safe observational events default to **continue with a
visible warning** when a hook times out, crashes, or returns malformed output. Intervention events,
especially `preTool`, default to **abort/block** on runner failure so a local guard does not silently fail
open. The UI explains the policy and does not offer unsafe combinations for events whose purpose is to
prevent an action.

Each invocation has a hard deadline, bounded input/output/error streams, and cancellation tied to the
owning run. Per-run concurrency and total invocation budgets prevent a hook set from indefinitely delaying
an agent. A failed hook cannot leave a fabricated tool result or half-settled lifecycle state.

Persist bounded invocation summaries containing hook identity and revision, event, run/conversation/agent
identifiers, start/end time, duration, outcome, and clipped sanitized error. Do not retain raw event
payloads by default. Repeated deterministic failures may quarantine or disable a hook with a visible
reason, but the application never silently edits user source.

## Runtime and security boundary

Never `require()` or dynamically import user hook code in Electron's main process.

Run one invocation in a short-lived child or utility process through a small app-owned runner and a
versioned JSON-over-stdio protocol. Launch by executable plus argv—never a model/user-built shell string.
Use a neutral working directory, minimal inherited environment, bounded stdin/stdout/stderr, deadline,
cancellation, and full process-tree cleanup. The parent validates the result schema before applying any
supported effect.

Use `process.execPath` with packaged Electron Node mode or `utilityProcess` according to a focused
packaging probe. The selected mechanism must work in development and packaged macOS, Windows, and Linux
builds and must prove cancellation/descendant cleanup. Do not rely on files being present outside ASAR
unless packaging explicitly includes/unpacks the runner.

This process boundary isolates crashes, protocol parsing, and resource limits. It is **not a filesystem or
network sandbox**. Unless a separately proven OS sandbox is introduced, user hook code runs with the local
account's authority and can use ordinary Node APIs. The enable/test experience must state this plainly.
Container workspace settings and the agent tool policy do not automatically constrain this app-owned host
extension process.

Generated and newly created hooks start disabled. Enabling or explicitly testing a hook requires reviewing
the exact code revision and acknowledging an executable-code warning. Approval binds to a SHA-256 source
hash recorded in metadata. Any source change, whether made in-app or externally, invalidates that review
and returns the hook to disabled/review-required state before another invocation.

## Runtime integration

### Internal agent loop

Integrate lifecycle dispatch at a few shared seams rather than scattering callbacks through every caller.
`runAgentLoop` supports the full v1 catalog. `preTool` and `postTool` wrap individual North Star-owned tool
calls without weakening `runToolCallBatches`, tool-effect ordering, durable intent/lifecycle persistence,
approval gating, result reconciliation, command-session ownership, or image delivery.

The exact ordering must be test-driven. In particular, a `preTool` veto occurs only after the call is known
and parsed, before policy/execution, and settles as not-started/blocked. `postTool` sees a read-only bounded
projection only after the real outcome is durable. If persistence fails, no post hook may make the call
look settled.

Outer lifecycle events cover live conversations, resumed durable tasks, Process workers, and nested
subagents exactly once per normalized execution. `sessionEnd` belongs in terminal cleanup but must not
mask the real result if its hook fails.

### Autonomous CLI providers

Claude Code and Codex CLI own their internal agent loops and execute native tools inside their subprocesses.
North Star can support outer events around those conversations: `sessionStart`, `onMessageSent`,
`onAgentResponse`, `onError`, and `sessionEnd`.

North Star cannot reliably intercept native Claude Code or Codex tool calls. In v1, `preTool`/`postTool`
cover North Star-owned tools, including calls exposed through North Star's MCP bridge, but not tools the
CLI executes internally. The Hooks screen shows an event/provider compatibility matrix and never claims
full parity. Native CLI tool interception is out of scope unless those providers later expose a stable,
enforceable lifecycle protocol.

## Hooks screen

Add a dedicated **Hooks** destination alongside Agents, Skills, Processes, and MCP. Reuse their
browse/detail/form vocabulary instead of hiding executable extensions in a generic Settings table.

The screen supports:

- browse, filter, and deterministic status/diagnostic badges;
- enable/disable with exact-revision review state;
- create, edit, duplicate, delete, and reveal in the platform file manager;
- event, run-kind, all-agents/selected-agents, priority, data-needs, and failure-policy editors;
- source and metadata review with a clear executable-code warning;
- provider/event compatibility display;
- explicit test with a sanitized sample event and bounded output;
- recent invocation summaries, failure reasons, and quarantine state; and
- stale/external edit detection before save, test, or enable.

Selected-agent controls reuse the existing source-qualified agent catalog. Deleted/unavailable targets
remain visible as unresolved metadata rather than silently broadening the hook to all agents.

## AI-assisted authoring wizard

The creation wizard asks for intent, lifecycle events, all-versus-selected-agent scope, run kinds, optional
event data, priority/failure behavior, name/description, and a natural-language requirement. It then offers
deterministic templates or **Ask AI**.

Ask AI follows the isolation principle of the existing commit-message generator, but supports iterative
feedback within the draft modal:

- It is not a normal conversation or durable task and receives no conversation history, skills, hooks,
  general tools, filesystem authority, delegation, memory, browser, network, or approval surface.
- Its trusted input is limited to the versioned hook API/schema, selected wizard metadata, sanitized sample
  events, the current inert draft, and direct user revision feedback.
- It returns strict structured output containing validated metadata fields and `.cjs` source. Parsing rejects
  preambles, unsupported exports/events/actions, oversized source, malformed JSON, and mismatched names.
- Model rounds, tokens, evidence, and revisions are bounded and cancellable. Closing the modal, changing
  scope, or starting another generation invalidates stale responses.
- The model cannot write, test, enable, or run code. Output is an editable inert draft shown with metadata
  and a readable revision diff.
- Save creates or updates a disabled draft. Review and enable are separate actions bound to the exact source
  hash; generated code is never automatically activated.

When no provider is configured or generation fails, event-specific deterministic templates keep manual
hook creation usable.

## Storage and IPC

Add a hook service under `src/main/agent/hooks/` (exact module names may follow repository conventions)
for paths, metadata/source parsing, hashing, guarded CRUD, matching, dispatch, worker protocol, and
invocation summaries. Keep renderer IPC narrow and typed: tree/list, read, create/save, duplicate/delete,
test, enable/disable, and invocation-history operations. The renderer never chooses arbitrary host paths,
worker executables, argv, or module imports.

Follow the existing Agents/Skills path guards but strengthen them for paired executable files and
symlinks. Runtime validation is authoritative; disabled controls in the renderer are only convenience.
Return renderer-safe diagnostics rather than raw `Error` objects or stacks.

The exact retention cap and storage for invocation summaries remain an implementation decision. Prefer a
bounded SQLite table if filtering and per-run correlation justify it; otherwise use an app-data ring log.
Either choice must enforce retention and exclude raw payloads.

## Delivery plan

### 092.1 — Contract, storage, runner, and safety controls

Define versioned event/result/metadata schemas, canonical hook paths, pair discovery, guarded CRUD, source
hash/review state, matching, and failure policies. Build the app-owned subprocess protocol with limits,
cancellation, cleanup, safe diagnostics, and packaged-runtime coverage. Add templates and tests before
connecting execution to agents.

### 092.2 — Agent lifecycle integration and observability

Dispatch outer events across internal live/durable/Process/subagent paths without duplicates. Add internal
`preTool`/`postTool` at lifecycle-safe seams, outer CLI events, and North Star MCP bridge tool coverage.
Persist bounded invocation summaries and surface provider compatibility, cancellation, quarantine, and
restart behavior.

### 092.3 — Hooks screen and AI authoring wizard

Add the application destination, management/detail/editor/test/history UX, agent targeting and
compatibility matrix, narrow IPC/preload surface, isolated iterative generation/revision service,
deterministic fallbacks, exact-revision review, and accessible enablement warnings.

## Verification

Automated coverage must prove:

- Discovery never executes code and rejects malformed, oversized, foreign, incomplete, and symlink-escaped
  hook pairs.
- `.cjs` loading is deterministic regardless of the surrounding package's module type.
- Disabled, unreviewed, quarantined, hash-mismatched, and stale-revision hooks never execute.
- Worker timeout, crash, malformed JSON, output overflow, cancellation, and descendant cleanup are bounded
  in development and packaged-runtime probes.
- Matching and ordering are deterministic across global/selected-agent scope, run kinds, priority, and slug.
- Each outer lifecycle event fires once on success, resume, stop, cancellation, and failure, with no recursive
  dispatch from hook infrastructure.
- `preTool` can veto but cannot approve, rewrite arguments, skip policy, corrupt lifecycle state, or convert
  an unknown side effect into success.
- `postTool` and response hooks cannot replace or race canonical persisted outcomes.
- Model-visible hook output has explicit untrusted provenance and cannot grant authority.
- Internal and CLI event compatibility behaves exactly as advertised, including North Star MCP bridge calls
  and the absence of native CLI tool interception.
- AI generation/revision receives no execution or persistence capability, strictly validates output, drops
  stale/cancelled results, and leaves a reviewable disabled draft.
- Renderer tests cover keyboard/screen-reader behavior, unresolved agent targets, compatibility and failure
  diagnostics, exact-revision warnings, stale edits, and recent invocation history.

Run focused hook/agent/tool-lifecycle/CLI/IPC/renderer tests, then `pnpm typecheck`, `pnpm test`, and
`pnpm build`. Manual UAT should cover a live internal turn, durable task, Process worker, subagent, failed
and timed-out hook, external source edit, generated/revised hook, and Claude Code/Codex outer events where
those providers are configured.

## Open implementation questions

1. **Packaged worker mechanism.** Compare `utilityProcess` with Electron-as-Node `process.execPath` in a
   small packaging probe. Choose the option with reliable cross-platform cancellation, descendant cleanup,
   stdio framing, and ASAR behavior.
2. **Worker lifetime.** Lean one process per invocation for isolation and simple cancellation. Introduce a
   supervised pool only if measured startup latency is unacceptable; do not pre-optimize with a persistent
   user-code host.
3. **Invocation-summary storage.** Decide SQLite versus a bounded app-data ring after confirming query/UI
   needs. In either case define hard retention and never store raw event payloads by default.

## Out of scope

- A hook marketplace, package import ecosystem, publishing, signing/trust registry, or automatic updates.
- Workspace/custom hook roots; V1 uses only the guarded global `~/.<system>/hooks/` root.
- TypeScript transpilation, npm dependency installation, arbitrary package resolution, or a build pipeline.
- Remote, scheduled, webhook, application-startup, or custom user-defined events.
- Native Claude Code/Codex tool interception.
- Raw model prompt/response/token-stream access or unrestricted transcript/tool/file payloads.
- Rewriting user messages, model responses, tool arguments, tool results, approvals, or questions.
- Hooks that grant permissions, answer approval/question prompts, change tool availability, or bypass
  environment/policy/lifecycle reconciliation.
- Secrets APIs, renderer/main-process/database handles, or unrestricted North Star internal APIs.
- Claiming that a child process alone sandboxes arbitrary local JavaScript.
- Automatic testing, saving, review, or enablement of AI-generated executable code.
