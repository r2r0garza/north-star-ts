# SQLite Persistence Layer (Phase 1)

## Context

Cowork's chat is currently stateless: `runChat` (`src/main/agent/index.ts`) builds a fresh
`[{system},{user}]` message array on every call, has no memory of prior turns, and persists
nothing. Conversations vanish on reload. The user wants to move from a "stateless chat box" to a
"local-first assistant with persistent conversations, workspace-aware tasks, and resumable
execution."

**This phase** lays the durable foundation: a complete SQLite schema for the long-term
architecture, fully-wired persistence for conversations/messages/workspaces (a chat with real
memory), and storage-only repositories for tasks/events/checkpoints/approvals so the future task
runtime has a home. **Explicitly out of scope:** the execution engine, durable runner, checkpoint
restoration, resume logic, and repo-indexing tables — schema is designed not to block them, but no
runtime is built.

Key decisions locked with the user:
- **Conversation is the primary entity.** Each view creates a conversation: Chat→`chat`,
  Interactive→`interactive`, North Star→`north_star`. A conversation optionally links a workspace
  and may spawn **one-to-many** durable tasks (separate entities, own lifecycle, never embedded).
- **Sidebar** lists past conversations grouped by mode; click to reopen + reload. The "+" button is
  relabeled per view: Chat→"+ New Chat", Interactive→"+ New Session", North Star→"+ New Task".
- **ContextBuilder abstraction.** The agent must NOT be coupled to any retrieval strategy. Start
  with token-budget walk-back; designed to later add summaries, memories, workspace/task/codebase
  context. Token counter is swappable (chars/4 heuristic initially).
- **better-sqlite3**, main-process only, DB at `app.getPath('userData')/cowork.db`.

## Critical files (to modify)
- `src/main/index.ts` — IPC registration, DB init on `whenReady`
- `src/main/agent/index.ts` — `runChat` refactor (consume ContextBuilder, persist turns)
- `src/preload/index.ts` — add `db` namespace to `window.cowork`
- `src/renderer/src/main.tsx` — Shell holds `activeConversationId`
- `src/renderer/src/App.tsx` — load/create conversation, reload messages
- `src/renderer/src/components/sidebar.tsx` — conversation list + "+ New" button
- `package.json` — deps, `postinstall`, `asarUnpack`

## New files
```
src/main/db/connection.ts            # singleton Database, pragmas, runs migrations
src/main/db/migrations.ts            # user_version runner + ordered migrations
src/main/db/schema.ts                # v1 CREATE TABLE statements (TS string export)
src/main/db/types.ts                 # row types + enum unions (Mode, TaskStatus, ...)
src/main/db/repositories/{conversations,messages,workspaces,tasks,task-events,task-checkpoints,approvals}.ts
src/main/db/repositories/index.ts    # barrel
src/main/agent/context/token-counter.ts   # TokenCounter interface + chars/4 default
src/main/agent/context/context-builder.ts # history assembly + budgeting
src/main/ipc/db-handlers.ts          # registers all db: IPC channels
```

---

## 1. Dependencies + native-module rebuild (do this FIRST, verify boot before any DB code)

better-sqlite3 is a native addon compiled against Node's ABI; Electron 37 uses a different ABI.
Without a rebuild the first `require` crashes the main process. The project has no rebuild step today.

