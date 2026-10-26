# Roadmap — Closed decisions

Questions from [ROADMAP-OPEN-DECISIONS.md](ROADMAP-OPEN-DECISIONS.md) that have been answered, with the answer
and the date, newest first.

- **2026-10-24 — Browser storage for workflow steps ([PR130](130-workflow-browser-and-electron-tools.md)).**
  Isolated per run: every browser-enabled step of one run shares an in-memory partition
  (`workflow-run-<runId>`), so a login from step 1 is visible to step 2. Runs never share storage with each
  other or with the chat browsing profile (`persist:agent-browser`), and nothing persists after the app quits.
