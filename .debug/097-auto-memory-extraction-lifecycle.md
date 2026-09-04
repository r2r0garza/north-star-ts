---
status: OPEN
severity: P1
trigger: "Auto Memory writes a completed turn to reference/YYYY-MM-DD.md but can silently fail to create staging or categorized memory, and restart cannot recover the missed extraction"
created: 2026-09-03
updated: 2026-09-03
---

# Make Auto Memory extraction and promotion durable

## Reproduced symptoms

- A natural user statement describing a durable project lesson was present in
  `memory-recent/reference/2026-09-03.md`, proving that `recordMemoryTurn()` ran
  and Auto Memory was enabled.
- More than two minutes later, `memory-recent/staging.md` remained empty. The
  development terminal contained no memory success or failure diagnostic.
- An earlier explicit “keep this in mind” statement in a fresh workspace did
  produce four staging facts. A new conversation promoted them into both
  `memory-recent/SKILL.md` and `memory-knowledge/SKILL.md`.
- An older generated batch contained two `No durable facts` headings and the
  bullet `No durable facts were stated by the user.` The phrase `No` then
  appeared as a recent-memory keyword. This is compatible with the previous
  free-form extractor accepting a model-generated empty-result explanation as
  a fact.
- Closing the app after a final response can leave the raw reference append but
  interrupt the later extraction request. Restart only promotes existing
  staging; it does not recover the missed extraction from reference data.

## Confirmed implementation causes

1. `runAgentLoop()` launches `recordMemoryTurn()` with `void` after accepting the
   final response. Application shutdown is not coordinated with the background
   operation.
2. `appendSessionLog()` runs before `appendTurnSummary()`. A reference record is
   therefore not evidence that semantic extraction completed.
3. `memoryComplete()` returns `undefined` after provider failures, and candidate
   parsing/validation collapses malformed JSON, schema drift, an explicit empty
   result, and deterministic rejection into the same empty outcome. Only thrown
   failures are logged; normal empty/rejected paths have no diagnostic.
4. Startup reconciliation reads only the last staging file. Reference files are
   never reprocessed and have no processed cursor, so an interrupted extraction
   is permanently missed.
5. `performSwap()` empties staging before starting `classifyAndDistribute()` as
   an unawaited promise. Classification failure or shutdown can leave recent
   memory updated while categorized memory remains unchanged, with no retry.
6. Recent and categorized skill files are written directly rather than through
   an atomic materialization transaction. The recent scaffold/rewrite also omits
   the managed-file warning used by the other memory skills.

## Intended lifecycle

Treat extraction as durable background work rather than an in-process callback:

```text
completed turn
    -> persist extraction job and bounded evidence
    -> pending
    -> processing (expiring lease)
    -> accepted -> atomically upsert facts -> completed
       or rejected -> terminal, no facts
       or failed -> bounded retry/backoff -> failed terminal/dead letter
```

The durable job, not `reference/YYYY-MM-DD.md`, is the processing queue. Give
each job a stable identity derived from the conversation and terminal user-turn
message IDs. Enforce one job per turn. Give each accepted fact a stable source
identity or normalized fact hash so a crash after fact insertion but before job
completion cannot duplicate memory.

Use the existing durable task-runner infrastructure if it can express the
required workspace ownership, retry budget, cancellation, lease, and
idempotency semantics without exposing these internal maintenance jobs as
ordinary user tasks. Otherwise add a narrowly scoped memory-job repository.

Recommended states and evidence:

| State        | Meaning                                                  | Retry behavior                                       |
| ------------ | -------------------------------------------------------- | ---------------------------------------------------- |
| `pending`    | Evidence is durably captured and has not been claimed    | Claim on worker start or reconciliation              |
| `processing` | A worker owns an expiring lease                          | Reclaim only after lease expiry                      |
| `completed`  | Accepted facts and all skill materializations committed  | Never re-extract automatically                       |
| `rejected`   | Extraction succeeded but yielded no accepted facts       | Never re-extract automatically                       |
| `retry_wait` | A transient provider/format failure is recorded          | Retry with the same job identity and bounded backoff |
| `failed`     | Retry budget exhausted or deterministic failure occurred | User-visible diagnostics/manual retry only           |