**package.json changes:**
- `dependencies`: add `"better-sqlite3": "^12.x"` (runtime — must ship)
- `devDependencies`: add `"@types/better-sqlite3": "^7.x"`
- `scripts`: add `"postinstall": "electron-builder install-app-deps"` (rebuilds against Electron's ABI; electron-builder + `build` block already present)
- `build`: add `"asarUnpack": ["**/node_modules/better-sqlite3/**"]` (native `.node` can't load from inside asar)

**electron.vite.config.ts:** no change — `externalizeDepsPlugin()` already keeps better-sqlite3
external for main/preload. Do NOT import it (even type-only with runtime) in preload; confine the
runtime to main. Use `crypto.randomUUID()` (Node 20 core) for ids — no `uuid` dep.

After landing: `npm install` then `npm run dev`, confirm no `NODE_MODULE_VERSION` error and
`~/Library/Application Support/Cowork/cowork.db` is created. Existing clones must re-run install.

## 2. Schema (migration v1)

Conventions: `TEXT` UUID primary keys (stable for future local-first sync); `task_events` uses
`INTEGER PRIMARY KEY AUTOINCREMENT` for cheap monotonic log ordering. Timestamps are `INTEGER` epoch
ms set in the repo layer. Enums are `TEXT` with `CHECK`. JSON stored as `TEXT`. Connection pragmas:
`journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('chat','interactive','north_star')),
  title TEXT,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
CREATE INDEX idx_conversations_mode_updated ON conversations(mode, updated_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,                 -- per-conversation order (ties-proof vs timestamp)
  role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content TEXT,                         -- NULL allowed for pure tool-call assistant turn
  tool_calls TEXT,                      -- JSON [{id,name,arguments}]
  tool_call_id TEXT,                    -- on role='tool' rows
  tool_name TEXT,
  token_estimate INTEGER,               -- cached for ContextBuilder budgeting
  created_at INTEGER NOT NULL );
CREATE INDEX idx_messages_conversation_seq ON messages(conversation_id, seq);

CREATE TABLE tasks (                    -- STORAGE ONLY this phase
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  title TEXT,
  status TEXT NOT NULL CHECK (status IN
    ('queued','running','waiting_for_approval','interrupted','completed','failed','cancelled')),
  input TEXT, result TEXT, error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );
CREATE INDEX idx_tasks_conversation ON tasks(conversation_id);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE task_events (              -- append-only, STORAGE ONLY
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                   -- free-form; runner defines vocabulary later
  payload TEXT, created_at INTEGER NOT NULL );
CREATE INDEX idx_task_events_task ON task_events(task_id, id);

CREATE TABLE task_checkpoints (         -- STORAGE ONLY
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL );
CREATE INDEX idx_task_checkpoints_task ON task_checkpoints(task_id, created_at);

CREATE TABLE approvals (                -- STORAGE ONLY
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied')),
  request TEXT, decision TEXT,
  requested_at INTEGER NOT NULL, resolved_at INTEGER );
CREATE INDEX idx_approvals_task ON approvals(task_id);
CREATE INDEX idx_approvals_status ON approvals(status);
```

The `(role, content, tool_calls, tool_call_id, tool_name)` shape round-trips exactly to/from the
OpenAI-shaped messages `runChat` already builds (`src/main/agent/index.ts:203-231`). System rows are
allowed by the CHECK but NOT persisted (the prompt is dynamic per-turn). Future repo-indexing tables
(v2+) reference `workspaces(id)` and inject into ContextBuilder — nothing here blocks them.

**Migration runner:** read `PRAGMA user_version`, apply each newer migration in a transaction, set
`PRAGMA user_version=N`. Raw SQL, no ORM (7 stable tables don't justify Drizzle's codegen).

## 3. Repositories (`src/main/db/repositories/`)

All synchronous (better-sqlite3 is sync). Repos own JSON (de)serialization, `seq`/timestamp
assignment, and call the token counter to cache `token_estimate`. Enum unions in `db/types.ts`:
`Mode`, `MessageRole`, `TaskStatus`, `ApprovalStatus`; plus row interfaces `Conversation`,
`Message`, `Workspace`, `Task`, `TaskEvent`, `TaskCheckpoint`, `Approval`, `ToolCallRecord`.

**Fully wired (CRUD):**
- conversations: `create`, `get`, `list({mode?})` (updatedAt DESC), `update`, `touch` (bump updatedAt), `delete`
- messages: `appendMessage(...)` (computes seq via `max(seq)+1` in a txn, token_estimate, createdAt, touches conversation), `listMessages(conversationId)` (seq ASC), `get`, `delete`
- workspaces: `upsert(path,name?)` (dedupe on UNIQUE path), `get`, `getByPath`, `list`, `update`, `delete`

**Storage-only (ready for future runner):**
- tasks: `create` (default `queued`), `get`, `list({conversationId?,status?})`, `update`, `delete`
- task-events: `appendEvent`, `listEvents(taskId,{afterId?,limit?})`
- task-checkpoints: `createCheckpoint`, `get`, `listCheckpoints(taskId)`, `delete`
- approvals: `createApproval` (`pending`), `get`, `listApprovals({taskId?,status?})`, `resolveApproval(id,{status,decision?})`

## 4. ContextBuilder (`src/main/agent/context/`)

`token-counter.ts`: `interface TokenCounter { count(text): number }`; default chars/4 heuristic.
Injected into both ContextBuilder and `messages.appendMessage` so budgeting and cached estimates use
one function. Swapping to a real tokenizer = replace this module only.

`context-builder.ts`: `build(conversationId, { systemPrompt }): ChatMessage[]`. The agent passes the
already-assembled `systemPrompt` (base + skills, which load per-turn and depend on workspace) — the
builder owns ONLY history assembly so it stays decoupled from skill loading.

Walk-back algorithm:
1. `remaining = tokenBudget - count(systemPrompt)` (configurable budget, e.g. 12000, conservative vs model window since heuristic is approximate).
2. Load prior messages `seq DESC`, iterate newest→oldest, subtract cached `token_estimate`, prepend until budget exhausted.
3. **Turn-group integrity (critical):** admit/reject whole groups atomically — never an
   `assistant` w/ `tool_calls` without all its `tool` results, never an orphan `tool` row, or
   Portkey 400s. Scan to group boundaries before applying the cutoff.
4. Reverse to chronological; return `[{system}, ...history]`. The latest user message is already the
   last history row (persisted before build — see §5), so don't double-add.
5. Map stored rows → OpenAI shape (inverse of persistence): assistant→`{role,content,tool_calls?}`, tool→`{role:'tool',tool_call_id,content}`.

Future context sources (summaries, memories, codebase chunks) compose before the history walk via
the same `TokenCounter`; the `build()` signature does not change.

## 5. runChat refactor (`src/main/agent/index.ts`)

`ChatRequest` gains required `conversationId: string`. New flow:
1. Workspace validation, skills load, `systemPrompt` build, attachment inlining → **unchanged** (lines 95-133).
2. **Persist user message first:** `appendMessage({conversationId, role:'user', content: userContent})` (inlined content, so history reflects what the model saw).
3. **Build via ContextBuilder:** replace the hand-built array (lines 136-139) with
   `contextBuilder.build(conversationId, { systemPrompt })` — returns system + walked-back history ending in the just-saved user row.
4. Agentic loop (lines 149-233) unchanged EXCEPT persist each turn as it completes:
   - assistant turn w/ tool calls → `appendMessage({role:'assistant', content: text||null, toolCalls})`
   - each tool result → `appendMessage({role:'tool', content: result, toolCallId, toolName})`
   - final answer (line 198) → `appendMessage({role:'assistant', content: text})`
5. **Streaming via `onEvent` unchanged** — persistence happens alongside. Each `appendMessage` is its
   own small txn (never wrap the whole LLM round-trip in one — would hold the write lock; incremental
   writes also survive a mid-turn crash).
6. **Title backfill:** after persisting the first user row, if `conversation.title` is null, set it to a trimmed snippet — gives the sidebar readable labels.

This fixes the known limitation (ChatResult.content held only last-turn text): the DB now holds the
full transcript and that is what ContextBuilder replays. IPC return stays `{content,error}`.

## 6. IPC + preload

`chat` handler (`src/main/index.ts:61-67`): body unchanged; `req` now carries `conversationId`. DB
handlers registered in `src/main/ipc/db-handlers.ts`, invoked after `app.whenReady()`. Channels
(`ipcMain.handle`, `db:` namespace): `db:conversations:{create,list,get,update,delete}`,
`db:messages:list`, `db:workspaces:{list,upsert,update,delete}`, `db:tasks:{create,list,get,update,delete}`,
`db:taskEvents:{append,list}`, `db:checkpoints:{create,list,get,delete}`, `db:approvals:{create,list,resolve}`.

**No `saveMessage` exposed to renderer** — messages are written only inside `runChat` (main-side) to
protect transcript integrity. Renderer only *reads* via `db:messages:list`.

Preload (`src/preload/index.ts`): add a `db` namespace of thin `ipcRenderer.invoke` wrappers; keep
`chat`/pickers/fullscreen unchanged (chat's `req` type gains `conversationId`). `CoworkApi = typeof
api` auto-propagates to `window.cowork` via `env.d.ts`. Import row types from `src/main/db/types.ts`
with `import type` (types erased — no better-sqlite3 in the preload bundle).

## 7. Renderer

**Shell (`main.tsx`):** add `activeConversationId: string | null`; derive `mode` from `view`. On view
switch, do not auto-create — show most recent conversation for that mode or empty state. Pass
`activeConversationId`, `onSelectConversation`, `onNewConversation` to sidebar + App.

**App.tsx:** load messages for `activeConversationId` via `db.messages.list` on mount/change; map DB
rows → existing `ChatMessage` shape; **render filter** shows only user + non-empty assistant rows
(skip tool / tool-call-only rows — keeps today's two-bubble UX; full transcript stays in DB for the
LLM). On send with null id, `db.conversations.create({mode})` first. After `pickWorkspace`,
`db.workspaces.upsert(path)` + `db.conversations.update(id,{workspaceId})`. `chat` call gains
`conversationId`. Optimistic streaming bubble unchanged; reconcile with `db.messages.list` on settle
to avoid drift. **Disable conversation switching while `loading`** (avoids in-flight stream attaching
to the wrong conversation).

**sidebar.tsx:** fill the two empty `SidebarGroup` slots (lines 45-46) with: a "+ New" button
labeled by view (Chat→"+ New Chat", Interactive→"+ New Session", North Star→"+ New Task"), and a list
of `db.conversations.list()` grouped by mode (three labeled groups, updatedAt DESC), rendering
`title` (fallback to snippet/"Untitled"). Click → `onSelectConversation(id, mode)`. "+ New" →
`onNewConversation(mode)` (clears active id; lazy create on first send). Keep the existing view
button-group at top.

## Sequencing
deps+rebuild+asarUnpack (verify boot) → connection+migrations+schema → repositories+types →
ContextBuilder+token-counter → runChat refactor → IPC+preload → renderer. Each step typecheck-able
independently.

## Verification
1. `npm install` (postinstall rebuilds better-sqlite3), `npm run typecheck`, `npm run build` (confirm better-sqlite3 NOT bundled into `out/main/index.js`).
2. `npm run dev` — no `NODE_MODULE_VERSION` error; `cowork.db` created under userData.
3. Send 2-3 messages in North Star that trigger a tool call. Confirm streaming + bubbles work.
4. Read-only DB check: `sqlite3 cowork.db "SELECT role, substr(content,0,40), tool_call_id FROM messages ORDER BY seq"` — confirm full transcript (user, assistant+tool_calls, tool, final assistant).
5. Quit fully, relaunch. Sidebar lists the conversation under the right mode group; click reloads bubbles.
6. Send a follow-up referencing earlier context ("what did I ask first?") — correct answer proves ContextBuilder replayed stored history to the LLM, not just visual reload.
7. Interactive/North Star conversations record `workspaceId`; grouping correct.

## Risks
- **ABI rebuild is the #1 risk** — solve and verify boot before writing any DB code.
- **Turn-group integrity** in ContextBuilder — an orphan tool row → Portkey 400. Test tool-call conversations explicitly.
- **In-flight switch race** — mitigated by disabling switching while loading.
- **Heuristic token count** — keep budget conservative; swappable by design.
- WAL sidecar files (`-wal`/`-shm`) are expected, not corruption.
