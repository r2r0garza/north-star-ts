# PR69: Process intake policies and inspectable assumptions

> Status: **NOT STARTED**. Add an explicit run-entry contract so a Process can either begin
> autonomously, pause once for plan approval, or require complete inputs. This is orchestration
> preflight, not a hardcoded first phase in every Process.

## Problem

Processes currently start driving their authored graph regardless of whether the objective is precise,
undercooked, or missing consequential information. That behavior is useful for ambiguity-tolerant work
such as brainstorming and spikes, but unsafe or frustrating for work such as production deployment.

Adding a mandatory Planning/Analysis phase to every Process would merely reverse the rigidity: even a
fully specified objective would pay for a planning turn and a likely interruption. The Process author
instead needs to declare the expected interaction contract at intake.

## Product model

Every Process definition has one of three intake modes. User-facing labels are intentionally about the
interaction the runner will exhibit:

### 1. Proceed with assumptions (default)

- Start the authored graph immediately.
- Agents may make reasonable, reversible assumptions within the objective and record them.
- Interrupt the user only when the missing answer would materially change the result **and** choosing
  on the user's behalf would exceed the authority granted by the objective.
- Appropriate for spikes, research, review, brainstorming, and exploratory implementation.

### 2. Approve initial plan

- Before substantive phase execution, generate a short execution brief from the objective, Process
  definition, and intake guidance.
- Show interpreted scope, planned use of the existing graph, consequential assumptions, expected
  artifacts, and definition of done.
- Pause on one durable approval gate. The user may approve or request revisions.
- After approval, phases may still interrupt only under the same materiality/authority rule.

This is a run-level preflight artifact, not an injected graph phase: it has no user-authored edges,
does not masquerade as domain work, and does not alter the reusable Process topology.

### 3. Strict input contract

- The Process definition declares required inputs in addition to the objective.
- The New Run experience collects and validates them before enqueueing execution.
- Missing or invalid required inputs prevent the run from starting and explain what is needed.
- Semantic clarification may occur only for contract questions that cannot be expressed through
  deterministic fields; it is resolved before phase dispatch.
- Appropriate for deployments, migrations, destructive operations, compliance workflows, and other
  work where guessing would be unacceptable.

## Shared interruption rule

Uncertainty alone is not a reason to interrupt. A Process asks the user only when:

1. the answer would materially change scope, safety, cost, external effects, or acceptance; and
2. no declared default or reversible assumption resolves it; and
3. choosing would exceed the authority granted by the objective/Process definition.

Examples:

- A spike choosing several embedding models to compare: proceed and record the choice.
- Publishing a prototype publicly using a paid account: interrupt.
- A code review choosing an inspection order: proceed.
- A production deploy missing the target environment: strict contract blocks startup.

## Definition-time contract

Add intake configuration to `ProcessDefinition`, likely:

```ts
type ProcessIntakeMode = "assume" | "approve_plan" | "strict"

interface ProcessIntakeConfig {
  mode: ProcessIntakeMode
  guidance: string | null
  definitionOfDone: string | null
  requiredInputs: ProcessInputField[]
}
```

`guidance` tells the preflight/phase agents what may be assumed and what must be surfaced. It is not a
replacement system prompt and must remain bounded.

`requiredInputs` should begin with a small schema rather than arbitrary JSON Schema unless a concrete
need proves otherwise:

```ts
interface ProcessInputField {
  key: string
  label: string
  description: string | null
  kind: "text" | "multiline" | "boolean" | "choice"
  required: boolean
  defaultValue?: unknown
  options?: string[]
}
```

The objective remains required for all modes. Input values are snapshotted on the run so later edits to
the definition cannot rewrite run history.

## Inspectable assumptions log

Assumptions are run data, not prose hidden in a worker's final message. Add a durable log, likely:

```text
process_assumptions (
  id,
  run_id,
  phase_run_id NULL,
  statement,
  rationale NULL,
  confidence,          -- low | medium | high
  impact,              -- low | medium | high
  status,              -- active | challenged | resolved | superseded
  resolution NULL,
  created_at,
  updated_at
)
```

Provide Process-worker tools to record and update an assumption. Main derives `run_id` and
`phase_run_id` from `ToolContext`; the model cannot write into another run. Duplicate submissions should
be normalized/deduplicated conservatively or displayed as related entries, never silently merged by an
LLM call.

