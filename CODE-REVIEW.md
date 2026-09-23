# Code Review — north-star-ts

Scope: performance, correctness, security, and maintainability. Read-only review; no
code was changed. Findings are ordered by area, each tagged with a rough severity
(High / Medium / Low) and a location.

## Executive summary

The codebase is, on the whole, unusually careful for its size. The main-process
security posture is strong (parameterized SQL + FTS5, `O_NOFOLLOW` file opens,
per-component symlink checks, realpath TOCTOU mitigation, process-group kills, a
locked-down `contextBridge` preload, an isolated+sandboxed untrusted browser view).
Output is consistently bounded (byte/entry caps, ring buffers). Most of the concrete
issues are concentrated in two places: the **context builder re-reading full history
every turn**, and the **renderer re-highlighting streamed markdown every token**.
There are no O(n²) algorithms in the hot server paths beyond those two, and no obvious
memory leaks except a listener-accumulation risk in the command-session polling path.

---

## Performance

### P1 (High) — ContextBuilder loads and parses the entire conversation every turn
`src/main/agent/context/context-builder.ts:110`

```ts
const history = listMessages(conversationId).filter(
  (message) => message.seq > (opts.historyAfterSeq ?? 0)
)
```

`listMessages` runs `SELECT * ... ORDER BY seq ASC` for **all** rows and maps every
one (including `JSON.parse` of `tool_calls`) — then the builder throws most of them
away with a JS `.filter`. When a rolling summary exists (`historyAfterSeq` is set),
the covered prefix is discarded *after* being fully read and parsed. Cost is O(n) per
turn, so O(n²) work (and GC churn) over the life of a long conversation, all on the
main process. The DB has the right index (`idx_messages_conversation_seq`), so this is
purely an application-layer waste.

Fix direction: push the `seq > ?` bound into SQL (add a `listMessagesAfterSeq(id, seq)`
that does `WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC`). The existing
composite index serves it directly.

### P2 (High) — Streamed markdown re-highlights the whole message on every token
`src/renderer/src/components/markdown.tsx:144` + `App.tsx:2917`

`Markdown` is `memo`ized, but during streaming `content` grows by a token per event, so
the memo key changes every event. `rehype-highlight` re-tokenizes the **entire**
growing code block on each delta — O(n²) over the final message length, synchronous on
the UI thread. For long code-heavy responses this is the most likely source of
streaming jank.

Fix directions (any of): debounce/throttle highlighting during streaming and only run
`rehype-highlight` once the turn settles; or split the streamed (last) message so only
its tail is re-rendered; or highlight in an idle callback.

### P3 (Medium) — Transcript is not virtualized; full timeline re-maps each token
`src/renderer/src/App.tsx:2878`

`displayTimeline.map(...)` renders every message with no windowing. Per-message
memoization (via `Markdown`) limits DOM churn, but the whole list reconciles on every
streamed token and every long conversation keeps all nodes mounted. Combine with P2 and
long sessions get expensive. Consider a virtualized list (only the P2 fix is needed for
the streaming-specific cost; virtualization addresses steady-state large transcripts).

### P4 (Low) — `findImportsOf` filters on a JSON expression (non-indexable)
`src/main/db/repositories/index-symbols.ts:106`

```sql
WHERE s.workspace_id = ? AND s.kind = 'import'
  AND json_extract(s.detail, '$.module') = ?
```

`json_extract` in the WHERE clause can't use an index, so this scans every `import`
symbol in the workspace per call. Bounded by workspace size and not on the hottest
path, but for large indexed repos "what imports X" degrades linearly. A generated /
stored `module` column (or an expression index) would make it O(log n).

### P5 (Low) — `App.tsx` is 3028 lines
Not a runtime perf issue, but a single 3k-line component file makes it hard to reason
about re-render boundaries and memoization — which is exactly what P2/P3 hinge on. See
Maintainability M1.

---

## Correctness

### C1 (Medium) — EventEmitter listener accumulation on command sessions
`src/main/agent/tools/command_session_tools.ts:885` (`waitForExitOrDelay`) and
`src/main/agent/env/local.ts` (`CommandSessionHandle.onExit` == `this.on("exit", cb)`)

`onExit` is a bare `EventEmitter.on` with no removal. `waitForExitOrDelay` registers a
fresh `onExit` listener **every call**, and it's called on every `write_stdin`,
`terminate`, and compatibility poll loop iteration. A session that is polled/written to
many times before exiting accumulates `exit` listeners on the same handle, which will
trip Node's `MaxListenersExceededWarning` (default 10) and slowly leak closures until
the process exits. It doesn't corrupt results (the timer still resolves), but it's a
real leak and a warning generator under interactive use.

Fix direction: have `onExit` return/track a disposer, or use `once` + explicit removal
in `waitForExitOrDelay`'s promise (clear the listener in the timer/exit branches).

### C2 (Low) — `networkByRequest` map can retain abandoned requests
`src/main/browser/session.ts:125`

