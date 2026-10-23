# PR129: Qualify Electron app control (PR119) on Linux

> Status: **PLANNED — not started.** Created 2026-10-23 when [PR119](119-electron-application-control.md) was completed with macOS-only qualification. Scope is qualification plus the fixes it requires; no new capability.

## Objective

Run PR119's development-target capability on Linux and either qualify it or record precise unsupported states. Done means `node scripts/qualify-electron-apps.mjs` passes, with the North Star case enabled, on:
- at least one X11 desktop;
- one Wayland desktop;
- headless Xvfb (the CI-shaped case).

Ubuntu 24.04 is the baseline. The record is added to PR119's qualification notes, and nothing is claimed from macOS evidence.

## Known gaps to resolve

- **Display.** The live tests skip without `DISPLAY`. Establish the supported setups: X11, Wayland via XWayland or native Ozone, and `xvfb-run`. If no display is available, launch must return an actionable error instead of timing out.
- **Chromium sandbox.** Workspace Electron often fails with "SUID sandbox helper … not configured correctly", or under Ubuntu 24.04's AppArmor restriction on unprivileged user namespaces. `--no-sandbox` is rejected by design and must stay rejected. Detect this startup failure from the logs and return an actionable error that names the fix (the `chrome-sandbox` owner and mode, or the AppArmor/userns setting), without weakening the target.
- **Child environment.** `PASSTHROUGH_ENV` has `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY` and `XDG_RUNTIME_DIR`. Establish whether `DBUS_SESSION_BUS_ADDRESS`, `XDG_SESSION_TYPE` or locale variables are needed for a working app. Add only what is needed, and keep provider keys and `NODE_OPTIONS`/`ELECTRON_*` out.
- **Test-instance contract.** Verify userData (`~/.config/<name>`), `os.homedir()` callers and `~/.<system>` dirs all land in the test profile, and that `personalDirs()` in the live test and `scripts/qualify-electron-test-instance.mjs` check the real Linux locations.
- **Process groups.** Confirm the `detached` process-group teardown reaches every child (dev servers, zygote and GPU helpers), and that a host crash closes the pipe and the target exits.
- **Input and capture.** Confirm CDP input, focus emulation for hidden or unfocused windows, `Page.bringToFront` for handoff, and the screenshot device-scale calculation on X11, Wayland and Xvfb. Record any difference.
- **Native modules.** Confirm the `with-node-sqlite.mjs` / `electron-rebuild` swap works, and that the North Star case runs outside the Node-ABI window.

## Verification

On each target setup, after `pnpm install` and `pnpm build`:
- `node scripts/qualify-electron-apps.mjs`
- typecheck and the full suite
- the macOS manual prompt set on the desktop setups

Record in PR119's notes:
- distro, kernel, display server, Node, Electron and the backend;
- the sandbox configuration used;
- pass/fail per check;
- cleanup results;
- what stays unsupported.

## Out of scope

Packaged targets (PR120), native OS input, menus and dialogs (handoff covers them), and Windows (PR128).
