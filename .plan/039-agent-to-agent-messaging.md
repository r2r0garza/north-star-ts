# PR39: Inspectable agent-to-agent messaging — a cross-phase question/answer channel

> Status: **NOT STARTED**. ⚠️ **DESIGN-PENDING**. Lets one running phase-agent **ask another
> phase-agent a question** and get a **context-grounded answer** — the question is delivered **into the
> answerer's own worker conversation** (so it answers from *its* context), and the answer is delivered
> **back into the asker's conversation together with the original question** (so the asker has the full
> Q+A on record). Every exchange is a **durable, inspectable** record surfaced in the `026` monitor.
> Distinct from `038` (nested execution) and from `spawn_subagent` (a fresh, context-less child).

## Why this is different from what exists

`spawn_subagent` (today) delegates to a **fresh** child that **cannot see any conversation** — you
hand it a self-contained prompt and it starts blank. This feature is the opposite: agent B wants to
consult agent **A as A already is** — A has run its phase, has a worker conversation full of context,
and should answer **from that context**. So we don't spawn a new A; we **send a message into A's
existing worker conversation** and let A's own `runAgentLoop` answer, then thread the result back to B.

The `025` engine makes this addressable: each phase-run has its **own worker conversation + task**
(`service.ts` `makeRunPhase`: `createConversation` + a `process_phase` `createTask`, `taskId` stamped
on the phase-run). So "A's conversation" and "B's conversation" are real, durable, per-phase-run ids —
we can inject a turn into either.

## Goal

1. A phase-agent (B) can **ask a named other phase's agent (A) a question** via a gated
   **`ask_agent`**-style tool, naming A by phase key / agent (bounded to phases in the same run — see
   Open questions).
2. The question is delivered **into A's worker conversation** as a new turn; A's `runAgentLoop` answers
   **using A's accumulated context**; the answer returns to B.
3. **Both sides keep the record:** B's conversation gets a durable turn = **{ question B asked, A's
   answer }**; A's conversation gets the durable turn = **{ question received from B, A's answer }**.
   The exchange is a persisted, **inspectable** artifact (its own rows + a `process_phase`-style event),
   rendered in the `026` monitor as an A↔B message thread.

## Likely shape (hypothesis — revisit per Open questions)

