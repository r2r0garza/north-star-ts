# PR39: Inspectable Process consultations — observable agent exchanges

> Status: **NOT STARTED**. Design direction resolved; implementation details remain.
> A running phase-agent may consult a **completed phase-agent in the same Process run** and receive an
> answer grounded in that agent's settled context. The user can inspect the exchange but does not join
> or reply inside it. This is a bounded Process coordination primitive, not an agent chat room.

## Product decision

The UI should call these **Agent exchanges**. The execution model should call one exchange a
**consultation**.

The user is an observer:

- They can see who consulted whom, the question, the answer, timestamps, status, and any linked
  assumption or rework action.
- They cannot reply inside the exchange or become another participant.
- They intervene through existing Process controls: pause, cancel, approve, deny, request changes,
  confirm/dismiss rework, or restart.

This keeps consultation separate from Process intake (`069`), which governs when the Process asks the
**user** for information.

## Why this is different from what exists

`spawn_subagent` delegates a self-contained task to a fresh child with no access to the caller's
conversation. Consultation does the opposite: phase B asks phase A **as A already is**. A's worker
conversation contains the reasoning and evidence accumulated while A performed its phase.

The Process engine makes both sides addressable: every phase-run owns a worker task and conversation.
The consultation service uses those server-owned relationships; the model never supplies arbitrary
conversation IDs.

Normal upstream handoff still uses the phase's explicit result. Consultation is for a narrow ambiguity
that a digest/result did not settle, for example:

> Implementation → Architecture: "Should refresh tokens rotate on every use?"

## Non-negotiable invariants

### 1. A completed phase remains completed

Answering a consultation must not reopen the phase or permit new side effects. The answer turn runs
under an **answer-only capability profile**:

- A may use its persisted conversation context.
- Read-only evidence lookup may be allowed if it can be confined to the run workspace.
- File edits, shell execution, delegation, user questions, MCP side effects, browser interaction, and
  further consultation are unavailable in v1.
- If A discovers that its completed result is wrong, it says so and may return a structured
  `rework_recommended` disposition. It does not silently repair artifacts after completion.

### 2. Transcript tail is not phase output

Today downstream aggregation can derive a phase's output from its worker conversation. Appending a
consultation answer would make "latest assistant message" unsafe: the answer could accidentally replace
the official phase result.

PR39 must first make the settled result explicit on the phase-run, likely an additive
`result_content TEXT NULL` column (or a small versioned result table if implementation review shows it
is already needed):

- Capture `result_content` when a worker successfully completes.
- `collectUpstream` and run aggregation read the explicit result, never the transcript tail.
- Consultation appends conversation turns but cannot change `result_content`.
- An authorized rework execution may replace the result deliberately after the new attempt completes;
  the transcript remains the audit history of both attempts.

### 3. Addressing and scope are server-controlled

- The target must be a completed phase-run in the same Process run.
- The worker addresses it by stable phase key; main resolves the concrete phase-run/conversation.
- Not-yet-run, running, failed, cancelled, unrelated, and deleted phase-runs are not consultable.
- For fan-out, v1 should require an unambiguous concrete child or reject with a list of valid targets;
  never guess among siblings.

### 4. Consultation is bounded and non-recursive

- Synchronous request/answer in v1.
- Per-run exchange cap and per-question/input/output size caps.
- Only one answer turn is run for a consultation.
- The answer-only profile cannot call the consultation tool, eliminating A↔B↔A recursion in v1.
- Run cancellation unwinds an in-flight answer.

### 5. Process execution remains authoritative

Consultation does not create dependencies, mark phases complete, change the DAG, or automatically reset
work. A `rework_recommended` answer is inspectable evidence; applying rework goes through the existing
flag-back policy and approval behavior.

## Proposed implementation

### A. Durable storage

Prefer a Process-specific table with real foreign keys over a prematurely polymorphic "all future
orchestrators" table:

```sql
process_consultations (
  id,
  run_id,
  from_phase_run_id,
  to_phase_run_id,
  question,
  answer,
  disposition,       -- answered | rework_recommended | declined | failed
  linked_assumption_id NULL,
  status,            -- pending | answered | failed | declined
  created_at,
  answered_at
)
```

The service API can still use neutral `AgentExchange` vocabulary so a future Pod may reuse the service
contract without weakening Process relational integrity today. If `069` lands an assumptions table
first, use its actual key; otherwise keep the link out of the initial migration and add it later.

### B. Tool and service

Add a Process-worker-only tool, tentatively:

```text
consult_phase(target_phase_key, question, assumption_id?)
```

On call:

1. Resolve the caller from `ToolContext`; never trust caller/run IDs from model arguments.
2. Resolve a valid completed target in the same run.
3. Insert the pending consultation row.
4. Add a tagged incoming-consultation turn to A's existing conversation.
5. Run exactly one answer turn using A's system prompt/context plus the answer-only capability profile.
6. Persist A's answer, settle the consultation, and return the original question + answer to B's tool
   result so both transcripts remain intelligible.
7. Emit a durable run event so the monitor refreshes.

The tool is auto-allowed inside an authored Process run because it is read-only and tightly scoped.
The normal approval system still applies to Process controls, but the answer turn itself has no
side-effecting tools to approve.

### C. Monitor

Add a collapsed **Agent exchanges** feed to the selected run and small exchange markers on involved
phase cards. Expanding an item shows:

- requester and target phase/agent;
- question and answer;
- pending/answered/failed/declined status and timestamps;
- `rework_recommended` warning, if returned;
- linked assumption/rework action, when present.

The feed is read-only. No composer, unread state, typing indicators, reply action, or participant UI.
The existing worker transcript sheets continue to show the tagged turns on each side.

## Delivery split

### 039.1 — Result integrity prerequisite

- Persist explicit phase result content.
- Migrate downstream aggregation away from "latest assistant message."
- Cover normal, fan-out, validator, rework, nested Process, restart, and resume paths.

### 039.2 — Completed-phase consultation

- Storage/repository and Process-scoped tool.
- Answer-only execution profile.
- Same-run completed-target resolution and bounds.
- Durable events and read-only monitor feed.

### Later, only with demonstrated need

- Queueing a question to an agent that is still running.
- Broadcast/group exchanges.
- Rich asynchronous mailboxes.
- Pod collaboration semantics (`070`), which are not part of this plan.

## Verification

- A completed target answers from its existing conversation context.
- The answer turn has no mutation, execution, delegation, browser, MCP-side-effect, user-question, or
  recursive-consultation capabilities.
- Both transcripts contain a tagged and intelligible record; the consultation row matches them.
- Appending an answer does not change the target phase's explicit result or any downstream input.
- A rework recommendation does not mutate/reset work until the existing flag policy authorizes it.
- Invalid scope/status/ambiguous fan-out targets fail closed without leaking conversation IDs.
- Per-run and payload caps are enforced; cancel unwinds an in-flight answer.
- The monitor renders exchanges read-only and survives reload from durable state.
- `pnpm typecheck`, focused Process tests, and `pnpm build` pass.

## Out of scope

- User participation in an agent exchange.
- General cross-run/cross-conversation agent chat.
- New Process dependencies or dynamic graph editing.
- Fresh context-less delegation (`spawn_subagent` already owns that).
- Process intake and human clarification policy (`069`).
- Pod work boards, live collaboration, or group threads (`070`).
