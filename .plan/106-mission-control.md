# PR106: Mission Control — seated agent teams driving a project → mission → slice map

> Status: **PLANNED (umbrella)**. This file sets the vocabulary, architecture, and delivery split for the
> Processes revamp. Implementation happens in the `106.x` slice plans. Mission Control is built **next to**
> Processes; the Processes sidebar button is hidden only in `106.9`, after parity. The Process engine
> itself stays: it becomes the execution substrate for slice playbooks.
>
> Supersedes `070` (Pods seed) and `039` (inspectable Process consultations). Inspired by OpenRig (see
> `yt-transcript/youtube-transcript-AL-PQuB2wy0.md`).

## Why revamp

Processes answer one question well: "run this authored graph of phases once for this objective." They do
not answer the questions that matter when agents work for days:

- **Who is on the team, permanently?** A Process phase binds an agent name for one run. Nothing persists
  between runs: no stable address, no accumulated lessons, no standing role.
- **Where are we in the larger plan?** A Process run knows its own DAG. It doesn't know which release it
  belongs to, what came before it, or what comes next.
- **What are the agents saying to each other?** Consultation (`039`) was a narrow read-only, same-run
  primitive. Real teams need addressable messaging that the user can watch.
- **Is the team making progress or just making process?** Nothing measures coordination overhead
  (checks, handoffs, proof polishing) against actual forward movement.

Mission Control splits the problem along two axes the user described:

1. **Topology (who):** Seat → Pod → Rig.
2. **Work (what and how):** Slice → Mission → Initiative, each with a playbook at its altitude.

A **Navigator** connects them, like GPS for a self-driving car. It tracks where we are on the map and
tells the orchestrating seat where to go next. The agent still makes the decisions and can adapt the
plan, but it no longer has to hold the whole sequence in its head.

## Naming

The feature needs a name that doesn't collide with **Projects** (sidebar conversation groups) or
**Processes**.

**Recommendation: "Mission Control"** is the sidebar surface. It fits North Star's navigation theme,
reuses the word *mission* the user already chose for the middle altitude, and says what the screen is
for: steering and observing autonomous work.

Working vocabulary for these plans (one glossary module, `src/shared/mission-control/glossary.ts`, so a
rename costs one file plus copy):

| Concept | Working name | User's words | Alternatives considered |
|---|---|---|---|
| Surface | **Mission Control** | "the new functionality" | Flight Deck, Command, Operations |
| Agent slot | **Seat** | seat | Station, Post |
| Team of seats | **Pod** | pod / team | Crew, Squad, Unit |
| Group of pods | **Rig** | rig / organization | Fleet, Outfit, Org |
| Top work altitude | **Initiative** | project | Campaign, Voyage, Program |
| Middle work altitude | **Mission** | mission | — |
| Leaf work unit | **Slice** | slice | — |
| "How" at each altitude | **Playbook** | sequence | Procedure, Route |
| Plan tracker | **Navigator** | GPS | Autopilot |

"Initiative" replaces "project" only to avoid colliding with the existing sidebar Projects. An Initiative
may optionally link to an existing Project (`106.2`) so the two concepts meet instead of competing.
Alternative topology set if "Rig" feels too borrowed: **Fleet → Crew → Seat** (the code already calls
custom agents "fleet" agents).

## Concept model

```text
TOPOLOGY (reusable, saved as templates)          WORK (per initiative, durable)
────────────────────────────────────────          ─────────────────────────────────
Rig  "software-factory"                           Initiative  "v1.0 of billing"   ← Initiative playbook
 ├─ culture.md                                     │  intent, definition of done,    (plan → missions → release)
 ├─ Pod "orchestration"  ─oversees─┐               │  rig, workspace, budgets
 │   └─ Seat lead@orchestration    │               ├─ Mission "M1: invoices"        ← Mission playbook
 └─ Pod "implementation"  ◄────────┘               │   │  outcome, merge policy,       (per-slice merge,
     ├─ Seat builder@implementation                │   │  integration branch            mission review)
     └─ Seat qa@implementation                     │   ├─ Slice "invoice model"      ← Slice playbook
                                                   │   │   spec, proof, deps, pod      (spec → build → test)
Seat = stable address + config + memory.           │   └─ Slice "invoice API" (depends on model)
An agent *sits in* a seat; it is not the seat.     └─ Mission "M2: payments" …
```

- **Seat.** A chair with an address (`builder@implementation`). It holds stable configuration: the agent
  definition sitting in it, role, charter, skill/tool/MCP narrowing, runtime (account/model), and seat
  memory. Lessons learned while sitting there are inherited by the next agent session in that seat.
- **Pod.** Seats that work closely together, with a *pod mission statement* (standing purpose, not a work
  item) and optional pod culture notes. Pods may **oversee** other pods: an orchestration pod oversees the
  implementation pod and receives its escalations.
