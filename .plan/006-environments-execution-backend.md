# Execution Environments — selectable backend for agent tools (local / container)

> Status: **NOT STARTED** — design note (2026-06-27). A foundational refactor, not a tool.
> Best landed *before* more machine-touching tools, since retrofitting an interface under each
> new tool gets harder over time. The shape below is a hypothesis to refine before building.

## Context

Today every tool that touches the machine talks to the **host directly**:
- `run_shell_tool` → `child_process.spawn` on the host (`src/main/agent/tools/run_shell_tool.ts`).
- `read/write/edit/list/search` → Node `fs/promises` + `resolveInWorkspace`
  (`src/main/agent/tools/workspace.ts`).

There is no seam: "run locally" isn't a *choice*, it's hardcoded into each tool. We want the
user to select **what backend the agent executes against** — Local (on the machine, as now),
or a **container runtime (Docker / Podman)** for isolation. (We deliberately do **not** need
hermes' ssh/modal/daytona/singularity backends — those exist because hermes runs "anywhere
behind a gateway"; our agent runs on the user's own machine.)

Reference pattern: hermes `environments/` (a `BaseEnvironment` ABC with `local`/`docker`/… and
`ShellFileOperations` that routes file ops through the backend's `execute(command, cwd)`), and
`file_operations.py`. We adopt the *interface idea*, scoped to local + OCI container.

### Why this matters (it's the trust model, not just "supports Docker")

Our entire safety story is the approval gate (`src/main/agent/approval/`). A container changes
the blast radius by construction:
- **Local:** an approved `rm -rf` deletes real files — the gate is the *only* thing between the
  model and the machine.
- **Container:** the agent runs in a sandbox with only the workspace bind-mounted; a bad command
  trashes an ephemeral container, not the laptop. So we can **auto-approve far more** in a
  sandbox, which is what makes unattended North Star runs (and any future background/remote
  trigger) actually safe. **Environments are the prerequisite for safe unattended autonomy.**

Podman note: largely Docker-CLI-compatible, and **daemonless + rootless** (better security story
for this use case). Likely **one "OCI container" backend parameterized by runtime** (`docker` vs
`podman` binary + a few flag differences), not two separate backends.

## Likely implementation shape (hypothesis)

### A. The `Environment` interface (the whole game)
- New `src/main/agent/environments/` with a TS interface, e.g.:
  ```ts
  interface Environment {
    exec(command: string, opts: { cwd: string; timeoutMs: number; signal?: AbortSignal })
      : Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>
    readFile / writeFile / list / search / stat …   // the file-op surface tools need
    resolve(path: string): string                    // workspace-confined path resolution
    dispose(): Promise<void>                          // lifecycle (container stop/cleanup)
  }
  ```
- Open question: do file tools keep using Node `fs` for Local (preserving our nice line paging /
  binary detection / atomic writes) and a shell-based impl for containers? Or go all-shell like
  hermes `ShellFileOperations` (uniform but loses Node-level niceties)? **Leaning: per-backend
  file ops** — Local uses `fs`, Container uses `docker exec` + `cat`/`sed`/`rg` — both behind the
  same interface. Decide before coding.

### B. `LocalEnvironment` (pure refactor, zero behavior change)
- Implement the interface by wrapping exactly what the tools do today (`spawn`, `fs`,
  `resolveInWorkspaceReal`). Land this first with the tools rewritten against `ctx.env` — same
  behavior, fully covered by existing tests. This is the de-risking step.

### C. Tools route through `ctx.env`
- Add `env: Environment` to `ToolContext` (`src/main/agent/tools/types.ts`); `runChat` constructs
  the env from the conversation's chosen backend and injects it (alongside `gate`, `ask`).
- Rewrite the 6 machine-touching tools to call `ctx.env.exec(...)` / `ctx.env.readFile(...)`
  instead of importing `child_process`/`fs` directly. `resolveInWorkspace` moves behind the env.

### D. `ContainerEnvironment` (Docker, then Podman as a runtime flag)
- Workspace is **bind-mounted** into the container (changes flow live — no file-sync subsystem
  needed, which is the win of being local-only). `exec` = `docker exec <id> sh -c …`.
- Lifecycle: start/reuse a container per workspace (or per conversation), image management, and
  `dispose()` on cleanup. The future agent-daemon split would naturally own this lifecycle.

### E. Settings + approval policy
- Surface the backend choice in the settings pane (`.plan/004-settings-pane.md`): per-workspace
  (or global default) Local / Docker / Podman.
- Once sandboxed, loosen the approval policy for container backends (auto-allow a wider command
  set) — the payoff that justifies the whole effort. Local stays strict.

### Interactions with shipped work
- **Stop / `process_registry`:** cancellation must flow through the env — killing a process means
  killing it *in the right backend* (`docker exec` kill vs host kill). Coordinate with
  `.plan/005-stop-inflight-tool-calls.md`.
- **Detection/UX:** if a chosen runtime isn't installed (no `docker`/`podman` on PATH, daemon
  down), fail clearly and fall back to Local with a visible note rather than hanging.

## Out of scope
- ssh / modal / daytona / singularity / cloud backends (hermes-specific; not our predicament).
- File-sync subsystems (bind mounts cover the local-container case).
- The agent-daemon / background-gateway split (its own future effort; this just doesn't preclude it).

## Verification (when built)
- Local backend: all existing tool tests pass unchanged (proves the refactor is behavior-preserving).
- Container backend: a shell command runs inside the container (`hostname` / `cat /etc/os-release`
  differs from host); a file written by `write_file_tool` appears in the workspace on the host via
  the bind mount; `rm -rf` inside the container does **not** touch host files outside the mount.
- Missing-runtime path: with Docker/Podman absent, the app reports it and uses Local.
- `pnpm typecheck` + `pnpm build` clean.

## Status: foundation shipped (2026-06-27)

The `Environment` seam landed with both `LocalEnvironment` and a minimal
`ContainerEnvironment` (`src/main/agent/env/`). All 6 machine-touching tools route through
`ctx.env`; `runChat` builds the backend (env-var selected via `COWORK_ENV_RUNTIME`, default
Local) and disposes it per turn. `Environment.exec` carries a `signal?: AbortSignal` seam.

**`search` is a bulk Environment method, not a tool-side walk.** The first cut had the search
tool walk the tree via `env.readdir`/`stat`/`readFile`; on a container each of those is a
separate `exec` round-trip, so a ~285-file workspace took *minutes* (hundreds of ~300ms calls).
`Environment.search(opts)` fixes this: Local keeps the Node/fs walk (behavior-identical), and
Container runs **one** in-container command — `rg` if present, else a `find … | xargs grep -R`
fallback — bringing the same search to ~0.5s. This is the general lesson: where per-call
overhead makes a per-item loop pathological, the abstraction should expose the bulk operation.

### Follow-ups (deliberately deferred from the foundation PR)
- **Container exec cancellation + timeout (depends on 005).** Killing the host `<runtime> exec`
  client on timeout/abort does **not** stop the in-container process — the inner process keeps
  running. The `signal` parameter is already threaded through `Environment.exec` and the kill is
  wired; only the in-container kill is deferred. Fix alongside 005, e.g. run the command under
  `setsid` and, on abort, `<runtime> exec <name> sh -c 'kill -KILL -<pgid>'` to kill the process
  group. The same host-side-only limitation applies to the exec timeout.
- **Symlink realpath parity in the container.** `ContainerEnvironment.resolve` does the lexical
  guard only (rejects `..`/absolute); it relies on the bind-mount boundary (the container sees
  only `/workspace`) rather than an in-container `realpath`. Full parity with
  `resolveInWorkspaceReal` would run `realpath` inside the container per resolve.
- **Lifecycle.** MVP disposes (stop+rm) the container each turn. A later optimization could keep
  it warm across turns keyed by conversation, trading per-turn startup cost for reuse.
- **`readdir` entry types.** Container `readdir` uses `ls -Ap1` (trailing `/` ⇒ dir, else file).
  Symlinks/sockets are treated as files; `find -maxdepth 1 -printf` would give exact types.
- **Settings + approval policy (E).** Backend choice still comes from an env var, not the
  settings pane (004); the approval policy is unchanged. Loosening auto-approval inside a sandbox
  is the payoff still to come.
