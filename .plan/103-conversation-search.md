# PR103: Search conversations by title and transcript content

> Status: **COMPLETED in this branch**. Added a global conversation-search dialog from the sidebar, backed by bounded title queries and the existing SQLite message full-text index, with visible-content verification and normal mode-aware conversation selection.

## Goal

Let a user find an existing conversation without remembering its project, mode, or sidebar location.

- Put a magnifying-glass button between the active view's `New Chat` / `New Session` / `New Task` button and the `New project` button.
- Let the user search conversation titles and visible transcript text from one focused input.
- Show ranked conversation results with enough context to identify the right conversation.
- Open the selected conversation, including switching to its Chat, Interactive, or North Star view as needed.

## Current state

- `src/renderer/src/components/sidebar.tsx` renders the top action row. The flexible new-conversation button is followed directly by the icon-only new-project button (`sidebar.tsx:817-843`).
- `AppSidebar` already loads every user-facing conversation and accepts `onSelectConversation(id, mode)`. A normal sidebar row calls that callback with the stored mode (`sidebar.tsx:490-527`, `sidebar.tsx:559-607`).
- `Shell.handleSelectConversation()` switches the active view from the conversation mode, activates the conversation, clears fresh-conversation state, and closes competing center screens (`src/renderer/src/main.tsx:440-454`). Search selection should reuse this path rather than create a second navigation implementation.
- Conversation titles live on `conversations.title`; message text lives on `messages.content`.
- Schema v34 already maintains an FTS5 `message_fts` table for message content and serialized tool-call arguments, including an insert trigger and delete trigger (`src/main/db/schema.ts:1004-1049`). `conversation-recall.ts` demonstrates safe FTS query construction, ranking, snippets, and bounded result limits.
- `listConversations()` deliberately excludes private task-worker transcripts while retaining real conversations with `inline_todos` markers (`src/main/db/repositories/conversations.ts:98-128`). Global search must preserve exactly that user-facing visibility boundary.
- The renderer can currently list conversations and list all messages for one conversation, but it has no bounded cross-conversation search IPC method. Loading every transcript into the renderer would be wasteful and would expose internal rows unnecessarily.
- The existing `CommandDialog`, `CommandInput`, `CommandList`, and `CommandItem` primitives provide the expected focus, arrow-key, Enter, Escape, and scroll behavior (`src/renderer/src/components/ui/command.tsx`).

## Product decisions

1. **Global scope.** Search all user-facing conversations across Chat, Interactive, and North Star, not only the currently selected view or expanded projects. Choosing a result switches views through the existing selection callback.
2. **Visible-content scope.** Search conversation titles and persisted `user`/`assistant` message content. Exclude `system` and `tool` rows and do not match serialized `tool_calls`; those can contain internal or noisy text that the user does not see as ordinary conversation prose.
3. **Worker exclusion.** Apply the same task-worker exclusion as `listConversations()`. A hidden task, subagent, summarization, or indexing transcript must not become reachable through search. A genuine conversation carrying an `inline_todos` history marker remains searchable.
4. **Forgiving matching.** Treat “fuzzy” in this first version as case-insensitive matching across normalized query terms, partial-word/prefix matching, and title substring matching. Multi-term queries may match terms across the title and transcript, and ranking should not depend on exact capitalization or punctuation. Typo/edit-distance correction and semantic/vector similarity are out of scope; the UI should call the feature “Search conversations,” not promise typo correction.
5. **One row per conversation.** Collapse multiple matching messages into one conversation result. Return the strongest matching message snippet and enough metadata to explain the result rather than rendering every hit from one transcript.
6. **Ranking.** Exact title matches rank first, then title-prefix/substring matches, then title token matches, then transcript matches by FTS relevance. Use `updatedAt` as a deterministic recency tie-breaker. A title match may still show a matching transcript snippet when available, but title relevance remains dominant.
7. **Result presentation.** Each row shows the title (with a stable `Untitled conversation` fallback), a short highlighted content snippet when content matched, and compact mode/project/date context. Do not inject FTS snippet markup as HTML; parse server-owned marker tokens into React text/highlight nodes or return structured highlight ranges.
8. **Empty and loading states.** Opening the dialog focuses an empty input and prompts the user to type. Do not dump all conversations before a query exists. Show a bounded loading state while a request is active, `No conversations found` for a completed empty result, and a recoverable inline/toast error without closing the dialog.
9. **Interaction.** Mouse click or Enter opens the highlighted result and closes the dialog. Escape closes it and returns focus to the search trigger. Arrow-key navigation and visible focus/selection styling come from the command primitives.
10. **Freshness.** Search reads SQLite at request time, so newly persisted messages and renamed conversations are available without rebuilding a renderer index. In-flight streamed text is searchable only after it has been persisted; the dialog does not inspect renderer-only optimistic/live-turn state.
11. **Bounded work.** Debounce input by roughly 150–250 ms, require at least one searchable alphanumeric term, cap returned conversations (for example, 30), and ignore stale responses that resolve after a newer query or after the dialog closes.
12. **No schema migration initially.** Reuse `message_fts` for transcript candidates and query titles from `conversations`. Add a title FTS table only if profiling with a realistically large database shows title filtering/ranking needs it. The initial implementation must not scan or transfer every message to the renderer.

