# Considerations

Running list of known trade-offs and deferred decisions. Each entry notes the
current behavior, why it's acceptable for now, and what to change if the
assumption breaks.

## 7. The agentic loop in `runChat` is unbounded (no round-trip cap)

**Where:** `src/main/agent/index.ts` — the `while (true)` agentic loop in `runChat`.

**Behavior:** The loop calls the model, runs any tools it requests, and repeats
until the model returns a turn with **no tool calls** (the final answer). There
is no maximum round-trip count — matching Claude Code, which lets the model run
until it's done. Previously this was `for (let i = 0; i < 5; i++)`, which
silently ended multi-step tasks right after exploration/reads (before the edit
step) and returned a "did not finish within the tool-call limit" error. The todo
tool — built for multi-step work — was the first feature to routinely hit it.

**Why it's fine now:** A turn ends naturally when the model stops calling tools.
The remaining backstops are: a thrown error (network/API failure) is caught,
persisted as an assistant note, and surfaced (see #8); approval-gated tools still
require human sign-off per dangerous action; and the user can close the window.
Real tasks converge in a bounded number of steps.

**Change if:** a model gets stuck in a tool-call cycle (e.g. repeatedly reading
the same file, or two tools ping-ponging) and burns tokens without converging.
Then add a *soft* guard rather than the old hard cap — e.g. detect repeated
identical tool calls, or a generous ceiling (hundreds) that only trips on a true
runaway — plus turn cancellation (the known limitation in `002`, no abort path
today). Also revisit `max_tokens: 1024` per call, which is independently low for
large edits.

## 8. A failed turn is persisted as an assistant note

**Where:** `src/main/agent/index.ts` (the `catch` in `runChat`) and the live
error handling in `src/renderer/src/App.tsx` (`sendMessage`).

**Behavior:** When a turn throws (network/API error), `runChat` writes an
assistant message (`⚠️ The turn ended early: <message>`) before returning the
error, so a reopened conversation explains why it stopped instead of ending
silently after the last tool marker. The renderer also *appends* the error to
the live bubble (rather than the old `s || …`, which dropped it whenever a
preamble had already streamed) so it's visible immediately too.

**Why it's fine now:** Silent stops were the worst part of the old behavior —
the user saw tool activity then nothing. A persisted note is simple, survives
reload, and reconciles cleanly with the transcript.

**Change if:** we want richer error UX (a distinct error bubble style, a retry
affordance, or structured error rows rather than a text message). The persisted
note is plain assistant text today; a dedicated error role/marker would let the
UI style it differently and avoid it being mistaken for model output.

## 9. Stop cancels the LLM stream and the loop, but not an in-flight tool

**Where:** `src/main/agent/index.ts` (`stopChat`, the per-conversation
`abortControllers` map, the abort checks in the loop + gate); IPC `chat:stop` in
`src/main/index.ts`; `chatStop` in `src/preload/index.ts`; the Send↔Stop toggle
and `stopMessage` in `src/renderer/src/App.tsx`.

**Behavior:** The Stop button aborts the turn's `AbortController`. That (a)
cancels the in-flight LLM stream, (b) releases any pending approval gate as a
denial, and (c) breaks the agentic loop before the next round-trip. A clean stop
persists a neutral "⏹ Stopped by user." note (preserving any text that already
streamed) and returns `{ stopped: true }` (not an error). This closes most of
the PR2 "renderer disconnect hangs the gate" gap — an explicit Stop now unwinds
a turn waiting on approval.

**How the stream is actually cancelled (important):** the Portkey SDK (3.1.0)
**ignores `opts.signal` for the fetch** — `buildRequest` never attaches it, and
`signal` is only read post-hoc to relabel an already-thrown error
(`node_modules/.../portkey-ai/dist/src/baseClient.js`). So aborting the
controller does **not** stop a healthy stream on its own. Cancellation works
because the consume loop in `runChat` checks `abort.signal.aborted` and `break`s
out of the `for await`; that runs the stream iterator's `return()` →
`reader.cancel()` (`streaming.js`), which tears down the HTTP response body. We
still pass `signal` to `create()` so the SDK's error path labels things
correctly, but the `break` is what does the work.

What Stop does **not** interrupt: a tool that is **already executing** when Stop
is pressed (e.g. a long `run_shell_tool` command, or a large file read). The
loop awaits that tool to completion, then sees `signal.aborted` and stops before
the next model call — so the stop is honored, but a slow in-flight tool can
delay it. Tools don't currently receive the abort signal.

**Why it's fine now:** Inference (the long pole) and the loop are both cancelled
promptly, which covers the common case (stop a rambling/looping turn). Tool
calls are individually short relative to a multi-step turn.

**Change if:** a single tool can run long enough that "Stop doesn't stop it" is
noticeable — most likely `run_shell_tool` on a slow command, or a future
network/MCP tool. Then thread the abort signal into `ToolContext` and have
long-running tools (shell exec especially) honor it: pass it to
`child_process.spawn`'s `signal` option so Stop kills the subprocess too.

## 1. `runChat` returns only the last turn's text

**Where:** `src/main/agent/index.ts` (`runChat` return value), consumed by the
fallback path in `src/renderer/src/App.tsx` (`sendMessage`).

**Behavior:** When the model splits a reply across multiple turns (e.g. a
preamble like "Let me check the workspace for you!", then a tool call, then the
real answer), the streamed `chat:event` tokens carry the **full** concatenated
text, but the final `ChatResult.content` returned by the IPC invoke contains
**only the last turn's** text. The preamble is not included.

**Why it's fine now:** During normal streaming the renderer builds the bubble
from the live tokens, which include every turn plus the `\n\n` separators we
insert between turns. The returned `content` is only used as a fallback when
*nothing* streamed (e.g. an error, or a future non-streaming caller). On the
real streaming path the preamble is never lost.

**Change if:** we add a non-streaming consumer of `runChat`, persist
conversation history from the returned `content`, or otherwise rely on
`ChatResult.content` being the complete assistant message. In that case,
accumulate the full transcript across turns and return that instead of just the
last turn's text.

## 2. App-bundled skills are read-only when packaged

**Where:** `src/main/agent/skills/sources.ts` (the first source,
`<appPath>/skills`), packaged via the `build.files` entry in `package.json`.

**Behavior:** Skills load from three sources in last-wins order: app-bundled →
user-level (`~/.cowork/skills`) → workspace (`<workspace>/.cowork/skills`). In a
packaged build, `app.getAppPath()` points inside the read-only `app.asar`
archive, so the app-bundled `skills/` dir **cannot be written to** at runtime.

**Why it's fine now:** We only *read* skills today. The bundled dir ships
curated defaults with the app, which is exactly what a read-only location is
for.

**Change if:** we add a "create/edit skill" feature (the user asked about
app-bundled skills supporting writes). New/edited skills must be written to a
writable location — the user-level dir `~/.cowork/skills` (personal, all
workspaces) or the workspace dir `<workspace>/.cowork/skills` (project-scoped).
Do NOT attempt to write into the app-bundled dir; it will fail in production.

## 3. Skills are reloaded on every chat turn

**Where:** `src/main/agent/index.ts` (`runChat` calls `loadSkills` each turn).

**Behavior:** Because the workspace can change between messages and skills
include a per-workspace source, `loadSkills` re-scans all three source dirs and
re-reads every `SKILL.md` body on each chat request.

**Why it's fine now:** Skill files are small and few; the disk I/O is
negligible next to a model round-trip. Reloading also means user/project skill
edits take effect immediately without restarting the app.

**Change if:** skill counts or file sizes grow enough that per-turn scanning
becomes noticeable. Cache by source dir and invalidate on workspace change (or
via fs watch), as the example's "load once at startup" note suggests.

## 4. The base system prompt is cached for the process lifetime

**Where:** `src/main/agent/system-prompt.ts` (`loadSystemPrompt`), backed by
`prompts/system-prompt.md` and packaged via the `build.files` entry in
`package.json`.

**Behavior:** The base prompt is read from disk once and cached in the `cached`
module variable for the rest of the process lifetime. Editing
`prompts/system-prompt.md` while the app is running has **no effect** until the
main process restarts (in dev, electron-vite reloads the main process on save;
in a packaged build the file lives inside the read-only `app.asar` anyway — see
the same packaging caveat as #2). The skills section is appended fresh each turn
and is **not** part of this cache.

**Why it's fine now:** The prompt rarely changes at runtime, and caching avoids
a disk read on every message. A restart picks up edits.

**Change if:** we want prompt edits to apply on the **next message** without a
restart. Two options:

  1. **Drop the cache** — remove the `cached` short-circuit so `loadSystemPrompt`
     re-reads the file every turn. Cost is one small disk read per message,
     negligible next to a model round-trip (this mirrors how skills already
     reload per turn, see #3).
  2. **Cache with invalidation** — keep the cache but watch the file (fs watch)
     or compare mtime, reloading only when it changes.
Option 1 is simplest and consistent with the skills behavior.

## 6. DB-integration tests skip unless `better-sqlite3` matches the Node ABI

**Where:** SQLite-backed Vitest files that use `sqliteLoadsForTests()` and
`describe.skipIf(!sqliteLoads)`, driven by how `better-sqlite3` is built (see the
native-module-rebuild memory note).

**Behavior:** `better-sqlite3` ships a native binary compiled for **one** Node ABI.
The app needs it built for **Electron's** ABI, so under plain-Node `vitest` the
binary fails to load (`NODE_MODULE_VERSION` mismatch). SQLite-backed tests still
skip in the default local suite when the binary is in Electron ABI mode, keeping
the everyday app-development path green.

**Verification contract:** `.github/workflows/ci.yml` has a dedicated
`sqlite-tests` job that runs `npm_config_build_from_source=true npm rebuild better-sqlite3`,
then `pnpm test:sqlite`. That script sets `COWORK_REQUIRE_SQLITE_TESTS=1`, so the
SQLite probe fails closed if the native module cannot load, and it parses
Vitest's JSON report to fail when any SQLite-backed assertion is skipped.

**Local workflow:** To run the same coverage locally, switch to the Node ABI,
run the SQLite job, then restore Electron compatibility:

```bash
npm_config_build_from_source=true npm rebuild better-sqlite3
pnpm test:sqlite
pnpm exec electron-rebuild -f -w better-sqlite3
```

## 5. Chat attachments are inlined whole, as UTF-8, with a per-file size cap

**Where:** `src/main/agent/index.ts` (`buildAttachmentsText`, `MAX_ATTACHMENT_BYTES`),
fed by the Chat view's file picker in `src/renderer/src/App.tsx`. See
`.decisions/007-view-switcher-chat-attachments.md`.

**Behavior:** In the Chat view (no workspace), each attached file is read with
`readFile(p, "utf8")` and inlined into the user message as a labeled fenced
block. Files over **256 KB** are skipped with a short note; so are files that
fail to read or aren't regular files. There is **no content-type detection** —
a binary file (image, PDF, zip) is decoded as UTF-8 and inlined as garbage — and
**no token budgeting**: attaching many files near the cap can still blow past the
model's context window, and `max_tokens` is a fixed 1024.

**Why it's fine now:** Chat is aimed at small text files (code, config, notes).
A hard per-file byte cap is a cheap guard against a stray huge file, and inlining
keeps Chat mode free of any filesystem access (the model gets no tools that touch
disk). Keeping it dumb avoids premature complexity.

**Change if:** users attach binaries or large/many files. Then: sniff content
type and reject or special-case binaries (e.g. base64 image parts if the model
supports vision); budget total inlined bytes against the context window, not just
per file; and consider streaming large files through a tool/RAG instead of
inlining. If Chat ever gains a workspace, prefer filesystem tools over inlining.
