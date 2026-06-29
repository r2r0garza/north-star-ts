# PR10: Container runtime profiles — decouple Workspace from Runtime

> Status: **NOT STARTED** — design note (2026-06-29). A small, deliberate evolution of the
> container backend shipped in `.plan/006`. The goal is to **kill a bad architectural assumption
> now** ("one workspace = one container image forever") while keeping the implementation simple —
> *not* to build image management or auto-routing. Starting hypothesis, not a locked spec.

## Context

The container backend (`.plan/006`, shipped) currently threads a single raw `image: string`
through the stack: `ExecutionSettings.image` → `getExecutionConfig()` → `EnvConfig` →
`ContainerEnvironment({ runtime, image, workspace, conversationId })`
(`src/main/agent/env/factory.ts:8-31`, `settings/service.ts:175-186`). The default is
`node:20-bookworm`. This quietly bakes in **"one workspace = one image"** — which won't hold up.

The fix is conceptual, then mechanical. **Separate two concepts that are currently conflated:**
- **Workspace** = the files/repo the agent works on (already its own entity — `workspaces` table,
  bind-mounted into the container).
- **Runtime** = the environment a *tool call* executes in (today: a single hardcoded-ish image).

A single workspace can need **multiple runtimes** over its life:
1. Agent writes/runs a **Python** script for a task → needs a Python runtime.
2. Agent writes/runs a **JS** script to build an artifact → needs a Node runtime.
3. User starts with a **Node frontend** repo, then asks to add a **Python backend** → a Node-only
   image is no longer enough.

We don't solve multi-runtime *routing* now. We just stop assuming it can't happen — by replacing
the raw `image` string with a named **runtime profile**, and defaulting to `fullstack` (Node +
Python) when unsure so case 3 doesn't wedge.

## Scope — what this PR does and explicitly does NOT do

**Does (V1):**
- Keep the current backend abstraction (`Environment`, Local + Container) unchanged in shape.
- Introduce a **runtime profile** concept: `"node" | "python" | "fullstack"`.
- Extend `ContainerEnvironment` config to `{ runtime, profile, workspaceId, workspacePath }`
  (profile resolves to a concrete image).
- One selected profile **per conversation/task** (the existing per-conversation granularity).
- Ship a real **`fullstack`** image as the **default/fallback** when both Node and Python may be
  needed.
- Let the **user override** the profile (settings + per-conversation).

**Does NOT (deferred — see Later):**
- Automatic per-command / per-tool-call runtime routing.
- Multiple warm containers per workspace (keyed by workspaceId+profile+runtime).
- A `browser` profile (Playwright) — named here only so the enum/shape anticipates it.
- Full image management (building, pinning, registries, versioning).

## Runtime profiles (V1)

| profile     | tooling                                              | default image (hypothesis) |
|-------------|------------------------------------------------------|----------------------------|
| `node`      | node, npm, pnpm, yarn, git, rg                       | `node:20-bookworm` (+ rg)  |
| `python`    | python, pip, uv, git, rg                             | a python:3.x-bookworm (+ uv, rg) |
| `fullstack` | node + python + git + rg + common build tools        | a combined image           |

- A **profile → image** resolver lives in one place (the env factory). Profiles are the user-facing
  concept; images are an implementation detail (so we can repin/rebuild images without touching the
  config surface or the DB).
- `fullstack` is the **default and the unsure-fallback**. The exact images are a build/ops
  question (Q3); V1 may start from public base images + a small provisioning step, or a prebuilt
  combined image — decide before coding, but don't let it balloon into image management.

## Desired shape

```ts
new ContainerEnvironment({
  runtime: "docker" | "podman",
  profile: "node" | "python" | "fullstack",   // (browser later)
  workspaceId,
  workspacePath,
})
```

## Open questions to resolve BEFORE building

1. **Config migration: replace `image` with `profile`, or carry both?**
   `EnvConfig`'s container variant is `{ kind:"container"; runtime; image }` and
   `ExecutionSettings` persists `image`. Proposal: the *config* surface speaks `profile`; the env
   factory resolves `profile → image` internally. Keep an **escape hatch** for a raw image
   (advanced/override) so we don't lose the ability to point at a custom image — e.g.
   `{ profile: "fullstack" } | { image: "custom:tag" }`. Decide whether the persisted
   `ExecutionSettings.image` field is migrated to `profile` (settings is a JSON blob in the v4
   store — *no DB migration needed*, just a field change + a read-time fallback mapping an old
   `image` value to the closest profile).

2. **Where does profile selection live — global default vs per-conversation?**
   Per-conversation model selection already exists (`SCHEMA_V6`: `conversations.account_id` /
   `model_id`). Mirror it: a global default profile in `ExecutionSettings`, overridable
   per-conversation. Decide if per-conversation needs a `conversations.runtime_profile` column
   (v7 migration) now, or if global-only is enough for V1 with per-conversation deferred. **Lean:**
   global default + a settings dropdown in V1; per-conversation override is a small follow-up
   unless trivial to add alongside.

