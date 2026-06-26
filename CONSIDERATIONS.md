# Considerations

Running list of known trade-offs and deferred decisions. Each entry notes the
current behavior, why it's acceptable for now, and what to change if the
assumption breaks.

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