## Search contract and architecture

Add a main-process repository operation with a narrow renderer-safe result type. Exact names may follow repository conventions:

```ts
export interface ConversationSearchResult {
  conversationId: string
  mode: Mode
  title: string | null
  projectId: string | null
  projectName: string | null
  updatedAt: number
  matchKind: "title" | "content" | "title_and_content"
  snippet: string | null
  rank: number
}

searchConversations(query: string, options?: { limit?: number }): ConversationSearchResult[]
```

The renderer needs the conversation ID and mode to navigate, project/mode/date metadata to disambiguate results, and one bounded snippet. It does not need complete messages or raw FTS rows.

### Query normalization

Extract a shared helper from the existing recall query behavior, or add a nearby search-specific helper, that:

- Unicode-normalizes and trims input;
- extracts a bounded number of letter/number terms;
- safely quotes all generated FTS expressions rather than accepting raw FTS syntax;
- builds prefix terms such as `"term"*` for partial final words; and
- produces a normalized lowercase form for title scoring.

Punctuation-only input should return an empty result without invoking invalid `MATCH` syntax. Query length, term count, and result count must be clamped in the main process even if the renderer passes invalid values.

### Candidate selection and ranking

Keep filtering and heavy work in SQLite/main process. A practical query shape is:

1. Define a `visible_conversations` CTE using the same worker-transcript visibility rule as `listConversations()`.
2. Find title candidates with case-insensitive normalized substring/token predicates over only those visible conversations.
3. Find content candidates by joining `message_fts` to `visible_conversations`, restricting `role IN ('user', 'assistant')`, and applying the safely generated prefix FTS query.
4. Rank message hits using FTS/BM25, choose the best hit per conversation with a window function or grouped subquery, and generate one short snippet with uncommon marker tokens.
5. Union title and content candidates by conversation ID, compute an explicit title-first score, order by score then `updated_at DESC`, and apply a server-side limit.

Because the current FTS row also contains serialized tool-call data, role filtering alone is not sufficient to guarantee visible-content-only matching for assistant rows with tool calls. The implementation must either add a content-only FTS index in a migration or verify/query against `messages.content` so a result is admitted only when the visible content itself matches. Do not knowingly return a hit caused only by serialized tool-call arguments. Choose the least complex approach that remains indexed and measure it against a representative database before finalizing the SQL.

Keep the user-facing conversation predicate in one reusable repository helper/query fragment so sidebar listing and search cannot silently diverge when task kinds evolve.

### IPC and preload

Expose one bounded channel, for example:

```ts
window.cowork.db.conversations.search(query, { limit })
```

Register it next to the other conversation handlers in `src/main/ipc/db-handlers.ts`, define the shared result type in `src/main/db/types.ts` or the repository module, and add the typed preload wrapper in `src/preload/index.ts`. The main handler owns validation and limits; the renderer should not construct SQL/FTS syntax.

### Search dialog

Add a focused `ConversationSearchDialog` component rather than placing request, debounce, stale-response, and result-rendering state directly into the already large sidebar component. Suggested props are:

```ts
type ConversationSearchDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  onSelectConversation: (id: string, mode: Mode) => void
}
```

The dialog should use the existing command primitives for keyboard behavior but disable cmdk's independent client-side filtering (`shouldFilter={false}` or the equivalent), because SQLite has already ranked the rows. Preserve server order exactly.

`AppSidebar` owns the open state and renders an icon-only `Search` button between the flexible new-conversation action and the existing new-project button. Use the Lucide `Search`/`SearchIcon`, `aria-label="Search conversations"`, and a tooltip. The button must remain available in every view.

On selection, call the existing `onSelectConversation(result.conversationId, result.mode)` and then close/reset the dialog. This delegates all view switching and active-conversation cleanup to `Shell.handleSelectConversation()`.

## Implementation plan

### 1. Define and test user-facing search semantics

Add a repository-level result type, query normalization helper, and `searchConversations()` operation. Reuse or extract the sidebar's user-facing conversation scope. Implement bounded title and message candidate queries, per-conversation collapse, title-first ranking, content-role restrictions, deterministic recency tie-breaking, and safe snippets.

Add SQLite-backed tests covering:

- exact, case-insensitive, substring, and partial-token title matches;
- user and assistant content matches;
- partial final-word content matching;
- a conversation with many matching messages producing one result and its strongest snippet;
- title matches ranking above content-only matches;
- deterministic recency ordering for equal-ranked results;
- multi-term behavior across expected fields;
- punctuation-only, whitespace-only, oversized, and FTS metacharacter input;
- result-limit clamping;
- exclusion of system content, tool content, and tool-call-argument-only matches;
- exclusion of forked worker transcripts with retention of real `inline_todos` conversations; and
- deleted messages/conversations disappearing through the existing FTS triggers and foreign-key behavior.

Profile the query using a seeded database large enough to represent real usage. If content-only verification causes a full messages-table scan, add a migration for a content-only FTS table rather than shipping an unbounded scan.