- **Rig.** A group of pods, their oversight edges, and a rig-wide `culture.md` (how we work together). It
  is saved and reused as a portable template.
- **Slice.** The most granular unit of work: one specific change, with a **spec** (what we are trying to
  achieve and what must work when done) and a **proof** (whether we got there, with evidence). A slice
  runs through its **slice playbook**, the *how*: e.g. spec → build → test, each step bound to a seat
  role.
- **Mission.** An outcome plus the plan to reach it. It holds slices and their dependency graph, rendered
  as **waves**: slices with no mutual dependency fan out in parallel, dependent slices are sequenced. The
  **mission playbook** says what happens around and between slices. Merge management lives here.
- **Initiative.** The big picture: what we are building and why. It sequences missions, and its
  **initiative playbook** holds planning (turn intent into missions), release management, and "what's the
  next mission."

The same shape repeats at each altitude: *a container, its children, a playbook for what happens around
them*. That uniformity is deliberate; one execution substrate serves all three (below).

## Architectural decisions

### 1. Reuse the Process engine as the playbook runtime

A playbook step is a phase: an agent, or a deterministic command after `104`, with gates, validators,
rework, and completion contracts. Every playbook run is an **ordinary Process run** whose phases bind
**seat roles** instead of agent names. The seat binding is resolved and snapshotted when the run starts.
We get durable tasks, crash resume, approvals, validators, rework flag-back, runtime overrides, attempt
history, and transcripts for free, and we don't fork a second orchestrator (the principle from `070`).

