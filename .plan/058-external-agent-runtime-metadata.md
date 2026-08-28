# PR58: External agent runtime metadata, saved model mappings, and advanced fidelity

> Status: **NOT STARTED**. Depends on `056` and `057`. The source metadata is parsed
> in `056`; this plan decides when and how North Star executes it rather than merely
> reporting it.

## Context

External agent formats carry runtime preferences beyond tool access:

- Cursor: `model`, `is_background`.
- GitHub Copilot: `model`, `target`, `argument-hint`, invocation/deferred-loading
  controls.
- Claude: `model`, `effort`, `background`, `maxTurns`, `permissionMode`, `isolation`,
  `memory`, `hooks`, `initialPrompt`, and inline/named MCP servers.
- Codex: `model`, `model_reasoning_effort`, `sandbox_mode`, plus registry/config
  layering.

North Star always uses its internal runtime for these external definitions in the
current product. When a Claude Code or Codex CLI model/provider is selected, the agent
picker remains hidden and none of this translation applies. Supporting
`claude --agent` or a native Codex agent is a separate future design.

The dangerous shortcut is heuristic model aliasing. A Claude agent's `model: haiku`
does not identify which of many Haiku model IDs an OpenRouter account exposes. Similar
ambiguity exists across aliases, dated snapshots, gateways, and user-renamed model
catalog entries. North Star must not silently choose a model that only sounds close.

## Goal

1. Resolve external model preferences through explicit, inspectable configuration,
   never fuzzy-name matching.
2. Prompt once with a model-mapping modal when a source model has no saved mapping,
   then reuse that mapping on later runs.
3. Let users inspect, change, or clear saved mappings from Settings.
4. Enforce background and turn-limit semantics using North Star's durable task runner.
5. Map runtime metadata only where North Star has a semantically equivalent boundary.
6. Preserve and report unsupported metadata rather than pretending it was honored.
7. Make the effective runtime choices visible before execution and durable in history.

## Model resolution

Agreed baseline:

- `inherit` or omitted -> use the conversation's selected account/model.
- A configured source model must not be heuristically mapped across providers.

Recommended resolution order:

1. **Exact active-catalog ID match.** If the source value exactly equals a model ID in
   the conversation's selected provider account, use it.
2. **Saved user mapping.** Look up a mapping keyed by source kind + normalized raw
   source model token + destination provider account. Example:
   `(claude, "haiku", openrouter-1) -> "anthropic/claude-haiku-4.5"`. Source kind is
   load-bearing: a Cursor token with the same text is a separate mapping.
3. **Unresolved -> mapping modal.** Pause the send/run before creating an LLM turn and
   show the destination account's current model catalog. The modal identifies the
   source agent, source system, and raw model token, and requires the user to choose
   the destination model. Cancel leaves the message unsent/run unstarted.
4. **Save and continue.** Persist the selected mapping, derive the effective-runtime
   snapshot from it, and continue the original send without requiring the user to
   re-enter the message.

Mappings belong in settings/storage, not in rewritten external files. Validate the
destination against the live account catalog on every use; a removed model makes the
mapping stale and opens the modal again on the next attempted run. UI must show raw
source token, destination account/model, and whether the result came from inherit,
exact match, or a saved mapping.

GitHub/Cursor/Claude/Codex model preferences all use this same resolver. Provider-
specific aliases may be offered as suggested choices only when documentation and the
account catalog make them unambiguous; suggestions never execute until confirmed.

### Mapping storage and Settings

Add a dedicated model-mappings settings/repository surface rather than burying the
choice in a conversation row:

```ts
interface ExternalAgentModelMapping {
  sourceKind: "github" | "cursor" | "claude" | "codex"
  sourceModel: string
  destinationAccountId: string
  destinationModelId: string
  createdAt: number
  updatedAt: number
}
```

- Unique key: `(sourceKind, normalized sourceModel, destinationAccountId)`.
- Store the raw/display token as well if normalization changes case/whitespace, so the
  UI can quote the source faithfully.
- Settings lists mappings grouped by source system, showing source token, destination
  provider account, destination model, and stale/missing status.
- **Change** reopens a model picker and replaces the destination model.
- **Clear/reset** deletes that mapping. The next attempted run using the token opens
  the mapping modal again.
- Removing a provider account removes or invalidates its mappings transactionally;
  removing only a model marks mappings stale so the next run prompts again.
- Changing a conversation to a different provider account performs lookup in that
  account's mapping namespace and may prompt once for the new destination.
- Multiple agents from the same source kind using the same source token reuse the
  mapping. Agents from different source kinds do not share it accidentally.

The mapping modal must be reachable from direct conversation sends and Process launch.
For an interactive send, pause before persistence/inference and resume after selection.
For a Process, resolve every selected phase/validator agent before the run starts and
collect unresolved mappings through the same UI rather than allowing a headless worker
to block mid-run.

## Reasoning effort

- Map Claude `effort` and Codex `model_reasoning_effort` only when the selected
  destination model/provider supports that exact level.
- Clamp nothing silently. Unsupported levels fall back to the conversation's effort
  only after a visible compatibility warning (or explicit mapping if the provider uses
  a different vocabulary).
- Persist the effective effort with the run/task snapshot.

## Background execution

- Cursor `is_background: true` and Claude `background: true` mean invocations are
  scheduled through North Star's durable task runner rather than blocking the parent.
- When spawned as a child, return a durable task handle/status contract rather than a
  fabricated synchronous result; integrate with existing activity/transcript surfaces.
- When the user directly selects a background-default agent and sends a message, create
  a background task tied to the source conversation and make the UI transition explicit.
