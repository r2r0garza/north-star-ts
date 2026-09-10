# PR87: Request-scoped skill opportunities and opt-in drafting

> Status: **PLANNED**. Supersedes `078` and `079`. Builds on shipped `077`'s inert-draft and
> approved-installation boundary plus shipped `028`'s guarded skill-authoring path. This replaces the
> three-execution repetition threshold with a request-scoped opportunity signal, verified against the
> completed run before the user is invited to create a draft.

## Product decision

North Star should recognize when a user has successfully demonstrated a reusable procedure without
waiting for the same workflow to be completed three times. Detection is advisory and drafting is opt-in:

1. Classify a meaningful root request as a possible skill opportunity.
2. Run the user's task normally; detection never delays or changes the agentic result.
3. After successful completion, validate the opportunity against bounded evidence from what actually
   happened.
4. Show a non-blocking suggestion: **This workflow could be reusable. Draft a skill?**
5. Generate an inert draft only when the user chooses **Draft skill**.
6. Let the user approve, request changes, dismiss, or reject the reviewed draft. Only approval installs
   it into an active skill source.

The entire automatic path is governed by a user-controlled **Suggest skills from completed work** setting
under Settings → Skills. When disabled, North Star must not classify requests for skill opportunities,
validate completed workflows, persist new opportunity records, or show automatic skill recommendations.
Manual skill creation and an explicit user request to turn something into a skill remain available.

The initial request can reveal intent, but the completed run reveals the usable procedure, including
tools, decisions, corrections, output shape, and workspace dependencies. Neither signal is sufficient
alone: intake detection avoids analyzing every transcript indiscriminately, while completion validation
prevents generic drafts based only on what the user hoped would happen.

## Opportunity versus other reusable knowledge

The detector must distinguish:

- **Repeatable workflow** — a stable trigger, ordered procedure, variable inputs, and recognizable output
  contract. This is a skill opportunity.
- **Reusable preference** — for example, a standing formatting or tone preference. This belongs in user
  or workspace memory, not a generated workflow skill.
- **One-off complex task** — many steps do not make a procedure reusable. This is not a skill opportunity.
- **Scheduled recurrence** — timing may justify an Automation, but recurrence alone does not justify a
  skill. A task may eventually be both, but each requires its own explicit user action.
- **Process template** — a reusable multi-agent DAG belongs to `085`, not this feature, unless the saved
  artifact is genuinely a skill rather than a Process definition.

Optimize for usefulness rather than theoretical repeatability. A candidate should have a clear future
trigger and save meaningful instruction, judgment, or tool-selection effort. Simple requests, generic
software work, greetings, acknowledgements, and cosmetic follow-ups should not produce suggestions.

## Intake detection and call budget

Do not add an unconditional third model call for every message.

Check the automatic-suggestion setting before constructing or dispatching any detector input. When the
setting is off, preserve ordinary title generation with its title-only prompt and do not send the user's
request through skill-opportunity classification as a hidden side effect of generating that title.

### First message

Refactor `generateTitle` into a compatible conversation-metadata service that asks the existing cheap
title model for strict structured output:

```ts
interface ConversationMetadata {
  title: string
  skillOpportunity: SkillOpportunitySignal
}

interface SkillOpportunitySignal {
  candidate: boolean
  confidence: number
  kind: "repeatable_workflow" | "preference" | "one_off" | "unclear"
  workflowSignature: string | null
  reason: string
}
```

Keep `generateTitle(...)` as a wrapper or migrate its callers atomically so Process-run titles and other
consumers do not break. Parsing must be strict and bounded; malformed opportunity fields fall back to
`candidate: false` while title generation retains its current deterministic fallback. The metadata call
remains cosmetic, asynchronous, and unable to block task execution.

### Later messages

Do not classify every conversational utterance. Apply deterministic intake guards first and skip obvious
acknowledgements, approvals, greetings, short corrections, and other messages that cannot define a
standalone reusable workflow. A later root message that introduces a materially new objective may use the
same constrained detector without regenerating the conversation title.