## Atomic promotion contract

- Do not clear or acknowledge source facts until category classification and all
  authoritative fact writes succeed.
- Store accepted facts and their categories in a durable repository. Generate
  `memory-recent/SKILL.md`, `memory-knowledge/SKILL.md`, and
  `memory-lessons/SKILL.md` as replaceable views of that repository.
- Write generated files using temp-file, flush/close, and atomic rename semantics
  appropriate to the local filesystem. A failed materialization keeps the last
  valid skill and remains retryable.
- `memory-recent` is a recent accepted-fact view, not a second authority and not
  a raw transcript.
- Include the managed-file warning in every generated memory skill, including
  `memory-recent`.

## Reference-log boundary and retention

Reference logs are optional short-lived recall/audit data, not job state and not
an implicit retry source. Do not delete individual Markdown entries to mark them
processed; rewriting append-only daily files introduces races and corruption.

- Make reference retention independently configurable from durable memory.
- Apply a bounded age/size policy and remove whole expired daily files only when
  no live extraction job depends on their evidence.
- Keep job evidence structured and bounded. After a terminal result, discard raw
  job payloads when possible and retain only minimal provenance, hashes, result
  codes, and safe diagnostics.
- If raw references remain discoverable through `memory-recent`, label them as
  untrusted historical data and preserve the prompt-injection boundary.

## Diagnostics

Persist and log a bounded result for every job without storing arbitrary model
output:

- resolved account/model/API mode and attempt count;
- result code: accepted, genuine empty, malformed output, invalid schema,
  rejected provenance, rejected forbidden content, provider failure, or timeout;
- candidate counts before and after validation, grouped by rejection reason;
- elapsed time and bounded provider/request identifiers when available;
- materialization/classification status and last safe error.

Successful jobs need only concise debug-level logs. Terminal failures must be
inspectable after restart and surfaced in Settings without exposing raw prompts,
assistant reasoning, secrets, or unrestricted provider errors.

## Acceptance criteria

- [ ] A completed top-level turn creates one durable extraction job before the
      UI treats background memory persistence as settled.
- [ ] Closing immediately after the assistant response and reopening the app
      eventually produces the same accepted/rejected result as leaving it open.
- [ ] Empty, malformed, schema-invalid, filtered, and provider-failed extraction
      outcomes are distinguishable after restart.
- [ ] A genuine non-memory turn reaches terminal `rejected` and is never scanned
      or charged again.
- [ ] A transient failure retries within a bounded budget without duplicate
      facts, reference entries, or skill bullets.
- [ ] A crash at every boundary between claim, extraction, fact insertion,
      classification, materialization, and completion recovers idempotently.
- [ ] Category failure cannot erase staging/source facts or leave a job falsely
      completed.
- [ ] Reference retention never deletes evidence required by a pending or leased
      job and never uses entry deletion as a processing marker.
- [ ] All generated memory skills contain the managed-file warning and remain
      parseable after injected write failures.
- [ ] Tests use a deterministic fake extractor plus provider/format fault
      injection; required SQLite suites cannot silently skip.

## Likely files

- `src/main/agent/index.ts`
- `src/main/agent/memory/service.ts`
- `src/main/agent/memory/service.test.ts`
- `src/main/tasks/runner.ts` and task registration in `src/main/index.ts`, if
  reusing the durable runner
- `src/main/db/schema.ts`, migrations, types, and a focused memory repository
- Settings IPC/renderer surfaces for diagnostics and retention controls

## Related work

- [098](./098-auto-memory-conversational-provenance.md) defines which structured
  conversation evidence may establish a memory.
- `.plan/077-prompt-injection-persistence-and-action-integrity.md` defines the
  existing persistence security boundary but is not sufficient for lifecycle
  durability and multi-turn ratification.
