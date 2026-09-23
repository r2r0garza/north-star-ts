# PR94: Context history tail query

> Status: **DONE** (2026-09-21). Context construction now pushes a rolling summary's sequence boundary into SQLite while preserving intentional full-history replay when no summary exists.

## Goal

Keep context construction proportional to the unsummarized tail once a summary exists, without changing the intentional behavior of replaying the complete transcript when no summary exists.

## Current state

- `ContextBuilder.build()` calls `listMessages(conversationId)` and then filters `message.seq > historyAfterSeq` in JavaScript.
- `listMessages()` selects and maps every row, including JSON parsing `tool_calls` that the builder may immediately discard.
- `messages` already has `idx_messages_conversation_seq` on `(conversation_id, seq)`, so the desired range query needs no migration.
- Other callers rely on `listMessages()` returning the complete transcript and must remain unchanged.

## Analysis completed (2026-09-21)

### Confirmed call path and invariants

- `runAgentLoop()` gets `summary` from `summarySection(conversationId)` and passes `summary?.coversThrough` to `ContextBuilder.build()` (`src/main/agent/index.ts:1501-1507`, `src/main/agent/index.ts:1599-1609`). `summarySection()` returns `null` for an absent or blank summary, so the boundary is absent unless a usable persisted summary is selected as a context-section candidate.
- A nonblank summary declares that it replaces all messages through its inclusive `coversThrough` high-water mark (`src/main/agent/context/sections.ts:171-203`). The summary service produces that value from the last message's `seq` and incrementally treats only `seq > coversThrough` as fresh (`src/main/summaries/service.ts:77-89`, `src/main/summaries/service.ts:168-177`). The repository query must therefore use a strict `>` predicate, not `>=`.
- Section budgeting happens inside `ContextBuilder`: a selected summary can be dropped from the rendered system block while `historyAfterSeq` still excludes its covered messages. That is existing behavior because the caller already passes the boundary independently of section admission. This performance change must preserve that behavior; changing summary admission/boundary coupling requires a separate correctness decision.
- `repairDanglingToolCalls()` and the current user-message append run before `ContextBuilder.build()`, so any newly repaired/appended messages have sequence numbers above an existing summary boundary and remain in the queried tail (`src/main/agent/index.ts:1528-1609`).
- Production messages are allocated per conversation as `COALESCE(MAX(seq), 0) + 1` in one transaction (`src/main/db/repositories/messages.ts:60-102`). Therefore persisted normal messages are positive integers beginning with 1, and a real summary cursor is a nonnegative integer. The schema does not itself add a `seq > 0` check, so this is an application invariant rather than a database constraint.
- `listMessages()` is also used by renderer IPC, repair/recovery, summaries, task/process code, and tests. It must remain the full chronological-transcript API; only ContextBuilder’s summarized path should change.

### Boundary contract

`listMessagesAfterSeq(conversationId, afterSeq)` will be a low-level numeric range query with the exact SQL predicate `seq > afterSeq`; it will not silently clamp, round, or validate its input. This keeps its behavior direct and makes the repository reusable without concealing an invalid caller.

| `historyAfterSeq` value | ContextBuilder path | Resulting boundary behavior |
| --- | --- | --- |
| `undefined` (no usable summary) | `listMessages(conversationId)` | Replay the complete stored transcript. This intentionally removes the current redundant JavaScript `seq > 0` filter on the no-summary path. |
| `0` | `listMessagesAfterSeq(conversationId, 0)` | Return every normally persisted message (`seq` starts at 1). Do not use truthiness to choose the full-history path. |
| Negative finite number | `listMessagesAfterSeq(conversationId, value)` | Preserve strict numeric SQL semantics; all normally persisted messages are returned. This is not a valid generated summary cursor, but needs no special production recovery behavior. |
| Finite non-integer | `listMessagesAfterSeq(conversationId, value)` | Preserve strict numeric SQL semantics: for example, `1.5` returns sequence 2 onward. It is not a valid generated summary cursor. |
| `NaN` or infinities | Not a supported boundary | Do not add a new validation/clamping policy in this focused performance change. They cannot arise from the typed persisted `INTEGER` summary path; tests should document only supported finite numeric values. |

The ContextBuilder condition must be `opts.historyAfterSeq !== undefined`, not a truthiness check. The option’s TypeScript type is `number | undefined`, so `null` is not a supported API value.

### Index and migration decision

