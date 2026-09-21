# PR101: Browser chrome sandbox hardening

> Status: **DEFERRED**. Evaluate enabling Electron sandboxing for the trusted browser-chrome renderer, whose preload currently uses only `contextBridge` and `ipcRenderer`, while retaining the documented main-window tradeoff.

## Goal

Reduce renderer compromise blast radius where the preload contract permits sandboxing, without breaking browser tabs, chrome IPC, development loading, or packaged builds.

## Current state

- The untrusted page `WebContentsView` is sandboxed and isolated.
- The primary application window uses `sandbox: false` because its preload exposes `webUtils.getPathForFile` for file drops.
- The browser-chrome `BrowserWindow` also uses `sandbox: false`, but its preload appears limited to `contextBridge` and `ipcRenderer`, making it the better near-term candidate.

## Activation condition

Schedule with an Electron security review or browser-window change, with time for packaged-app smoke testing on supported platforms.

## Required plan/analysis pass

Verify Electron-version behavior for sandboxed preloads, explicit `contextIsolation`/`nodeIntegration` defaults, IPC sender validation, navigation/window-open restrictions for the chrome window, dev-server and packaged file loading, and whether any transitive preload dependency requires Node capabilities unavailable in the sandbox. Decide separately for the main and browser-chrome windows.

## Acceptance

- Browser chrome runs with the strongest compatible explicit web preferences.
- Navigation, reload, close, pick mode, tab activation, and event subscriptions work in development and a packaged build.
- The untrusted page view remains separately sandboxed with no preload.
- Main-window sandboxing is not claimed or changed unless file-drop behavior has a tested replacement.
- Security-relevant window defaults are explicit and covered by focused tests where practical.

## Likely files

- `src/main/browser/window.ts`
- `src/preload/browser-chrome.ts`
- Browser window/preload tests and packaging smoke checklist

## Out of scope

- Removing the primary window's file-drop capability.
- Treating the trusted browser chrome as the same security principal as untrusted page content.
