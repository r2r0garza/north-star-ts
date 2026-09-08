---
status: RESOLVED
severity: P2
trigger: "A Local / Host access agent command cannot find Node or pnpm that are available in the user's terminal"
created: 2026-09-04
updated: 2026-09-04
---

# Local Host access commands miss the user's login-shell PATH

## Confirmed behavior

With the execution backend set to **Local** and the Local profile set to
**Host access**, an agent ran:

```sh
pnpm -v && node -v
```

The command completed with exit code 127 and:

```text
/bin/sh: pnpm: command not found
```

The `&&` short-circuited after `pnpm` failed, so this output alone does not
prove that `node` was also unavailable. On the affected host, both commands
resolve in the interactive shell from user-managed locations:

```text
/Users/r2r0garza/Library/pnpm/pnpm
/Users/r2r0garza/.nvm/versions/node/v24.12.0/bin/node
```

This is reproducible when the Electron app is launched from Finder or the Dock
with a GUI `PATH` that omits the user's pnpm and nvm directories. Launching the
app from an already-configured terminal may mask the defect because Electron
then inherits that terminal's environment.

## Root cause

`LocalEnvironment.spawnShell` handles `host-access` by passing the command to
`child_process.spawn` with `shell: true`, no explicit `env`, and the workspace
as `cwd`. On Unix, Node's default shell for `shell: true` is `/bin/sh`. The child
therefore inherits the Electron main process's environment rather than the
user's login-shell `PATH`.

The repository already has `hostCliEnv()`, which preserves `process.env`, reads
and merges the login-shell `PATH`, adds common CLI locations, deduplicates the
result, and caches the login-shell probe. It is used for external agent CLIs,
container runtime checks, and container commands, but not for Local environment
commands. Its fallback paths also do not directly include `~/Library/pnpm` or
nvm version directories, so the login-shell PATH merge is material for this
incident.

The Local profile setting controls where commands execute and what OS sandbox
restrictions apply. It should not cause host commands to lose ordinary CLI
discoverability merely because the desktop app was GUI-launched.

## Impact

- Agents incorrectly report that project runtimes and package managers are not
  installed even though they are available to the user.
- Type checking, tests, builds, and scripts are skipped or fail under Local /
  Host access.
- Behavior varies depending on whether the same app build was launched from a
  terminal or from the macOS GUI.
- The existing host CLI environment normalization gives container and external
  CLI paths different executable discovery behavior from Local `exec_command`.

## Reproduction test

Add focused Local environment tests using an inherited GUI-style environment
whose `PATH` excludes sentinel `node` and `pnpm` directories, plus an injected
or otherwise deterministic normalized host CLI environment that contains them.

Cover both command paths used by agent shell tooling:

1. A quick command executed through `LocalEnvironment.exec` can resolve a
   sentinel executable found only on the normalized host `PATH`.
2. A command executed through `LocalEnvironment.spawnCommand` can resolve the
   same executable for both non-TTY and TTY sessions where supported by the test
   harness.
3. `execFile` receives the same normalized environment rather than reverting to
   the Electron process environment.
4. Login-shell probing failure retains the inherited environment plus safe
   fallback paths and does not make command execution unavailable.
5. An explicit environment override, if the execution API supplies one, retains
   its documented precedence.

Include a macOS-oriented regression assertion that the implementation does not
depend on Finder/Dock providing nvm or pnpm paths. Tests must not depend on the
developer machine's actual Node manager, pnpm installation, or shell dotfiles.

## Proposed direction

1. Resolve `hostCliEnv()` once for a Local environment or command run and pass
   the resulting environment explicitly to every spawned Local command process.
   Do not mutate global `process.env`.
2. Reuse the normalized environment for `exec`, `spawnCommand`, `execFile`, and
   PTY execution so command availability does not vary by capture/session mode.
   Review Local `search` spawning for the same inheritance gap, while retaining
   the packaged ripgrep resolution behavior.
3. Preserve the current shell contract unless a separate change is justified:
   non-TTY captured commands may continue using `/bin/sh`, and user-shell/TTY
   behavior may continue using the selected shell. This issue is about the
   environment supplied to those processes, not changing shell syntax.
4. Keep Local profile enforcement unchanged. `read-only` and `workspace-write`
   must still run through their OS sandbox adapter, and enriching `PATH` must not
   weaken filesystem, network, approval, or command-classification controls.
5. Ensure lifecycle operations and process-group cleanup retain the same child
   handles, cancellation semantics, output caps, and timeouts.

Because resolving the login-shell PATH is asynchronous, prefer an injected,
cached environment dependency or asynchronous initialization at the existing
`createEnvironment` boundary over duplicating shell-startup logic inside each
spawn. Production and fallback construction paths should use the same behavior.

## Acceptance criteria

- [x] A GUI-launched macOS app using Local / Host access can resolve executables
      installed through the user's login-shell PATH, including nvm-managed Node
      and a user-local pnpm installation.
- [x] Quick, session, `execFile`, and TTY command modes use a consistent
      normalized host environment.
- [x] The fix reuses `hostCliEnv()` or a single shared equivalent; it does not
      maintain a second divergent PATH heuristic.
- [x] The Electron process environment is preserved, login-shell paths and safe
      fallbacks are merged deterministically, and explicit supported overrides
      have documented precedence.
- [x] A failed or timed-out login-shell probe degrades to the inherited PATH and
      fallback locations without blocking command execution.
- [x] Container execution, external Codex/Claude CLI discovery, Local sandbox
      enforcement, approvals, cancellation, and output capture do not regress.
- [x] Tests use synthetic environments and executables and pass independently
      of the host's real shell configuration.
