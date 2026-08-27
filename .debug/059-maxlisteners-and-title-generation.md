---
status: resolved
trigger: "MaxListenersExceededWarning for WebContents destroyed listeners, and conversation title generation appears broken"
created: 2026-08-27
updated: 2026-08-27
---

## Symptoms

- Expected: renderer subscriptions mount and unmount without accumulating `WebContents` listeners.
- Actual: Electron warns after 11 `destroyed` listeners are added to one `WebContents`.
- Error: `(node:4885) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 destroyed listeners added to [WebContents].`
- Expected: a new conversation receives a generated title from its first message.
- Actual: conversations started through the durable background-task path remain untitled.

## Current Focus

- hypothesis: IPC unsubscribe removes service subscriptions but leaves each `destroyed` listener attached; task-event subscriptions also lack renderer-side reference counting. Background sends bypass `runChat`, the only path that currently titles a source conversation.
- test: Repeated subscribe/unsubscribe must leave zero `destroyed` listeners, concurrent task-event consumers must keep one main subscription until the last consumer leaves, and `task:start` must title an untitled source conversation.
- expecting: Listener counts remain bounded and both live and background-created conversations receive titles.
- next_action: Resolved; monitor a restarted development session for recurrence.
- reasoning_checkpoint: Repository inspection and git history identify concrete lifecycle and routing gaps; raising MaxListeners would only hide the leak.

## Evidence

- timestamp: 2026-08-27
  observation: `terminal:unsubscribe` and `task:unsubscribe` delete subscription map entries without removing their corresponding `sender.once("destroyed", ...)` listeners.
- timestamp: 2026-08-27
  observation: Eight renderer components call `tasks.onEvent`, but the preload invokes global `task:subscribe` and `task:unsubscribe` for every individual consumer with no reference count.
- timestamp: 2026-08-27
  observation: Live sends call `runChat`, which generates a title; `task:start` calls `runner.enqueue` directly and never titles the source conversation.

## Eliminated

- hypothesis: Electron's default listener limit is simply too low.
  reason: Listeners are accumulated across unsubscribe/resubscribe cycles and are not removed, so increasing the limit would conceal unbounded growth.

## Resolution

- root_cause: Explicit IPC unsubscribe paths removed service callbacks but retained one-shot `WebContents.destroyed` listeners. Task-event consumers also independently subscribed/unsubscribed a single global main-process stream. The durable background start path bypassed `runChat`, so it never titled the source conversation.
- fix: Store and remove each `destroyed` callback during unsubscribe; reference-count task-event consumers in preload; generate and persist a source title when `task:start` begins from an untitled conversation.
- verification: 15-cycle listener regression tests pass; preload reference-count and background-title tests pass; full suite reports 742 passed and 394 skipped; TypeScript and production Electron build pass; Prettier and `git diff --check` pass.
- files_changed: src/main/ipc/terminal-handlers.ts, src/main/ipc/task-handlers.ts, src/preload/index.ts, src/main/agent/index.ts, src/main/ipc/subscription-handlers.test.ts, src/preload/index.test.ts