Net-new engine surface is small: a role-bound phase-agent row, a seat-binding snapshot on the run, and an
explicit phase result (`039.1`'s result-integrity work, folded into `106.3`).

### 2. The Navigator is deterministic; judgment belongs to seats

The Navigator is a main-process service that computes the frontier purely from durable state: ready
slices, free pods, merge queue, budgets, next playbook hook. It never calls a model. It either
dispatches mechanical next steps itself (Autopilot) or delivers structured directions to the pod lead
seat, which makes judgment calls (assign, split, reprioritize, replan, escalate) through bounded,
audited tools. This is the "harness for the orchestrator": the orchestrator doesn't have to remember to
check the map.

### 3. Seats talk through addressable, durable, observable messages

Seat-to-seat messages go through a main-process message bus with server-resolved addresses. They persist
to SQLite and appear in the user's **Comms** feed. This replaces `039`'s same-run consultation: a
consultation is just a message to a seat whose session is idle. Messages carry information, never
authority. Approvals for side effects still go through the human approval engine, and seat decision
rights are enforced server-side (the "just following orders" failure mode).

### 4. Work isolation by git worktree, integration at the mission

Each running slice builds on its own branch and worktree off the mission's integration branch, reusing
`src/main/agent/subagents/worktrees.ts` and `repository-lease.ts`. Finished slices merge into the
integration branch through a serialized merge queue in dependency order. The mission merges back to the
base branch per the mission's merge policy. This is what makes parallel waves safe. Until `106.5` lands,
slices run one at a time in the initiative workspace.

### 5. Intent is a graph we can walk (Refocus)

Because slice → mission → initiative is a real graph, code can assemble the chain of intent at every
altitude and re-inject it after compaction, at an interval, or when drift is detected. The question is
always the same: "Is what you are doing right now aligned with the bigger picture?" This is the main
defense against doghouse-to-moonbase scope creep. Out-of-scope ideas go to a **proposal backlog** instead
of getting built.

### 6. Health is instrumented, not vibes

Every durable event is classified as **progress** (slice state advanced, proof accepted, merge landed) or
**ceremony** (messages, checks, proof edits, validator rounds, approvals requested). A rising ceremony
ratio with flat progress, proof edits after acceptance, message ping-pong, and stalls raise alerts. The
alert goes to the user and to a seat that has the context, never to a random agent.

### 7. Budgets and an external definition of done are mandatory

Every initiative carries hard limits: concurrent slices, attempts per slice, replans, messages per
thread, and wall clock (tokens and cost when provider accounting allows). The user owns each initiative's
**definition of done**. Agents can propose changes to it but cannot edit it, and they cannot certify
their own work alone: a slice proof needs a verifier other than the builder, or deterministic evidence.

### 8. Storage and process boundaries

All state lives in SQLite in `src/main/db` under new tables with real foreign keys. Services live under
`src/main/mission-control/`, IPC handlers in `src/main/ipc/mission-control-handlers.ts`, and a
`window.cowork.missionControl.*` preload surface. The renderer only goes through the preload, as
`AGENTS.md` requires. Model-supplied paths still go through `resolveInWorkspace`. Rigs and playbooks
export as versioned JSON documents, matching `037`'s `formatVersion` convention.

## Relationship to existing plans

| Plan | Relationship |
|---|---|
| `025`–`038`, `083`, `104`, `105` | Reused as the playbook execution substrate. `104` command phases are the natural "test" step. |
| `039` | **Superseded.** `039.1` (explicit phase results) is folded into `106.3`; `039.2` consultation is replaced by `106.4` Comms. |
| `070` | **Superseded.** Its thesis (mutable work graph, external done contract, budgets, independent evaluator) is kept and made concrete in `106.2`/`106.6`. The saved-roster concern is answered because pods persist *seats with memory*, not just a roster. |
| `069` | Stays independent. If it lands first, initiative/mission intake reuses its assumptions log; Mission Control doesn't block on it. |
| `085` | Rig and playbook templates (`106.1`, `106.3`) should share its catalog mechanism if it lands first. |
| `019`, memory service | Refocus hooks after summary compaction; seat memory extends the background memory service with a seat scope (`106.7`). |
| `067` | Worktree isolation in `106.5` covers most of the same risk for Mission Control runs; no dependency. |

## Delivery split

The slices are ordered so that each one ships something usable:

| Slice | Delivers | User-visible milestone |
|---|---|---|
| `106.1` | Rig / Pod / Seat model, addresses, templates, Mission Control shell + Rigs tab | Build and save a team |
| `106.2` | Initiative / Mission / Slice model, specs, dependency waves, map UI | Write a plan by hand and see waves |
| `106.3` | Playbooks at three altitudes on the Process engine, role binding, proof, explicit results | **MVP:** run a slice end-to-end with proof |
| `106.4` | Seat sessions, addressable messages, Comms feed | Watch agents talk |
| `106.5` | Worktree-per-slice, integration branch, merge queue, mission merge policy | Safe parallel slices |
| `106.6` | Navigator (Manual / Co-pilot / Autopilot), orchestrator tools, budgets, replan audit | Self-driving missions |
| `106.7` | Refocus intent chain, proposal backlog, seat memory with provenance and retraction | Long runs stay on-mission |
| `106.8` | Health: ceremony vs progress, loop and stall detectors, alerts, auto-pause | Know when to step in |
| `106.9` | Import Processes as playbooks, hide Processes button, parity checklist | Processes retired from the sidebar |

`106.3` is the first point where Mission Control does real work. Stop and evaluate there: if running a
slice through a seat-bound playbook isn't clearly better than running the same Process directly, fix
that before investing in autonomy (`106.6`).

## Principal risks (carried from `070`, plus new ones)

1. **Agent theater.** Seats with distinct names but identical context and tools just repeat each other.
   The Rigs tab warns when two seats in a pod have the same agent, the same narrowing, and no distinct
   charter.
2. **Bureaucracy accretion.** Checks that need checks. Mitigations: proof edits locked after acceptance,
   ceremony metrics, a validator-round cap, and a playbook step count warning.
3. **Moonbase scope creep.** Mitigations: Refocus, the proposal backlog, spec "out of scope" fields, and
   diff-footprint detectors.
4. **Self-certification.** The proof verifier must differ from the builder seat or be deterministic.
5. **Merge chaos.** Parallel slices on shared files. Mitigations: worktrees, a serialized merge queue,
   optional touch hints, and an integrator seat for conflicts.
6. **Mind-virus propagation.** Bad lessons spread through seat memory. Mitigations: provenance on every
   note, user review, retraction with contact tracing.
7. **Cost runaway.** Hard budgets, visible consumption, auto-pause.
8. **Product overlap during coexistence.** Until `106.9`, the Processes screen is labeled as the legacy
   path and Mission Control links to "import this Process as a playbook."

## Open questions (defaults chosen; revisit before the slice that needs them)

1. **Can the user speak inside agent threads?** Default: no. The user observes Comms and steers through
   an explicit *Steer* action that sends an operator message to a lead seat, clearly labeled as coming
   from the user. (`106.4`)
2. **Rig instance vs rig template.** Default: a Rig is a live, editable definition. Starting an
   initiative snapshots the rig (seats, agents, runtimes) so later edits don't mutate running work.
   Templates are export documents. (`106.1`/`106.2`)
3. **One initiative per rig at a time?** Default: a rig can drive multiple initiatives, but seat sessions
   are per (seat, initiative), so memory is shared and context isn't. (`106.4`)
4. **Parallel missions?** Default: missions run strictly in sequence in v1. Parallelism lives inside a
   mission as slice waves. (`106.2`)
5. **Where do spec/proof live?** Default: SQLite is the source of truth, with an optional read-only
   mirror to `.<system>/missions/…` in the workspace for agents that prefer files. (`106.2`)
6. **Remote PRs.** Default: mission merge policy offers local merge (with approval) and "open a PR" only
   through the existing git actions and explicit user consent. (`106.5`)