The existing `idx_messages_conversation_seq(conversation_id, seq)` exactly matches equality on the leading column, a range on `seq`, and `ORDER BY seq ASC` (`src/main/db/schema.ts:29-41`). SQLite can seek the conversation/range and emit that index order, so no schema/index migration is warranted. A local direct `better-sqlite3` query-plan probe could not run because the installed native module is built for Electron rather than the host Node ABI; that same limitation is already handled by the repository test helper (`src/main/test/sqlite.ts:3-16`). During implementation, run the SQLite-backed test suite in an ABI-compatible environment and, if needed, assert `EXPLAIN QUERY PLAN` reports use of `idx_messages_conversation_seq`; do not make a planner-string assertion a required cross-version unit test.

## Implementation plan

1. Add `listMessagesAfterSeq(conversationId: string, afterSeq: number): Message[]` beside `listMessages()` in `src/main/db/repositories/messages.ts`. Use a parameterized prepared statement:

   ```sql
   SELECT *
   FROM messages
   WHERE conversation_id = ? AND seq > ?
   ORDER BY seq ASC
   ```

   Cast the result to `MessageRow[]` and map only those returned rows through the existing `toMessage()`. Keep `listMessages()` unchanged so full-history callers retain both their result and JSON mapping behavior.

2. Update `ContextBuilder.build()` to select the repository function before mapping to chat messages:

   ```ts
   const history =
     opts.historyAfterSeq === undefined
       ? listMessages(conversationId)
       : listMessagesAfterSeq(conversationId, opts.historyAfterSeq)
   ```

   Remove the JavaScript `.filter()`. Do not move the summary lookup into ContextBuilder, change summary coverage, add an in-memory tail limit, or affect the summary service’s own full-history reads.

3. Extend the ContextBuilder mock so `listMessages` and `listMessagesAfterSeq` are independently observable (for example, hoisted `vi.fn()` mocks returning separate controllable arrays). Cover no boundary (only the full repository path is called with the conversation ID), `0` (only the bounded path is called with `conversationId, 0`, not a truthiness fallback), and a normal boundary (only the bounded path is called with the exact boundary and its returned tail is mapped in order). Do not keep pre-boundary rows in the bounded mock result and rely on ContextBuilder to filter them: after this change, enforcing the boundary is the repository’s responsibility. Clear both mocks and reset their return values in `beforeEach` so call assertions cannot leak between tests.

4. Add a dedicated SQLite-backed `src/main/db/repositories/messages.test.ts` (none exists currently). Follow the repository-test convention: mock `../connection`, create an in-memory database, enable foreign keys, run all migrations, create/insert the parent conversations required by the FK, use `sqliteLoadsForTests()` with `describe.skipIf(!sqliteLoads)`, and close the database after each executed test. Seed two conversations and deliberately insert target-conversation rows out of sequence order, including a valid `tool_calls` JSON value on an included row. Assert the bounded function returns only the target conversation’s rows with `seq > afterSeq`, sorted ascending, and correctly maps the included tool-call row. Use a boundary equal to a stored sequence to prove strict exclusion, and include an empty-result assertion for a boundary at/above the maximum. The fact that excluded malformed/expensive JSON is not parsed is guaranteed structurally by mapping only SQL-returned rows; no fragile JSON-parse spy is needed.

## Verification and acceptance

- At a normal summary boundary, context contains the same rendered system content as before plus precisely the repository-provided post-boundary messages in chronological order.
- A row with `seq === afterSeq` is excluded; rows above it are returned and mapped; another conversation’s rows never appear; a boundary at/above the maximum returns an empty tail.
- `historyAfterSeq: 0` takes the bounded path and returns all normally persisted messages; an absent boundary takes the full-history path and replays the complete transcript.
- Existing `listMessages()` callers, including renderer transcript reload, repair/recovery, summary generation, and task/process consumers, are untouched.
- No migration is added; the implementation relies on `idx_messages_conversation_seq`.
- Verification completed: the focused command passed 11 ContextBuilder tests and skipped the SQLite-backed repository test under the local native ABI mismatch; `pnpm typecheck` passed. `pnpm test:sqlite` could not start its SQLite suites because the installed `better-sqlite3` binary targets Electron ABI 136 while Node requires ABI 147. An ordinary full-suite run reached 1,204 passing tests and failed only four unrelated CLI adapter tests whose `cli_probes` fixture files are absent.

## Likely files

- `src/main/db/repositories/messages.ts`
- `src/main/db/repositories/messages.test.ts` (new, SQLite-backed)
- `src/main/agent/context/context-builder.ts`
- `src/main/agent/context/context-builder.test.ts`

## Out of scope

- Changing when summaries are created or what they contain.
- Truncating unsummarized history.
- Optimizing unrelated complete-history consumers.
- Schema or index changes unless the analysis disproves the existing index assumption.
