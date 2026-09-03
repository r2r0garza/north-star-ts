# PR78: Global workflow repetition detection and skill-proposal evidence

> Status: **PLANNED**. Depends on `076` for trust-aware evidence extraction. Independent of automatic
> memory: **Skill suggestions are enabled by default even when auto memory is disabled.** This plan
> records and matches successful workflows but does not generate or install skills; `079` owns that.

## Product contract

A workflow becomes eligible after **three separate successful root executions of the same reusable
procedure**, regardless of conversation, project, or current working directory.

- A weekly report for three different weeks qualifies.
- Fetching news from the same site with the same filtering/output procedure on three days qualifies.
- Retries, continuations, three subtasks inside one request, failed/cancelled runs, and model-only
  discussion do not count as separate executions.
- Project and cwd are provenance, not partition keys. The semantic workflow identity may still include a
  specific repository dependency when that dependency is essential to the procedure.

## Goal

1. Add a default-on `skillSuggestions.enabled` setting separate from `memory.enabled`.
2. Capture successful inline root turns, durable tasks, and Process roots exactly once through a common
   completion seam.
3. Normalize reusable intent/procedure while separating variable inputs such as date, topic, or report
   period.
4. Match executions globally, retain inspectable evidence, and create one proposal-eligibility event at
   the threshold.

## Storage

Add append-only evidence plus durable workflow/proposal state. Exact names may follow repository style:

```ts
interface WorkflowExecution {
  id: string
  sourceKind: "conversation_turn" | "task" | "process_run"
  sourceId: string
  conversationId: string | null
  workspaceId: string | null
  cwd: string | null
  completedAt: number
  objective: string
  procedure: string[]
  toolsAndSources: string[]
  outputContract: string | null
  variableInputs: Record<string, string>
  workspaceDependencies: string[]
  trustEvidence: unknown
  workflowId: string | null
}
```

Use a unique `(source_kind, source_id)` constraint for idempotency. A workflow record stores its stable
signature, canonical description, distinct-success count, last matched time, and suggestion state. Keep
proposal status separate because `not_now` and `rejected` have different future behavior.

Do not store complete transcripts or tool payloads in these tables. Store bounded structured summaries
and references to existing messages/tasks/events. Redact credentials and sensitive values before
persistence.

## Completion capture

- Introduce one idempotent `recordSuccessfulWorkflowExecution(...)` service called after a root result is
  durably committed.
- Cover the no-tool inline completion path currently adjacent to `recordMemoryTurn`, the durable task
  runner's completed transition, and top-level Process completion. Exclude nested agent/subtask results
  unless they were independently initiated root executions.
- Run asynchronously; classifier failure never changes the user's successful task result.
- Disabling Skill suggestions stops recording new executions and matching. Existing evidence, proposals,
  and approved skills remain available. Re-enabling resumes from retained evidence without fabricating
  missed executions.

## Normalization and matching

Use a constrained structured model call plus deterministic guards:

1. Decide whether meaningful work was successfully performed and is plausibly reusable.
2. Extract stable objective, ordered procedure, source/tool constraints, output contract, variable inputs,
   and workspace dependencies from provenance-aware evidence.
3. Generate a deterministic coarse fingerprint for candidate lookup.
4. Compare only bounded candidates semantically; exact fingerprints match without an extra model call.
5. Persist the match decision with confidence and reasons so it can be inspected and corrected.

Do not let the model choose the count or declare its own run successful. Success and distinct source IDs
come from application state. Require sufficient confidence before joining an existing workflow; uncertain
executions start a new candidate or remain unmatched rather than corrupting a cluster.

## Eligibility, suppression, and scope hints

- Emit eligibility once when a workflow reaches three distinct successes and has no active proposal or
  covering installed skill.
- Before eligibility, compare against the resolved skill catalog. A covered workflow may later suggest an
  improvement rather than a duplicate; implementation of improvement proposals belongs to `079`.
- `rejected` suppresses the same workflow until its canonical procedure materially changes or the user
  explicitly reopens it.
- `not_now` permits a later proposal only after additional distinct successes; use a deterministic
  cooldown/count policy, initially two more successes, to avoid repeated prompts.
- Infer a scope hint: global when portable or when it uses the active workspace generically; workspace
  when it depends on one repository's files, commands, conventions, configuration, or domain facts. If
  uncertain, hint global and carry the uncertainty into review.

## Verification

- Three matching executions across different conversations/projects/cwds create one eligible workflow.
- Same-turn subtasks, retries, resumes, duplicate completion events, and failed runs do not inflate it.
- Variable dates/topics match while materially different sources/procedures/output contracts do not.
- A repository-specific procedure retains a workspace dependency without using workspace as the global
  match partition.
- Auto memory off has no effect; Skill suggestions off prevents new records.
- Rejection and Not now enforce their distinct suppression policies.
- Classifier errors, malformed JSON, restarts, and concurrent completions are idempotent and non-blocking.
- Migration/repository/service tests, `pnpm typecheck`, and `pnpm build` pass.

## Out of scope

- Generating skill prose, writing `SKILL.md`, proposal-review UI, or retroactively mining all historical
  conversations on first launch.