Persist the signal against the root turn or task, not merely the conversation, so later follow-ups cannot
silently replace the evidence for an earlier opportunity. Nested agents, retries, resumptions, and Process
subtasks are not independent user requests and do not create intake candidates.

## Completion validation

Run validation asynchronously only for an intake candidate after the root result is durably committed as
successful. Application state—not the model—decides whether the run succeeded and whether a completion
event is distinct.

Give a constrained, no-tools model call:

- the direct user request and any direct user corrections relevant to this root run;
- the intake signal;
- bounded structured execution evidence such as tool names/categories, ordered high-level actions,
  produced artifact types, and the final output contract;
- workspace/project provenance and dependencies; and
- existing candidate and installed-skill summaries needed for duplicate detection.

Do not provide raw tool payloads, secrets, complete transcripts, or untrusted content as executable
instructions. Preserve `076`/`077` trust labels and require every extracted procedure element to map back
to supplied evidence. Completion validation returns a normalized procedure, variable inputs, portability
assessment, confidence, and a stable coarse signature. Low-confidence or weak-value results are discarded
silently.

Failure, timeout, malformed JSON, app restart, or provider unavailability must never affect the completed
user task. A retry is idempotent for the same root source ID.

## Candidate storage and deduplication

Persist bounded candidate records rather than a global history of all successful executions:

```ts
interface SkillOpportunity {
  id: string
  sourceKind: "conversation_turn" | "task" | "process_run"
  sourceId: string
  conversationId: string | null
  workspaceId: string | null
  requestSummary: string
  workflowSignature: string
  normalizedProcedure: string[]
  variableInputs: string[]
  outputContract: string | null
  workspaceDependencies: string[]
  confidence: number
  reason: string
  status:
    | "suggested"
    | "dismissed"
    | "drafting"
    | "pending_review"
    | "approved"
    | "rejected"
  createdAt: number
  updatedAt: number
}
```

Use a unique `(source_kind, source_id)` constraint for completion idempotency. Before surfacing a
suggestion, compare the coarse signature with pending candidates, rejected signatures, and the resolved
skill catalog. Use a bounded semantic comparison only for plausible collisions. Do not suggest a duplicate
of an installed or pending skill; a possible improvement to an installed skill may be deferred until the
create-new flow is proven.

`dismissed` means **Not now** and suppresses the current candidate. `rejected` suppresses materially
equivalent signatures until the user explicitly reopens them or the normalized procedure changes. This
plan does not count executions or maintain `078`'s global three-success clusters.

## Suggestion and review UX

After the task's real result is visible, show one non-blocking suggestion card. It must never obscure,
replace, or delay that result.

Primary suggestion actions:

- **Draft skill** — starts constrained draft generation.
- **Not now** — dismisses this candidate without generating content.
- **Don't suggest this workflow** — rejects materially equivalent candidates.

The candidate remains reachable from a Skills → Suggestions surface so a toast is not the only route back.
Do not claim that a skill exists at this stage.

After **Draft skill**, retain the useful review contract from superseded `079`:

- show the normalized trigger/procedure, evidence summary, rendered `SKILL.md`, warnings, and inferred
  destination;
- **Approve** installs the exact reviewed revision;
- **Request changes** accepts natural-language feedback and creates an immutable new revision with a
  readable diff;
- **Discard draft** rejects or dismisses it according to an explicit choice; and
- an optional raw-source editor may exist for advanced users but does not replace **Request changes**.

Draft generation is a constrained background completion with no tools, filesystem access, network access,
delegation, or installation capability. Its input is the validated opportunity record plus bounded trusted
evidence. Store revisions as inert database content or app-controlled files outside every path returned by
`skillSources()`.

## Scope and installation

Infer the proposed location from demonstrated dependencies:

- **Global** when the procedure is portable or refers generically to the active workspace.
- **Workspace** when it depends on a particular repository's paths, commands, conventions, configuration,
  or domain knowledge.
- **Global with an uncertainty warning** when evidence is inconclusive.

Show the recommendation and reason before approval, and let the user change it. Approval should be a
single review action labeled with the destination, such as **Save globally** or **Save to North Star
workspace**.

