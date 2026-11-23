# Issue 56: Boards command output

Implemented inside the existing card run-history sidebar. Only command-column runs receive live output; agent transcripts and tracker-write presentation are unchanged.

## Implementation decisions

The sidebar reads atomic run-history/output snapshots every 250 ms while open. Requests are serialized and responses from a closed or superseded card are ignored. Full retained snapshots avoid an initial-buffer/event-subscription race and duplicate chunk appends. Closing the sidebar only cancels viewing, not execution.

Each run retains a 64 KiB UTF-8 tail, combining stdout/stderr in capture callback order. Completed logs are retained for up to 100 runs per application session; active/queued/draining runs are not evicted. An omission notice reports discarded bytes. Live buffers are not archived: after application restart or eviction the viewer explicitly reports unavailable live output, alongside the existing SQLite result/error history.

Queued commands show resolved substitutions and the per-run override. The actual executed command and working directory replace that snapshot after workspace placement. Process spawn, exit code, signal, timeout, stop and startup failure are recorded independently from board outcome routing. No execution policy, scheduling, timeout, environment, routing or process controls were changed.

Output uses the conversation's literal CodeBlock presentation, selectable text, keyboard-focusable scrolling and copy button. Terminal escapes are literal text, never interpreted as terminal actions or HTML. Scroll following is shared with conversation command output.

## Verification performed

TypeScript: `node_modules/.bin/tsc --noEmit -p tsconfig.json` passed.

Build: `node_modules/.bin/electron-vite build` passed.

Focused suite: `ELECTRON_RUN_AS_NODE=1 COWORK_REQUIRE_SQLITE_TESTS=1 node_modules/.bin/electron node_modules/vitest/vitest.mjs run --pool=threads src/main/kanban src/renderer/src/components/kanban-screen.test.tsx src/renderer/src/components/kanban-command-output.test.tsx src/renderer/src/components/command-output.test.tsx src/main/agent/env/spawn-util.test.ts src/main/agent/env/spawn-util-linux.test.ts` reported 90 passed, 3 skipped (platform-specific process tests). Electron's Node runtime loads the installed native SQLite module without rebuilding or changing shared packages.

The real-process test emits stdout, then stderr after a pause, and exits later with code 7. It asserts both output messages are retained while the child still has no exit code, including output beyond the existing final-capture cap. DOM tests show incremental output in the sidebar before completion, catch-up on reopen, no polling while closed, late-response isolation on card switch, literal markup, copy content, scroll position/following, omission notices, queued/empty/error/unavailable states and routed nonzero exits. SQLite-backed command lifecycle regressions pass, including timeout, startup failure, move, stop, rerun, working directories, overrides and parallel scheduling.

## Remaining manual verification

No full desktop UI session or screenshot was captured. Light/dark appearance, narrow-window layout, native keyboard/focus behavior and end-to-end concurrent live commands should receive interactive QA. DOM tests cover the output presentation and attachment behavior, but are not visual evidence from the running desktop app.