- [x] Type checking and the focused Local/host-environment test suites pass.

## Likely files

- `src/main/agent/env/local.ts`
- `src/main/agent/env/host-cli-env.ts`
- `src/main/agent/env/factory.ts`
- `src/main/agent/env/local.test.ts`
- `src/main/agent/env/host-cli-env.test.ts`
- `src/main/agent/tools/command_session_tools.test.ts` if end-to-end session
  wiring needs explicit coverage

## Resolution

Fixed. Two defects, not one.

### The probe never read the file the PATH lives in

`readLoginShellPath` ran `$SHELL -l -c`. A zsh **non-interactive** login shell
sources `.zshenv`, `.zprofile` and `.zlogin` — never `.zshrc`. bash behaves the
same way with `.bashrc`. nvm, pnpm, rbenv and friends install their exports into
the interactive rc file, so the probe returned a PATH with none of them. Measured
on the affected host from a clean GUI-style environment, counting hits for
`Library/pnpm` and `.nvm/versions`:

| probe | hits |
| ----- | ---- |
| `-l -c` (previous behavior) | 0 |
| `-i -l -c` | 2 |

Wiring `hostCliEnv()` into the Local environment without fixing the probe would
have resolved Homebrew and `~/.local/bin` and still failed on `pnpm`.

The probe now tries an interactive login shell first and falls back to the
non-interactive login shell, so a rc file that hangs without a TTY degrades to
the previous behavior rather than to nothing. Because an interactive rc file may
print banners, it emits `env -0` between sentinels and parses only the framed
payload; null delimiting keeps values that contain newlines intact.

### Local commands never received the normalized environment

`LocalEnvironment` passed no `env` to any spawn. `exec`, `spawnCommand`
(non-TTY), and `search` inherited the Electron process environment, and
`execFile` passed `process.env` explicitly. Note this was **not** specific to
`host-access`: the sandboxed branch had the same gap, and since the seatbelt
profile restricts writes and network rather than executable lookup, the fix
applies to all three profiles. The TTY path was already working by accident —
it spawns `$SHELL -lc`, a login shell that re-derives PATH.

`hostCliEnv()` is now resolved once per `LocalEnvironment` (lazily, since the
constructor cannot await and the class is constructed synchronously in ~15
call sites) and passed to `exec`, `execFile`, both `spawnCommand` modes, and
`search`. A failed probe degrades to the inherited environment. An explicit
`execFile` `env` still layers on top.

### Scope decision: full environment, not just PATH

`hostCliEnv()` now merges the login shell's whole environment over the inherited
one, not only `PATH`, so `PNPM_HOME`, `NVM_DIR`, `JAVA_HOME` and similar reach
agent commands. Shell bookkeeping (`PWD`, `OLDPWD`, `SHLVL`, `_`, `TERM`,
`TMPDIR`) is excluded, and `PATH` keeps its ordered merge.

This deliberately also reaches the Claude and Codex CLI providers, which receive
`hostCliEnv()` as their complete environment and pass it down to everything they
spawn. Those CLIs read environment variables as configuration, so a user who
exports `ANTHROPIC_BASE_URL` in their shell will now have the embedded provider
honor it — matching what happens when they run the CLI in their own terminal.
That was the intended outcome, not a side effect.

### Known limits

The fix covers executable discovery and exported variables. It does not make
agent commands equivalent to the user's terminal:

- **Shell functions are not importable.** `nvm` is a function sourced from
  `nvm.sh`, so `nvm use` still fails regardless of PATH. Same for
  `conda activate`, `pyenv shell`, and aliases. Version-manager *shims* work,
  because they are real directories on PATH.
- **Per-directory environments do not apply.** direnv `.envrc`, `.nvmrc`
  auto-switching and mise/asdf hooks fire from interactive shell hooks in the
  user's own session, not in a `/bin/sh -c` child.
- **Shell dialect is unchanged.** Captured commands remain `/bin/sh -c`, so
  zsh-only syntax still fails, per the direction above.

### Follow-up: PATH precedence

The first cut of this fix appended the login-shell PATH after the inherited one,
and the limitation was recorded rather than fixed. It surfaced within a day: an
agent version check reported `Python 3.9.6` where the user's terminal reports
`3.12.13`. The GUI PATH always contains `/usr/bin`, so every tool with a
system-wide twin resolved to the system copy. `node` and `pnpm` masked the
problem because macOS ships neither.

The login-shell PATH now comes first, then the inherited PATH, then the
fallbacks. An rc file that writes
`export PATH="$(brew --prefix)/opt/python@3.12/libexec/bin:$PATH"` is expressing
a preference, and honoring its order is what makes agent commands agree with the
terminal. Verified from a GUI-style base PATH: `python3 --version` → 3.12.13
(`/opt/homebrew/opt/python@3.12/libexec/bin/python3`), `node` → v24.12.0,
`pnpm` → 10.28.0, `npm` → 11.6.2 — all matching the user's shell.

### Verification

`buildHostCliEnv` and `parseProbeOutput` have unit coverage for the merge,
exclusions, and banner/truncation handling. `local.test.ts` covers `exec`,
`execFile` (including override precedence), both `spawnCommand` modes, probe
failure, per-instance memoization, and the sandboxed profile, using a synthetic
sentinel executable and injected environment — no dependency on the host's real
shell configuration. Typecheck passes and the full suite is green (1096 passed).

Confirmed live on the affected host: with a GUI-style base `PATH` of
`/usr/bin:/bin:/usr/sbin:/sbin`, the probe now yields
`~/.nvm/versions/node/v24.12.0/bin` and `~/Library/pnpm` on `PATH`, plus
`PNPM_HOME` and `NVM_DIR`.
