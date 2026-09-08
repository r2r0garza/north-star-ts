# PR70: Pods — autonomous agent teams with mutable work graphs

> Status: **DEFERRED SEED**. Pods are a promising product concept, not an approved implementation.
> Preserve the distinction from Processes while `069` (intake authority) and `039` (observable
> consultation) are built and validated. Activate this plan only when real objectives demonstrate that
> authored Process graphs are the limiting constraint.

## Thesis

A Pod is not a named collection of agents and not a loosely configured Process.

**A Process owns an authored execution graph. A Pod owns an objective and may create and revise the
work graph needed to satisfy an externally defined completion contract.**

If a proposed Pod only runs PO → BA → Dev → QA, it should be modeled as a Process. Pods earn a distinct
product surface only when they can create, split, assign, cancel, reprioritize, and revisit work based
on evidence discovered during the run.

## Motivating example

Objective:

> Create a spike for an agentic skills sharing platform where users submit skills, admins accept or
> reject them, and potential duplicates around an 85% similarity threshold are detected.

A Process can prescribe Discover → Prototype → Evaluate. A Pod should be able to decide that this
specific objective requires, for example:

- mapping the submission/moderation lifecycle;
- defining the skill package and trust boundary;
- challenging whether "85% similarity" is meaningful for the chosen model;
- building a representative positive/negative evaluation set;
- prototyping the thinnest useful workflow;
- adding a security review when supply-chain risk is discovered;
- revising or cancelling work when evidence changes the important uncertainties.

The definition of done belongs to the assignment, not to the agents judging themselves:

> Highest-risk assumptions have been identified and tested; the central workflow is demonstrated by a
> throwaway artifact; duplicate detection is evaluated against representative examples; unresolved
> risks are explicit; and a proceed/pivot/stop recommendation is supported by evidence.

## Product boundary

| Dimension | Process | Pod |
|---|---|---|
| Work structure | Authored graph | Mutable run-time graph |
| Primary reusable object | Execution recipe | Team + operating charter |
| Agent authority | Perform/reroute work inside phases | Decide what work is necessary within charter |
| Completion | Authored graph settles + defined checks | External definition of done is evidenced |
| Roles | Bound to phases | Persist across the objective |
| Unexpected findings | Rework known phases | Create/cancel/reprioritize work |
| Best fit | Repeatable procedures | Uncertain outcome-oriented work |

Processes and Pods should compose rather than compete:

- A Process phase may delegate an uncertain bounded objective to a Pod.
- A Pod may invoke an existing Process as a trusted playbook for repeatable work.

## Minimum credible Pod model

### Pod definition

- Name and operating charter.
- Coordinator agent.
- Roster of agents/capabilities; corporate titles are optional labels, not semantics.
- Decision rights: which member owns which kinds of calls.
- Allowed tools, workspaces, providers, and external systems.
- Default intake policy and escalation policy.
- Cost, time, iteration, concurrency, and delegation limits.

A role belongs in the roster only when it has distinct tools/knowledge, authority, artifact ownership,
or an adversarial evaluation responsibility. Otherwise PO/BA/PM-style separation risks expensive
agent theater.

### Pod run

- Objective and immutable input snapshot.
- Charter/authority snapshot.
- Externally defined definition of done.
- Mutable work-item graph with ownership, dependencies, priority, and status.
- Assumptions, decisions, artifacts, evidence, and unresolved risks.
- Inspectable Agent exchanges and coordinator replans.
- Budget/limit consumption and escalation state.

### Control loop

```text
assess objective/state
  → create or revise work items
  → assign bounded work
  → collect artifacts/evidence
  → evaluate definition of done
  → finish, replan, or escalate
```

The completion evaluator must be structurally independent from the agents whose work it judges, or use
deterministic evidence where available. "All agents agree" is not sufficient.

## Relationship to existing infrastructure

Reuse rather than fork:

- durable tasks, worker conversations, task events, approvals, pause/cancel/restart;
- agent definitions, capability policy, tools/skills/MCP restrictions, and workspace confinement;
- Process result integrity and observable consultation patterns from `039`;
- intake modes, input snapshots, authority language, and assumptions from `069`;
- artifact and transcript monitoring.

Net-new orchestration concepts are the durable mutable work board, coordinator replan loop, definition-
of-done evaluator, and charter/budget enforcement. Do not implement Pods as a second copy of the task or
agent runtime.

## Communication direction

Plan `039` remains a Process-scoped consultation implementation. Pods may later need richer policy on
top of similar primitives:

- active member-to-member delivery;
- asynchronous mailboxes;
- exchanges attached to work items, assumptions, or decisions;
- possibly group/broadcast threads;
- an observation-only user feed.

The user remains an observer of internal exchanges by default. Human intervention should use explicit
Pod controls/escalations, not participation in an agent group chat.

## Principal risks

1. **Infinite or performative work.** "Continue until done" without budgets and an external completion
   contract creates loops and token-burning meetings.
2. **Invented requirements.** An undercooked objective grants discovery latitude, not authority to turn
   guesses into irreversible product decisions.
3. **Role redundancy.** Multiple persona labels can repeat the same reasoning without adding evidence.
4. **Concurrent workspace conflicts.** Mutable work allocation needs ownership or isolated workspaces,
   stale-safe edits, and integration policy.
5. **Self-certification.** The same coordinator creating tasks and declaring success can stop too early
   or rationalize weak evidence.
6. **Unbounded replanning.** Every replan must consume a visible budget and preserve an audit trail.
7. **Product overlap.** If users cannot predict when to choose a Pod versus Process, the abstraction has
   failed regardless of implementation quality.

## Activation criteria

Promote this seed into implementation planning only when all are true:

- `069` has established objective intake, authority, assumptions, and completion-contract patterns.
- `039` has established explicit phase results and useful inspectable internal exchanges.
- At least three concrete objectives require work topology to change at runtime, not merely fan-out or
  rework inside an authored Process.
- A prototype proves a coordinator can maintain a durable work board under hard budgets and recover
  after interruption.
- User testing can distinguish "use a Process" from "use a Pod" from examples without explanation.

## Recommended validation spike before implementation

Build the smallest experiment using the existing agent/subagent runtime, not a new product surface:

1. One coordinator with a fixed specialist roster.
2. One objective and explicit definition of done.
3. A durable but minimal work-item ledger.
4. At most one replan cycle and a small concurrency/budget cap.
5. Read-only observation of assignments, exchanges, assumptions, and evidence.
6. Compare the result against the best equivalent fan-out/rework Process.

The spike succeeds only if the dynamic graph produces materially better handling of discovered unknowns
than the Process without unacceptable cost, thrash, or user confusion.

## Open questions for later exploration

1. Does the Pod infer its initial charter or propose one for approval? Likely risk-sensitive: bounded
   read-only spikes may start and display assumptions; expensive/mutating objectives require approval.
2. Is the coordinator a persistent agent conversation or a deterministic scheduler plus bounded model
   decisions? Prefer the smallest model-owned surface that still permits genuine replanning.
3. How are concurrent edits isolated and integrated?
4. Can a Pod alter its roster during a run, or only choose among chartered members?
5. What evidence envelope makes definitions of done machine-checkable without pretending every outcome
   is deterministic?

## Explicitly not authorized by this seed

- New Pod database tables or UI navigation.
- A second task runner or agent execution stack.
- Open-ended autonomous operation without budgets.
- User-participatory agent chat.
- Treating a saved roster as sufficient proof that Pods deserve a separate abstraction.