Reuse `077`'s protected persistent-instruction boundary and `028`'s guarded `skills:create`/
`skillScaffold` path. At approval time, re-resolve the writable destination, validate name/content/path,
reject collisions and stale revisions, and write atomically without overwrite. Mark the proposal approved
only after the filesystem write succeeds, then refresh the catalog and open the installed skill for
inspection.

## Settings and privacy

Add a single **Suggest skills from completed work** toggle under Settings → Skills, backed by a setting
such as `skillSuggestions.enabled`. It is independent from Automatic memory and defaults on with clear
first-use/settings copy:

> Detect potentially reusable workflows in meaningful requests and suggest a skill after successful
> completion. Drafts are created only when you ask.

The toggle controls both automatic workflow detection and automatic skill recommendations; do not leave a
hidden detector running when recommendations are disabled. Turning it off must:

- stop new intake classification and completion validation immediately;
- discard the result of an in-flight automatic classification instead of persisting or surfacing it;
- stop creation of new opportunity records and recommendation cards; and
- leave approved skills and existing user-requested drafts accessible and editable.

Turning it back on applies only to future meaningful requests. Do not retroactively scan messages or
completed runs from the disabled period. Provide a separate delete action for existing
pending/dismissed/rejected opportunity records rather than treating the toggle as destructive. Explicit
skill authoring through the Skills screen or a direct user request is never disabled by this setting.

Do not retain all successful-run summaries. Persist only validated opportunities, bounded evidence
references, draft revisions, and suppression state. Provide deletion for pending/dismissed/rejected
candidates. Never store credentials, raw attachment contents, complete transcripts, or raw tool payloads
in opportunity tables.

## Likely implementation seams

- Refactor `src/main/agent/title.ts` into title-compatible structured metadata generation.
- Call intake detection from the existing first-message title sites in `runChat`, `task:start`, and Process
  run creation; add guarded later-root detection at their shared request boundary.
- Add one idempotent `validateSkillOpportunityAfterCompletion(...)` seam beside the current successful
  root completion paths. Keep CLI-provider and internal-agent completion paths behaviorally aligned where
  equivalent evidence exists; do not claim parity when a provider cannot expose sufficient structure.
- Add schema/repository/service modules for opportunities and immutable draft revisions.
- Add narrow IPC/preload methods for listing, dismissing, rejecting, drafting, revising, and approving.
- Add a post-result suggestion card and a durable Skills → Suggestions review surface.

Exact module and migration names should follow the repository state at implementation time.

## Verification

- A reusable first request shares the existing title-model round trip and stores a turn-scoped intake
  candidate without delaying the agent run.
- Greetings, acknowledgements, preferences, one-off work, cosmetic follow-ups, nested agents, retries, and
  resumptions do not surface suggestions.
- A candidate whose run fails, is cancelled, or produces no reusable demonstrated procedure is discarded.
- Successful completion validation uses actual bounded execution evidence and surfaces one suggestion after
  the task result.
- Duplicate completion events, restarts, and concurrent callbacks create only one opportunity.
- Existing/pending/rejected equivalent skills suppress duplicates according to their state.
- **Not now** performs no draft generation or filesystem write.
- **Draft skill** creates one inert, versioned draft; it is absent from `skillSources()` and `read_skill`.
- Request changes produces a validated immutable revision and readable diff.
- Approval installs exactly the visible revision into the selected valid destination; collision, stale
  content, unavailable workspace, or validation failure leaves the draft pending with a clear error.
- Skill suggestions and Automatic memory can be enabled or disabled independently.
- With **Suggest skills from completed work** off, title generation still works but sends no detector
  schema/input, in-flight detector results are ignored, no opportunity state is written, and no
  recommendation appears. Re-enabling does not backfill the disabled interval or affect explicit skill
  authoring.
- Focused metadata, intake-guard, completion, repository, IPC, and renderer tests pass alongside
  `pnpm typecheck` and `pnpm build`.

## Out of scope

- Retrospectively mining conversation history; globally counting repeated workflows; silently generating
  drafts before user opt-in; silent activation; automatic publishing/sharing; marketplace submission;
  scheduling the workflow; automatically converting it into a Process; or automatically executing a newly
  installed skill.