### 2. Add the bounded IPC/preload API

Register the conversation-search IPC handler and expose its typed preload method. Add focused handler/preload tests following existing IPC subscription/bridge conventions. Verify malformed renderer arguments cannot bypass query-length, term-count, role, visibility, or result-count constraints.

### 3. Build the conversation-search dialog

Create the dialog with controlled input, debounced requests, explicit loading/empty/error states, stale-response suppression, server-order rendering, accessible snippet highlighting, and keyboard/mouse selection. Resolve project labels from the sidebar's already loaded project list; tolerate a missing/deleted project by omitting that label.

Use localized date formatting for `updatedAt`. Keep snippets compact and visually secondary, preserve line wrapping without allowing a single result to grow without bound, and ensure highlighted markers never render as HTML.

Add renderer tests for:

- focus on open and focus return on close;
- no request for an empty or punctuation-only query;
- debouncing rapid typing to the latest query;
- stale/out-of-order response suppression;
- loading, no-result, and rejected-request states;
- preserving server result order instead of cmdk re-filtering;
- accessible rendering of title/content matches and highlight markers;
- arrow/Enter, click, and Escape behavior; and
- selection calling the supplied ID/mode exactly once before closing.

### 4. Integrate the sidebar trigger and normal navigation path

Insert the magnifying-glass button between the new-conversation and new-project controls without shrinking the primary button below a usable width. Pass `projects` and the existing `onSelectConversation` callback into the dialog. Do not add search state to `Shell` or dispatch a custom event when the direct callback is already available.

Verify a result from each mode switches to the corresponding view, closes Settings/Skills/Agents/Processes/MCP/Dashboards through the normal handler, loads the stored transcript, and marks the selected sidebar row active even when its project section was collapsed before selection.

### 5. Verify performance, accessibility, and regressions

Manually test short and long queries, punctuation, mixed case, Markdown/code content, duplicate matching messages, untitled conversations, deleted/renamed conversations, all three modes, dark/light themes, narrow sidebar/window widths, keyboard-only operation, and a database with many conversations/messages.

Confirm opening search performs no all-message renderer fetch, typing remains responsive, stale requests do not flash older results, and hidden worker conversations cannot be opened through search.

Run focused repository and component tests, then `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Acceptance criteria

- A tooltip-backed magnifying-glass button appears between the active view's new-conversation button and the new-project button.
- Activating it opens an accessible dialog with an immediately focused search input.
- Search covers titles and persisted visible user/assistant content across all user-facing conversations and all three modes.
- Matching is case-insensitive and supports title substrings and partial/prefix words without accepting raw FTS syntax.
- Hidden task/worker transcripts, system rows, tool rows, and tool-call-only text never appear as search results.
- Results contain at most one row per conversation, show a useful title/snippet plus disambiguating metadata, and are ranked title-first with deterministic recency tie-breaking.
- Search work and result counts are bounded in the main process; the renderer never loads every transcript to search it.
- Rapid typing cannot let an older response replace results for a newer query.
- Arrow keys change the highlighted result, Enter and click open it, and Escape closes the dialog with sensible focus restoration.
- Choosing a result closes the dialog and opens that exact conversation through the existing mode-aware navigation path.
- Newly persisted content and renamed titles become searchable without restarting or rebuilding a renderer index; deleted conversations disappear.
- Existing sidebar grouping, project drag/reorder, pin/rename/delete actions, new-conversation behavior, and new-project behavior remain unchanged.

## Likely files

- Modify: `src/main/db/repositories/conversations.ts` or add `src/main/db/repositories/conversation-search.ts`
- Modify/add: focused repository tests, likely beside `src/main/db/repositories/conversations.test.ts`
- Possibly modify: `src/main/db/schema.ts`, `src/main/db/migrations.ts`, and migration tests only if a content-only/title FTS index is justified by correctness or profiling
- Modify: `src/main/db/types.ts`
- Modify: `src/main/ipc/db-handlers.ts`
- Modify: `src/preload/index.ts` and focused preload/IPC tests
- Add: `src/renderer/src/components/conversation-search-dialog.tsx`
- Add: `src/renderer/src/components/conversation-search-dialog.test.tsx`
- Modify: `src/renderer/src/components/sidebar.tsx`
- Possibly add: a small pure snippet-marker parser and tests if it does not naturally belong in the dialog module

## Out of scope

- Searching private task-worker/subagent transcripts, plan files, todos, approvals, browser pages, terminal output, files, or dashboard data.
- Jumping or scrolling to the exact matching message after the conversation opens; selection opens the conversation at its normal restored/default position.
- Typo/edit-distance correction, stemming across languages, synonym expansion, embeddings, or semantic/vector search.
- Search filters for project, mode, role, agent, workspace, or date; result metadata leaves room for later filters.
- Search-history persistence, saved searches, recent-search suggestions, or a global keyboard shortcut.
- Editing, deleting, pinning, renaming, or moving conversations from the result dialog.
- Searching renderer-only optimistic or currently streaming text before it is persisted.