- Background execution always suppresses `ask_user_question` per `057`; the agent must
  proceed on reasonable assumptions or fail clearly rather than wait on a user who
  cannot answer that worker.
- Stop/resume/retry and app-restart behavior reuse the existing durable task lifecycle.

## Turn limits

- Claude `maxTurns` adds a per-run ceiling to `runAgentLoop` below North Star's own hard
  safety ceiling.
- Reaching the source ceiling returns a distinct terminal result (`max_turns_reached`)
  with partial progress, not a generic provider error.
- A source value cannot raise North Star's global maximum.
- Invalid/non-positive values produce a diagnostic and use the stricter safe default.

## Permission and isolation metadata

- Claude `permissionMode` maps only where an equivalent North Star approval/sandbox
  posture exists. It may narrow approvals but never bypass hardline policy, plan mode,
  workspace confinement, or destructive-action checks.
- `readOnly` maps to `057`'s read-only capability policy.
- `acceptEdits` may reduce ordinary edit prompts only within North Star's existing
  Auto/approval rules if the user has independently enabled that posture.
- `dontAsk`, `bypassPermissions`, and other non-equivalent modes are preserved as
  unsupported diagnostics; they do not disable North Star safety.
- Claude `isolation: worktree` requires a real isolated-worktree execution adapter. Do
  not claim support by merely changing cwd. Until that adapter exists, keep the agent
  runnable only after the user acknowledges the missing isolation or block it if the
  source marks isolation as required by current Claude semantics.
- Codex `sandbox_mode` enforcement remains in `057`; no Codex setting may widen North
  Star's environment profile.

## Memory, hooks, and initial prompts

### Memory

- Map Claude memory scopes only after North Star has a compatible per-agent memory
  boundary. Do not expose unrelated conversation/user memories merely because a source
  says `memory: user`.
- Until mapped, display the requested scope and an unsupported warning; do not inject
  approximate memory silently.

### Hooks

- Parse and display hooks, but do not execute arbitrary Claude/Codex/GitHub hook
  commands inside North Star automatically.
- A future hook-import flow must be separately reviewed, capability-scoped, and subject
  to North Star approvals. Unsupported hooks do not prevent unrelated agent
  capabilities from running unless their source semantics make them mandatory.

### Initial prompt

- Claude `initialPrompt` applies only when the definition is selected as the main
  thread agent, matching its source semantics; ignore it for subagent invocation.
- Never auto-submit a hidden user turn. Show the pending initial prompt and record it as
  a source-generated turn when the user starts the agent.
- Do not repeat it on resumed conversations.

## GitHub/Copilot invocation metadata

- Use `argument-hint` as composer/picker guidance; it does not alter tool authority.
- Respect `disable-model-invocation`/`infer` for automatic routing while retaining
  manual selection according to `user-invocable`.
- `target` and `deferred-tool-loading` affect compatibility/routing diagnostics. North
  Star does not pretend to be VS Code or GitHub cloud when a target excludes the local
  runtime.

## MCP setup handoff

Build the explicit setup experience anticipated by `057`:

- Show named servers requested by the agent and whether an enabled North Star server
  satisfies each one.
- For inline definitions, offer a review screen that copies only non-secret structure
  into North Star's existing MCP configuration flow after explicit confirmation.
- Never import secret expressions or execute a local command merely by selecting an
  agent.
- Once configured, execution is still governed by `057`'s server/tool intersection.

If a future Claude CLI adapter runs the agent natively, North Star does none of this
setup for that run; the user is responsible for configuring Claude Code's MCP servers.

## Effective-runtime snapshot and UI

Before a run, derive and display:

- source-qualified agent identity
- conversation provider/model
- source model token and resolution outcome
- effective reasoning effort
- foreground/background behavior
- turn limit
- sandbox/isolation posture
- requested vs supported MCP/memory/hook metadata
- compatibility warnings and explicit user overrides

Persist the snapshot with tasks/phase runs so retries and postmortems do not change
meaning when settings or external files later change. Re-resolving a live conversation
on a new user turn may use updated source config, but must show material changes.

## Verification

- Exact ID, first-run modal mapping, saved second-run reuse, changed mapping, cleared
  mapping, removed destination model, and ambiguous alias cases across several
  provider accounts.
- Same raw token is shared within one source kind/account but remains independent
  across Claude/Cursor/GitHub/Codex and across destination accounts.
- Canceling the modal leaves a conversation message unsent and a Process unstarted;
  completing it resumes the original action exactly once.
- Process preflight collects mappings before any headless phase worker starts.
- Prove no fuzzy alias selection (`haiku` never chooses among multiple catalog entries
  without confirmation).
- Effort support/unsupported cases and durable effective-runtime snapshots.
- Background direct-selection and child invocation use durable tasks, suppress user
  questions, survive restart, and honor Stop/resume.
- `maxTurns` terminates at the source ceiling with a distinct result and cannot raise
  North Star's ceiling.
- Permission/isolation settings cannot bypass North Star sandbox or approvals.
- Hooks and inline MCP commands never execute from discovery/selection alone.
- `initialPrompt` is visible, recorded once, and ignored for child invocation.
- CLI-provider conversations continue hiding the agent picker and never accidentally
  route through this internal-runtime translation.

## Out of scope

- Discovery/identity/parser work (`056`).
- Built-in/skill/child/MCP tool authorization (`057`).
- Native `claude --agent`, Codex CLI agent selection, or synchronizing North Star agents
  into another provider's directories.
- Automatically editing external agent files to make them compatible.
