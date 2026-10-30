# PR128: Qualify Electron app control (PR119) on Windows

> Status: **PLANNED — not started.** Created 2026-10-23 when [PR119](119-electron-application-control.md) was completed with macOS-only qualification. Scope is qualification plus the fixes it requires; no new capability.

## Objective

Run PR119's development-target capability on Windows and either qualify it or record precise unsupported states. Done means `node scripts/qualify-electron-apps.mjs` passes on Windows 11 x64 (arm64 too if a machine is available) with the North Star case enabled. The record is added to PR119's qualification notes. Nothing is claimed from macOS evidence.

## Known gaps to resolve

- **Process-tree teardown.** `killGroup` in `src/main/electron-apps/manager.ts` kills only the main process on Windows (marked `shortcut:`), so helpers and dev servers a target spawns can survive. Implement owned-tree teardown — a Job Object, or `taskkill /T /F /PID` against the verified, still-owned child pid — and never kill by name. The live test "stops the app's child processes on close" spawns `sleep`; give it a Windows equivalent.
- **Pipe transport.** Confirm Electron on Windows honors `--remote-debugging-pipe` with Node's extra stdio pipes (fd 3/4 as inherited handles). If it does not, record the alternative (for example Chromium's handle-passing flag), and keep the rule: no TCP debugging port.
- **Test-instance contract.** `src/main/config/test-instance.ts` sets `USERPROFILE` and `app.setPath("home")`. Verify every per-user path North Star resolves on Windows (`%APPDATA%` userData, `os.homedir()` callers, `~/.<system>` dirs) lands in the test profile.
- **Child environment.** `PASSTHROUGH_ENV` has `PATH`, `TEMP`, `TMP` and `SystemRoot`. Establish what a Windows Electron app minimally needs (`windir`, `ComSpec`, `PATHEXT`, `LOCALAPPDATA` …), add only that, and keep provider keys and `NODE_OPTIONS`/`ELECTRON_*` out.
- **Paths.** Drive letters, case-insensitive and UNC paths through `resolveInWorkspaceReal` and `realpath`; `path.txt` resolving to `electron.exe`; the `PACKAGED` pattern (`.exe` entries) must not reject a development entry by mistake.
- **Qualification scripts.** In `scripts/qualify-electron-test-instance.mjs`, `join(homedir(), process.env.APPDATA ?? …)` is wrong when `APPDATA` is absolute. The live test's `personalDirs()` lists only macOS/Linux locations. Both must check the real Windows profile locations.
- **Native modules.** Confirm the `with-node-sqlite.mjs` / `electron-rebuild` swap and its recovery behave on Windows, and that the North Star case runs outside the Node-ABI window.
- **Startup reconciliation.** `reconcile()` uses pid liveness; confirm it is reliable on Windows and leaves another live host's profiles alone.

## Verification

Run on a clean Windows 11 checkout after `pnpm install` and `pnpm build`:
- `node scripts/qualify-electron-apps.mjs`
- typecheck and the full suite

Then manually run the prompts used for the macOS check (launch/close, interaction, consequential approval, `electron_run` check file, failure evidence, multi-window, handoff, unsafe flag and packaged refusals, Stop and the Stop bar).

Record in PR119's notes:
- OS build, Node, Electron and the backend;
- pass/fail per check;
- child-process cleanup results;
- what stays unsupported.

## Out of scope

Packaged targets (PR120), native OS input, menus and dialogs (handoff covers them), and Linux (PR129).