3. **The `fullstack` image — prebuilt or provisioned?** (the only real "ops" risk in this PR.)
   Options: (a) a single prebuilt combined image we reference by tag; (b) start from a base image
   and `apt-get`/`uv`/`npm i -g` the tools on first start (slower start, no image to host).
   **Lean (a)** for predictability, but keep it OUT of scope to *build a pipeline* — just pick the
   tag/recipe. Don't let this become image management.

4. **What happens on profile change mid-conversation?** If the user switches profile, the next turn
   builds a container from the new profile. Since V1 disposes the container per turn (006 MVP) or
   reuses per conversation, define: a profile change tears down the old container and starts the
   new one. (Trivial under per-turn dispose; note it for the future warm-container work.)

5. **Local backend interaction.** Profiles are a *container* concept. Local has no profile (it's
   "the host, as-is"). Confirm the config cleanly expresses "local (no profile)" vs "container +
   profile" — likely the existing `EnvConfig` discriminated union, with `profile` only on the
   container arm.

## Likely implementation shape (hypothesis — revisit after Q1)

### `src/main/agent/env/factory.ts`
- Add `RuntimeProfile = "node" | "python" | "fullstack"` (reserve `"browser"` in a comment).
- Change the container `EnvConfig` arm from `{ image }` to `{ profile }` (plus an optional raw
  `image` escape hatch per Q1).
- Add a `profileToImage(profile): string` resolver (the single source of profile→image truth) +
  the `DEFAULT_PROFILE = "fullstack"`.
- `createEnvironment` passes `profile` + `workspaceId`/`workspacePath` into `ContainerEnvironment`.

### `src/main/agent/env/container.ts`
- `ContainerConfig` gains `profile` and (rename for clarity) carries `workspaceId` +
  `workspacePath`. The constructor still resolves the concrete `image` (via the factory's resolver
  or a passed-through image). Container **naming** can incorporate profile now
  (`cowork-env-<workspaceId>-<profile>`) so the *future* multi-warm-container work (keyed by
  workspaceId+profile+runtime) is a natural extension, not a rename — but V1 still runs **one
  selected profile at a time**.
- No change to exec/file-op/search behavior — same `Environment` surface. **File tools still
  operate against the selected environment** (unchanged: they go through `ctx.env`).

### `src/main/settings/service.ts` + settings UI
- `ExecutionSettings`: replace/augment `image` with `profile` (JSON blob — no migration); read-time
  fallback maps a legacy `image` to a profile. `getExecutionConfig()` emits the container arm with
  `profile`.
- Settings pane: a **Runtime profile** dropdown (Node / Python / Fullstack), defaulting to
  Fullstack, shown when the backend is Docker/Podman. This is the **user override**.
- `envConfigFromEnv()` dev override: add `COWORK_ENV_PROFILE` alongside `COWORK_ENV_RUNTIME`
  (keep `COWORK_ENV_IMAGE` as the raw escape hatch).

## Verification (when built)
- **Profile drives tooling:** with `profile: "python"`, `run_shell_tool` running `python --version`
  / `uv --version` succeeds inside the container; with `profile: "node"`, `node`/`pnpm` succeed.
- **Fullstack default:** an unset/"unsure" config resolves to `fullstack`; both `node --version`
  and `python --version` succeed in the same container (case 3 — Node repo that adds a Python
  backend — works without reconfiguration).
- **User override:** changing the Runtime profile in settings changes which tools are available on
  the next turn; a profile change tears down/rebuilds the container (Q4).
- **File tools unaffected:** `write_file_tool` output still appears on the host via the bind mount,
  regardless of profile; `read/search` behave identically.
- **Local unchanged:** Local backend ignores profile; all existing Local tool tests pass.
- **Legacy config fallback:** a persisted `ExecutionSettings.image` from before this PR maps to a
  sensible profile (no crash, no migration).
- `pnpm typecheck` + `pnpm build` clean; container tests updated for the new config shape.

## Later (explicitly out of scope here)
- **Runtime auto-routing** per command/tool call (detect "this is a python script" → python
  runtime) — the real multi-runtime feature; this PR only makes it *possible*.
- **Multiple warm containers per workspace**, keyed by `workspaceId + profile + runtime` — the
  container naming in V1 anticipates this; the lifecycle/pool does not exist yet (ties into the
  006 warm-container follow-up).
- **`browser` profile** for Playwright/browser work — reserved in the enum/shape only.
- **Full image management** — building/pinning/registry/versioning pipelines.

## Out of scope (this effort entirely)
- Anything in the 006 deferred list not named above (symlink realpath parity, readdir entry types,
  container exec cancellation — that last one is `.plan/005.1`).
- Auto-routing and multi-warm-container (see Later — named so the shape anticipates them, but not
  built).