### A. Storage (additive, `SCHEMA_V20+`)
- `process_messages` (id, `run_id` FK, `from_phase_run_id`, `to_phase_run_id`, `question`, `answer`
  NULL-until-answered, `status` bare-TEXT `pending|answered|failed|declined`, created/answered_at). The
  durable, inspectable log — one row per exchange, queryable by run for the monitor. (The actual
  turns also land in each side's message history; this table is the **index/audit** over them.)

### B. The channel (engine — `service.ts` + a small `messaging.ts`)
- A gated **`ask_agent`** tool available to a phase worker (injected via `ToolContext`, like
  `spawnSubagent`/`enqueueTask`). Args: `target` (phase key or agent name, resolved to A's live
  phase-run within the same run) + `question`.
- On call: write a `process_messages` row (`pending`), then **deliver the question into A's worker
  conversation** and run **A's `runAgentLoop` for one turn** on A's `conversationId` (A answers from its
  own history — this is the crux: reuse A's conversation, do **not** fork a blank child). Capture A's
  final message as the **answer**, mark the row `answered`.
- **Return to B, with context on both sides:**
  - B's tool result = a block containing **the question + A's answer** (so B's own transcript records
    what it asked and what came back — the tool result *is* the durable turn in B's conversation).
  - A's conversation now durably contains the **incoming question turn + A's answer turn** (from having
    actually run the turn there) — so A "remembers" it was asked.
- **Synchronous + bounded:** the exchange runs inline (the `spawnSubagent` precedent — no re-enqueue),
  and is bounded by a **per-run message cap** + a **no-cycle / depth guard** (A asking B asking A … must
  terminate — reuse the `MAX_AGENT_DEPTH`-style counter; a bound is mandatory, per `031`'s rule).

### C. Concurrency + lifecycle correctness (the hard part)
- **A may be running, done, or not-yet-run.** If A's phase-run is `completed`, its conversation still
  exists → inject + answer. If A is **still running**, asking it mid-flight is racy — v1 likely
  **only allows asking a phase that has completed** (its context is settled), and errors otherwise
  (documented limitation). If A **hasn't run**, error (can't consult an agent with no context yet).
- **Reentrancy:** running A's loop from inside B's tool call nests loops — bound by the depth guard and
  a per-run in-flight set so the same pair can't recurse without limit.
- **Cancellation:** a run-level cancel must unwind an in-flight A-answer turn (chain the child
  controller, as `makeRunPhase` already does).

### D. Monitor (`process-screen.tsx`)
- Render `process_messages` for the selected run as an **A↔B thread** (who asked whom, the question,
  the answer, status), nested/attached to the phases involved. Rides a new `process_phase`-style event
  (or a dedicated event) on the run's task tail (the `026` no-new-channel pattern — filter `task:event`).

## Open questions to resolve BEFORE building
1. **Ask a *running* agent?** v1 restrict to **completed** target phases (settled context, no mid-flight
   race) vs allow asking a running agent (queue the question until its current turn yields). Lean
   **completed-only in v1**, with a clear error otherwise; live-ask is a follow-up.
2. **Targeting scope.** Only phases **within the same run** (addressable, bounded) vs any agent
   anywhere. Lean **same-run phases only** (a process is the trust/visibility boundary); the tool lists
   askable phases (those completed) in B's prompt.
3. **Does A's answer turn persist in A's history (mutating A)?** Yes — that's the whole point (A answers
   from and appends to its context). But it means a later re-run/resume of A sees the injected Q/A. Lean
   **persist it** (it's real context) but tag the turn as an inter-agent exchange so resume/aggregation
   can treat it distinctly if needed.
4. **Bounds.** Per-run message cap + reentrancy/cycle depth guard values. Mandatory (no cycle guard in
   the DAG). Lean a small cap + a depth counter mirroring `MAX_AGENT_DEPTH`.
5. **Gate policy.** Is `ask_agent` auto-allowed (like `spawn_subagent`, since both agents are in the
   same authored process) or gated? Lean **auto-allowed within a run** (the process author composed the
   phases); the side-effecting tools A runs to answer still hit A's own gate.
6. **Split on build:** `039.1` completed-target Q→A→B round-trip + storage + monitor thread; `039.2`
   asking a running agent (queued) + richer targeting.

## Verification (when built)
- **Unit:** `ask_agent` writes a `pending` row, injects the question into A's conversation, runs one A
   turn, captures the answer, marks `answered`, and returns **Q+A** to B; B's transcript ends with the
   Q+A turn and A's transcript contains the incoming-question + answer turns; asking a not-yet-run or
   (v1) running phase errors; the per-run cap + depth guard stop an A↔B loop; a cancel unwinds an
   in-flight answer.
- **Manual (real app):** build a run where phase B (e.g. "Integrate") can ask phase A ("API design");
  run it; watch B call `ask_agent`, see A answer from its own context, and confirm the monitor shows
  the A↔B thread and both transcripts carry the exchange.
- `pnpm typecheck` + `pnpm build` clean; verified in the running app.

## Out of scope
- **Sub-processes / nested runs** — `038` (nested *execution*, not a Q/A channel).
- **Fresh context-less delegation** — that's `spawn_subagent` (already exists).
- **Broadcast / group threads** (one agent asking many at once) — later; v1 is a directed A→B pair.
- **Cross-run or cross-conversation messaging** (asking an agent outside this run) — later.
- **Asking a still-running agent** (queued mid-flight delivery) — likely `039.2`.