The run monitor shows an **Assumptions** section with origin, confidence, impact, status, and resolution.
Plan 039 consultations may later link to an assumption they challenge or resolve.

## Runtime behavior

### Assume mode

- Enqueue normally.
- Inject the intake guidance, definition of done, provided inputs, and interruption rule into every
  phase kickoff through the shared Process prompt builder.
- Offer assumption tools to Process workers.
- Human questions pause the durable Process run and resume the same worker after answers arrive.

### Approve-plan mode

- Create the run and backing task, then execute one bounded preflight inference that produces a
  structured execution brief; it may not use side-effecting tools.
- Persist the brief as run data and raise a durable preflight approval.
- Approval begins normal phase scheduling. Request-changes supplies feedback and regenerates the brief
  with a bounded revision count. Denial/cancel leaves an inspectable non-running run.
- Crash/restart must restore the same pending brief/gate rather than generate a second one.

### Strict mode

- Validate required fields in main before task enqueue; renderer validation is convenience only.
- If all deterministic fields are present, create the immutable input snapshot and start.
- Any optional semantic intake exchange occurs before phase dispatch and is durably replayable.
- A definition with no required fields is valid but should warn the author that strict mode adds no
  deterministic protection.

## Renderer

### Process builder

- Intake mode selector with concise behavioral descriptions.
- Bounded intake guidance and definition-of-done editors.
- Required-input field builder for strict mode.
- Preview of what the New Run form will request.

### New Run

- Always collect objective/workspace as today.
- Render definition-specified fields and defaults.
- State the selected interaction policy before Start.
- For approve-plan, make clear that starting creates a brief and then pauses for approval.

### Run monitor

- Intake brief/gate card for approve-plan runs.
- Assumptions panel for all modes.
- Clearly distinguish a human clarification request from an internal Agent exchange (`039`).

## Delivery split

### 069.1 — Definition contract and strict deterministic intake

- Schema/repository/IPC types and builder controls.
- Run input snapshot.
- New Run form and main-side validation.
- Backward compatibility: existing Processes migrate to `assume` with no required fields.

### 069.2 — Assumptions and interruption/resume

- Assumptions storage/tools/monitor.
- Shared kickoff policy.
- Durable Process-worker question routing and resume semantics.

### 069.3 — Approve initial plan

- Side-effect-free preflight inference and structured brief.
- Approval/request-revision lifecycle, bounds, crash recovery, and monitor UI.

## Verification

- Existing Process definitions behave as `assume` after migration and still start normally.
- Strict mode cannot be bypassed through direct IPC and snapshots inputs on the run.
- Assume mode does not add a mandatory planning call or gate.
- Approve-plan creates exactly one durable brief/gate and dispatches no phases before approval.
- Revision feedback regenerates a bounded brief; restart does not duplicate it.
- Workers receive intake guidance, definition of done, input snapshot, and the interruption rule.
- Assumptions remain scoped, inspectable, status-changeable, and durable across restart.
- Human questions pause/resume the correct Process worker; unrelated runs cannot answer them.
- The monitor visually distinguishes intake, assumptions, human questions, and Agent exchanges.
- Focused migrations/repository/service/renderer tests, `pnpm typecheck`, and `pnpm build` pass.

## Open questions before implementation

1. Does approve-plan allow editing the generated brief directly, or only approve/request-revision?
   Lean request-revision in v1 so the persisted artifact always matches what the model will receive.
2. Which field kinds are truly required for strict v1? Lean the four small kinds above; no file picker,
   secret field, conditional schema, or nested object until demanded by a real Process.
3. Should assumptions be editable by the user or observation-only initially? Lean user may resolve or
   supersede, but not rewrite the historical statement an agent recorded.
4. Exact durable question-answer mechanism for a phase worker. Reuse the existing renderer-backed
   `ask_user_question` semantics where possible, but anchor it to the Process run/task and monitor.

## Out of scope

- A mandatory Planning/Analysis phase.
- Dynamic mutation of the authored Process graph.
- Agent-to-agent consultation (`039`).
- General Pod autonomy or mutable work boards (`070`).
- Arbitrary JSON Schema, conditional forms, secret management, or external approval systems in v1.
