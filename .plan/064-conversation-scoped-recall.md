# PR64: Conversation-scoped transcript recall tools

> Status: **DONE**. Implemented by `cdbae2e` with conversation-scoped FTS storage,
> current-conversation and tree recall tools, migrations/repository coverage, and
> capability registration.

## Context

North Star persists full messages and produces rolling summaries, but older original
turns may be compacted out of the active model context. Durable tasks and subagents also
use private worker conversations linked to the source conversation. Agents need a way
to recover exact prior statements without gaining access to unrelated sessions.

## Goal

Add:

- `conversation_search(query, roles?, before_seq?, after_seq?, limit?)`
- `conversation_read(start_seq, end_seq?, max_messages?)`
- `conversation_tree_search(query, include_tasks?, include_subagents?, limit?)`

`conversation_search` and `conversation_read` are confined to `ctx.conversationId`.
They do not accept an arbitrary conversation ID. `conversation_tree_search` may search
only worker transcripts descended from the current source conversation.

## Scope model

1. `conversation` — current conversation; default.
2. `conversation_tree` — current conversation plus its background-task/subagent worker
   transcripts; separate capability.
3. `project` — not granted by this plan; future explicit permission and user intent.
4. `global` — not granted by this plan.

Chat, Interactive, North Star, and Process workers all resolve "current conversation"
from server-owned context, never model input. A Process worker may search its own
transcript; access to sibling/upstream phase transcripts belongs to `039`/Process
messaging policy, not this tool.

## Storage and search

Add an FTS5 index over searchable message content with migration/backfill and triggers
or transactional dual writes. Index visible content and bounded tool-call/result text;
retain role, sequence, timestamp, tool name, and conversation ID for filtering. Search
snippets are evidence pointers, not replacements for `conversation_read`.

Resolve conversation-tree membership through the existing task source/worker links.
Reject orphaned, deleted, unrelated, or merely same-project conversations. Return
source labels (`current`, `task`, `subagent`) without leaking hidden database IDs unless
needed for an authorized follow-up read.

Results are capped and pageable. `conversation_read` preserves chronological order and
marks tool calls/results clearly. It may read messages covered by a rolling summary;
the point is to recover originals.

## Capability and privacy

- `conversation_search/read` get a `conversation_recall` capability.
- `conversation_tree_search` gets a distinct `conversation_tree_recall` capability.
- Neither is universal and neither is implied by workspace/project membership.
- External-agent mappings grant only the scope their source tool actually expresses.
- Record recall tool calls in the transcript for auditability.

## Verification

- Current-conversation matches before/after summary coverage and compaction.
- Role/sequence filters, quoting, Unicode, FTS syntax escaping, empty/deleted content,
  tool results, result caps, and pagination.
- Tree search includes only true descendants and cannot reach sibling, same-project,
  pinned, archived, or global conversations.
- Deleting a conversation cascades/cleans its FTS rows.
- SQL/FTS injection attempts are parameterized and harmless.

## Out of scope

- Project/global conversation search, semantic/vector search, automatic memory writes,
  or using recall to bypass `039` phase-agent messaging.
