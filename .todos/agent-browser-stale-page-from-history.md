# TODO: agent reports a closed browser page as still open (stale conversation history)

## Status: deferred (accepted for now)

## Symptom

Repro:
1. Open a page in the agent browser (e.g. `google.com`), have the agent search
   for something — it correctly reports the page.
2. Close the tab (the sidebar/pop-out "×", or `browser_close`).
3. Ask the agent "what page do you have open?" → it still answers with the OLD
   page ("the Google search results for deepagents docs", with the stale URL),
   even though nothing is open. Persists across an app restart + reopening the
   same conversation.

## Root cause

The agent isn't reading a live browser to answer — it's inferring the answer
from **its own earlier assistant message** in the conversation history, where it
said the page was open. That prior turn is permanent in the transcript and reads
as ground truth, so a now-closed browser keeps getting reported as open.

The in-memory "ever opened" idea failed because it's wiped on restart (exactly
when the stale history is still there). We then made the `browser_state` context
section **always emit** an authoritative "nothing is open" line every turn (see
`src/main/agent/context/sections.ts` `browserStateSection`, and the push site in
`src/main/agent/index.ts`). That was the right direction but STILL wasn't
enough in practice — the model kept trusting the older, very specific assistant
claim in a long history over the fresh system-context line.

## Why deferred

Fixing "the model weights stale history over a current system fact" is a real
prompt-engineering / context-ordering problem, not a quick wiring fix. The
current behavior is a cosmetic wrong answer to a meta-question ("what's open?"),
not a functional break — navigation, reading, and closing all work. Punted.

## Things to try when picked up

- **Stronger / better-placed assertion.** The `browser_state` line may be too far
  from the end of the prompt to outrank a recent assistant turn. Try placing the
  current-state line last (closest to the user's question), or raising its
  prominence (heading, "IGNORE any earlier statements about open pages").
- **Reconcile at answer time, not just via context.** Consider a cheap system
  reminder injected right after the user's message when it asks about browser
  state, rather than relying on a standing section.
- **Prune/annotate stale claims.** Explore marking superseded browser mentions in
  replayed history (harder — touches the context builder's replay path).
- **Tool-first nudge.** Encourage the model to call `browser_snapshot` before
  answering "what's open" questions, so it consults live state instead of memory.

## Files (starting points)
- `src/main/agent/context/sections.ts` — `browserStateSection` (the current-state
  line wording + shape).
- `src/main/agent/context/context-builder.ts` — section ordering / priority
  (`SECTION_PRIORITY.browserState`) and history replay.
- `src/main/agent/index.ts` — where the section is pushed each turn.
- `src/main/browser/manager.ts` — `stateFor` / `handle.state()` (the live read;
  this part is correct — the gap is downstream in how the model uses it).

## Verification (when picked up)
- The exact repro above: after closing the tab, asking "what page is open?" gets
  "nothing is open" — including in a long conversation whose history mentions the
  old page, and after an app restart.

## Provenance
Split out 2026-08-17 from the agent-browser navigation/state work (branch
`fix/agent-browser-navigation-state`). That branch shipped user navigation, the
user/agent close button, the always-emitted `browser_state` section, and the
themed pop-out window; this stale-history edge case is the remaining known gap.
