# 002 — Token streaming over IPC

**Area:** Main ↔ preload ↔ renderer — `src/main/agent/index.ts`,
`src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/App.tsx`
**Status:** Implemented

## What

Full token streaming from the model through the agentic loop to the UI.

- **Agent loop** (`runChat`): switched the Portkey call to `stream: true` and
  iterate chunks. Text deltas are forwarded immediately; **tool-call fragments
  are reassembled by their `index`** (id/name accumulate, `arguments` string
  built up across chunks) and reconstructed into proper `tool_calls` after the
  stream ends. This is what makes streaming work *through* the loop, not just on
  the final answer. Emits `{type:"tool", phase:"start"|"done"}` around each tool
  execution.
- **IPC transport:** `ipcRenderer.invoke` is request/response only, so the
  `chat` handler streams events over a separate `chat:event` channel via
  `event.sender.send(...)` while the invoke still resolves with the final
  result. Guarded with `isDestroyed()`.
- **Preload:** `cowork.chat(req, onEvent)` attaches the `chat:event` listener
  for the turn and removes it in `.finally()` so listeners don't leak.
- **Renderer:** on send, pushes the user bubble plus an empty assistant bubble,
  then appends each token to it live. Shows `Thinking…` / `Using <tool>…` until
  the first token arrives.

### Multi-turn separator
When the model emits a preamble, calls a tool, then answers in a new turn, both
turns stream into the same bubble. A `streamedText` flag inserts a `\n\n`
separator before the first token of a later turn so the pieces don't run
together (this was a visible bug: "Let me check…Here's what I see").

## Why

- Streaming gives immediate feedback and the perception of speed.
- A dedicated event channel is the correct Electron pattern; `invoke` cannot
  stream.
- Reassembling tool-call deltas is required because OpenAI-compatible streaming
  delivers `arguments` in fragments.

## Trade-offs / notes

- Tool-call delta shapes differ from the non-streaming type, so the delta
  accumulation uses `any` (consistent with the existing code's handling of model
  shapes).
- **Known limitation (see `CONSIDERATIONS.md` #1):** the final `ChatResult.content`
  returned by the invoke contains only the **last turn's** text, not the full
  multi-turn transcript. Fine today because the streamed tokens carry everything
  and `content` is only a fallback; revisit if a non-streaming consumer or
  history persistence is added.