Entries are deleted on `loadingFinished` / `loadingFailed`, but an in-flight request
that a navigation abandons (or a long-lived SSE/websocket) may never fire either, so
its map entry survives until the next full `reset()` (`did-navigate` only clears the
ref map, not `networkByRequest`). `networkEntries` is ring-capped, but this map is not.
Bounded per page in practice; worth a periodic sweep or clearing it on `did-navigate`
alongside `refs`. Also note `waitForNetworkIdle` keys off `networkByRequest.size === 0`,
so a stuck entry can make network-idle waits never resolve.

### C3 (Low) — Chat-attachment reads bypass `O_NOFOLLOW`
`src/main/agent/tools/read_file_tool.ts:123`

The workspace path goes through the hardened env (`safeOpenNoFollow`), but the Chat
attachment branch uses `hostOpen(p, "r")` directly. The path is constrained to the
user's own attachment allowlist, so the exposure is small, but it's an inconsistency
with the otherwise-uniform no-follow policy.

---

## Security

Overall strong. Notable good patterns worth preserving:

- **SQL**: everything is parameterized; recall search uses FTS5 with a sanitized query
  builder (`toFtsQuery`) and server-owned scope CTEs — no string interpolation of user
  input into SQL. (`conversation-recall.ts`)
- **Filesystem**: `assertScopedLocalPath` validates each path component for symlinks,
  uses `realpath` on the root to defeat TOCTOU, opens with `O_NOFOLLOW`, and refuses to
  delete the workspace root. (`local.ts`)
- **Shell**: commands run detached as a process-group leader so timeout/abort SIGKILL
  the whole group; stdin closed; an execution gate (`ctx.gate`) plus a re-check that cwd
  didn't change after approval. (`command_session_tools.ts`, `local.ts`)
- **IPC / preload**: a single typed `contextBridge` surface; no `nodeIntegration`; the
  renderer never touches the DB or fs directly; secrets (API keys, OAuth tokens) are
  `safeStorage`-encrypted and never cross IPC (only `hasKey`/`maskedKey`/`hasOauth`).
- **Untrusted browser view**: `contextIsolation: true, sandbox: true`, separate
  session partition, no page preload. (`browser/session.ts:131`)

Points to be aware of (not vulnerabilities as configured, but worth a note):

### S1 (Low) — Main window runs with `sandbox: false`
`src/main/index.ts:244`

The primary renderer window disables the sandbox (needed because the preload uses
`webUtils.getPathForFile`). With `contextIsolation` on (default) and a minimal preload
this is the common Electron trade-off and is acceptable, but it does mean a renderer
compromise has a slightly larger blast radius. Keep the preload surface tight and avoid
adding Node-powered helpers to it. There is a `setWindowOpenHandler` denying in-app new
windows and routing to `shell.openExternal` — good.

### S2 (Low) — `browser_evaluate` executes arbitrary JS in the page world
By design and gated behind approval, page-world only (no Node/Electron), bounded output.
Just flagging it as the one intentional arbitrary-code entry point so it stays gated.

---

## Maintainability

### M1 (Medium) — `App.tsx` at ~3028 lines
`src/renderer/src/App.tsx`

A single component file this large concentrates state, effects, and the entire
transcript render. It makes the P2/P3 render-performance fixes harder and raises the
risk of accidental re-render regressions. Extracting the message list / composer /
right-panel into their own mem0-friendly components would pay for itself.

### M2 (Low) — `schema.ts` is a 1279-line append-only migration log
`src/main/db/schema.ts`

This is a deliberate and well-documented style (each `SCHEMA_Vn` is immutable history
with excellent comments), so it's not a defect — but new readers should know migrations
are never edited in place, only appended, and several tables validate status enums in
the repo layer rather than via CHECK (to avoid painful table rebuilds). The convention
is sound; just call it out so it isn't "cleaned up" by mistake.

### M3 (Low) — `bytesToDrop` recomputation in `appendOutput`
`src/main/agent/tools/command_session_tools.ts:544`

The output-cap trimming loop is correct and bounded, but the `bytesToDrop` expression
is recomputed inline three times; a small helper would make the ring-buffer trim easier
to verify. Cosmetic.

---

## Things that are notably good (keep doing)

- Consistent output bounding across every tool (byte caps, entry caps, `truncateForModel`,
  UTF-8-safe prefix/suffix slicing, binary-search fit in `renderCommandResult`).
- The tool batch scheduler's abort handling: late success/rejection is quarantined,
  deadlines use a composed `AbortSignal.any`, and listeners are removed in `finally`.
  (`tool-batch-scheduler.ts`)
- Ring-capped browser console log buffer; terminal service kills all ptys and
  `removeAllListeners()` on dispose.
- Token estimate is cached per message (`token_estimate`) and the counter is a single
  swappable module shared by the builder and the repo, so budgeting math stays aligned.

## Suggested priority order

1. **P1** — bound history read in SQL (cheap, high impact, main-thread).
2. **P2** — stop re-highlighting streamed markdown every token (biggest UX win).
3. **C1** — fix command-session `onExit` listener accumulation.
4. **P3 / M1** — virtualize the transcript / decompose `App.tsx`.
5. **P4, C2, C3, S1** — as capacity allows.
