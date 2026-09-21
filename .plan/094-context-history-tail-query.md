# PR94: Context history tail query

> Status: **PLANNED**. Stop loading and parsing messages already replaced by a rolling conversation summary by pushing the summary sequence boundary into SQLite.

## Goal

Keep context construction proportional to the unsummarized tail once a summary exists, without changing the intentional behavior of replaying the complete transcript when no summary exists.

## Current state

- `ContextBuilder.build()` calls `listMessages(conversationId)` and then filters `message.seq > historyAfterSeq` in JavaScript.
- `listMessages()` selects and maps every row, including JSON parsing `tool_calls` that the builder may immediately discard.
- `messages` already has `idx_messages_conversation_seq` on `(conversation_id, seq)`, so the desired range query needs no migration.
- Other callers rely on `listMessages()` returning the complete transcript and must remain unchanged.

## Required plan/analysis pass

Before implementation, re-read the context builder, message repository, summary call path, and current tests. Confirm the exact boundary semantics for missing, zero, negative, and non-integer sequence values; inspect the SQLite query plan if there is any doubt that the existing index serves the range and ordering. Record any changed decisions in this file before editing production code.

## Proposed direction

Add a narrowly named repository function such as `listMessagesAfterSeq(conversationId, seq)` using:

```sql
SELECT *
FROM messages
WHERE conversation_id = ? AND seq > ?
ORDER BY seq ASC
```

Have `ContextBuilder` call the bounded function when `historyAfterSeq` is present and the existing full-history function otherwise. Do not add an unrelated context-window limit or alter summary semantics.

## Verification and acceptance

- Context construction returns exactly the same messages and order at a summary boundary.
- Rows at or below the boundary are neither returned nor mapped by the bounded repository path.
- No-summary context construction still replays all stored messages.
- Existing full-history callers retain their behavior.
- Add repository coverage for the strict boundary/order and update the mocked context-builder tests to assert which repository path is used.
- Run focused context/repository tests, `pnpm typecheck`, and the ordinary test suite or the broadest locally available equivalent.

## Likely files

- `src/main/db/repositories/messages.ts`
- `src/main/agent/context/context-builder.ts`
- `src/main/agent/context/context-builder.test.ts`
- SQLite-backed message repository tests, if separate

## Out of scope

- Changing when summaries are created or what they contain.
- Truncating unsummarized history.
- Optimizing unrelated complete-history consumers.
- Schema or index changes unless the analysis disproves the existing index assumption.
