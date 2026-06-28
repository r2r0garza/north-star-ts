# Cowork — Settings Pane (SHIPPED)

> Status: **SLICE 1 SHIPPED** (commit `213654e`) + **LLM SLICE SHIPPED** (branch
> `feat/settings-pane`) — settings store + execution backend + sandbox-aware approval, and now the
> multi-provider LLM layer (provider accounts, safeStorage-encrypted keys, dual-source model
> management, composer model picker). Builds on the SQLite layer (`001`), the approval pipeline
> (`002`), and the `Environment` abstraction (`006`).
>
> **What shipped (LLM slice — expanded from the original single-key/single-model draft):**
> - **`SCHEMA_V5`** — two tables: `provider_accounts` (provider, display_name, base_url,
>   `encrypted_key` BLOB, timestamps) + `models` (account_id FK `ON DELETE CASCADE`, model_id,
>   `model_name` optional custom label, `origin` manual|gateway|seeded, `UNIQUE(account_id,
>   model_id)`). Repos: `provider-accounts.ts` (ciphertext never leaves the repo — public shape
>   exposes `hasKey` only; raw blob via `getEncryptedKey` for the secrets layer) + `models.ts`
>   (`mergeGatewayModels` upserts gateway ids, never clobbering manual/seeded rows).
> - **`src/main/settings/secrets.ts`** — strict Electron `safeStorage`. Encrypt on save, store
>   ciphertext only, decrypt only in main. **No plaintext fallback** — throws
>   `SafeStorageUnavailableError` so the UI shows a clear error. **Env is no longer a runtime
>   fallback**; `getMaskedApiKey` returns `••••abcd` for the renderer (plaintext never crosses IPC).
> - **`src/main/agent/providers/index.ts`** — routing layer. `getActiveClient()` resolves the
>   active account+model, decrypts the key in-process, builds + caches a Portkey client (Portkey
>   and `openai_compatible` share the SDK). `invalidate()` on any credential/selection change,
>   wired via `settingsService.setLlmChangeListener`. `fetchGatewayModelIds` for the optional
>   import. `hasActiveProvider()` gates the UI. Old env-keyed `getClient()`/`MODEL` singleton removed.
> - **Settings service** — `llm` blob (`{ activeAccountId, activeModelId }`) holds the **default**
>   provider/model for new conversations + `getLlm`/`setLlm` + the change-listener hook.
> - **Per-conversation selection (`SCHEMA_V6`)** — nullable `account_id`/`model_id` columns on
>   `conversations` so each session keeps its own model (a Chat on provider A, a North Star on
>   provider B). `resolveLlm({accountId, modelId})` falls back to the default per-field; clients
>   are cached per account id. The composer picker spans **all** providers' models (grouped by
>   provider) and persists the choice onto the conversation (carried into create() for a new one);
>   reopening a conversation restores its model. The Settings "active" control is now the
>   **default**, not a global switch.
> - **`src/main/settings/bootstrap.ts`** — `seedProviderFromEnvIfEmpty()` migrates a pre-settings
>   `NEXT_apiKey`/`PORTKEY_API_KEY` into a seeded Portkey account on first boot (no-op once any
>   account exists), so existing dev setups keep working without re-entering the key.
> - **IPC + preload** — `providers:*` (list/listWithModels/create/update/delete,
>   setKey/clearKey/getMaskedKey, secureStorageAvailable, getDefault/setDefault, hasActive) +
>   `models:*` (list/add/update/delete, importFromGateway) + `db:conversations:*` extended with
>   `accountId`/`modelId`. `window.cowork.providers` / `.models`; types re-exported via `@/types`.
> - **Renderer** — `llm-settings.tsx` (Providers tab: accounts CRUD, masked key with replace/clear,
>   provider dropdown with disabled "coming soon" entries, active-provider select; Models tab:
>   manual add/edit/delete with custom `model_name`, gateway import, origin badges, pick-active).
>   Settings sheet gained **Providers/Models** tabs (open-to-tab via `initialTab`). Composer
>   (`App.tsx`) gained an inline **model picker**; Send is gated on an active provider; first
>   launch with nothing configured auto-opens Settings → Providers.
>
> Verified: `pnpm typecheck` + `pnpm build` clean; **133 tests** pass (2 new service tests; new
> provider-accounts/models/conversations repo tests run under Electron, skipped in plain-node
> vitest like all DB repo tests). Q1 resolved **safeStorage (strict)**, Q3 resolved **both**
> (user-maintained source of truth + optional gateway import). Selection scope resolved
> **per-conversation, persisted**, with the Settings selection as the **default for new sessions**.
>
> **What shipped (slice 1):**
> - §A Settings store — `SCHEMA_V4` `settings` table + `repositories/settings.ts` + barrel export.
> - §B (trimmed) `src/main/settings/service.ts` — cached, typed, defaults match prior behavior.
>   **No safeStorage / API-key handling yet** (that's the LLM slice).
> - §D File-permission classifier reads settings live (auto | require_approval per kind).
> - §E IPC + preload — `settings:*` channels + `window.cowork.settings` namespace.
> - §F (partial) `settings-sheet.tsx` — **Backend / Permissions / Sandbox** tabs + gear trigger.
>   The **Provider/Model and API-Key tabs are NOT built** (LLM slice).
> - §G Execution backend choice + sandbox-aware approval downgrade (the 006-E payoff). Mechanism
>   landed in the **PolicyEngine**, not the classifier — see the corrected §G below.
> - Runtime preflight `src/main/agent/env/runtime-check.ts` (docker/podman availability).
>
> **What's still pending (LLM slice — next):**
> - §C Agent reads LLM settings (dynamic provider/model, `getClient()` invalidation).
> - §B safeStorage API-key encryption + `getResolvedApiKey()`.
> - §F Provider/Model + API-Key tabs in the sheet; `settings:getLlm/setLlm/hasApiKey` channels.
> - Open question Q1 (key storage) and Q3 (model list source) still apply to that slice.
>
> Verified for slice 1: `pnpm typecheck` + `pnpm build` clean; **131 tests** pass (19 new),
> including the sandbox-downgrade safety tests; manually tested in `pnpm dev` (backend switch,
> hot permission toggle, runtime preflight, sandbox onboarding, sheet close).

## Context

Everything the user might want to tune is currently hardcoded or env-only, with no UI:
- **Model / provider / endpoint** are constants in `src/main/agent/index.ts` — `MODEL =
  "@aws-bedrock-use2/us.anthropic.claude-sonnet-4-6"`, the Portkey `baseURL`, and the provider
  itself are baked into `getClient()`.
- **API key** comes only from `process.env.NEXT_apiKey ?? process.env.PORTKEY_API_KEY`, loaded
  from `.env.local` at boot (`src/main/index.ts`). There's no way to set it from the app.
- **Tool permissions** are fixed in code: `FileActionClassifier` (`src/main/agent/approval/
  file-classifier.ts`) always returns `allow`, so file writes/edits never prompt. There's no
  switch to make "edit_file requires approval".
- **Execution backend** (Local vs. Docker/Podman container) is now selectable, but only via the
  `COWORK_ENV_RUNTIME` env var — there's no UI. The `Environment` abstraction shipped in
  `.plan/006` (foundation A–D); its **section E — surface the backend choice here + loosen the
  approval policy inside a sandbox — was deliberately deferred to this pane.** See §G below.

This phase adds a **Settings pane** so the user can, from the UI: pick the LLM provider (only
Portkey today, but the model is future-proofed for more), choose the model from a maintained
list, set their API key, and flip tool-permission policies (e.g. file edits require approval or
not). It introduces the app's first **persisted settings store** and makes the agent read its
provider/model/permissions from that store at runtime instead of from constants.

Key facts established by exploration:
- ~~No settings table exists~~ → **SHIPPED as `SCHEMA_V4`** (the schema was already at V3/todos
  by the time this was built, so the settings table is V4, not V3 as originally drafted below).
- **`getClient()` is a lazy singleton** keyed on nothing — it reads env once and caches. It must
  become settings-aware and invalidatable when settings change. **(Still pending — LLM slice.)**
- **`policy` and its classifiers are built once at module load** (`agent/index.ts`). Confirmed and
  preserved: the engine is still built once; the file classifier and sandbox policy read settings
  via injected getters *at decision time*, so toggles apply with no restart.
- **Renderer settings surface** — `settings-sheet.tsx` shipped with Backend/Permissions/Sandbox
  tabs and a gear in the sidebar footer (`main.tsx` holds `settingsOpen`). All primitives used
  (`sheet`, `tabs`, `switch`, `select`, `field`, `dialog`) exist as expected.

## Open questions to resolve BEFORE building (decide first)

> **Resolved by slice 1:** Q2 (hot apply — **yes**, getters read at point-of-use), Q4 (permission
> scope — file_write/file_edit toggles shipped; **shell is handled via the sandbox category
> mechanism in §G**, not a blanket shell toggle), Q5 (**global scope**), Q6 (**Sheet** from a
> sidebar-footer gear). **Still open for the LLM slice:** Q1 (API-key storage) and Q3 (model list).

1. **API-key storage / security — the key fork.** *(STILL OPEN — LLM slice.)* Plaintext in SQLite is a credential-leak risk
   (the DB file is unencrypted under `userData`). Options:
   - **a) Electron `safeStorage`** (OS keychain–backed): encrypt the key, store the ciphertext
     blob in the settings row. Decrypt in main only, never expose the plaintext to the renderer
     (the UI shows a masked "•••• set" state + a "replace" action). **Recommended.**
   - **b) Plaintext in the settings table** — simplest, but the key sits readable on disk.
   - **c) Keep the key in `.env.local`** and let Settings only *display* whether one is present,
     not set it. Avoids storing secrets but doesn't meet the "let them set their API key" goal.
   **Precedence with env:** if a key is set in Settings AND in env, which wins? Recommendation:
   an explicit Settings key overrides env; env remains the fallback when Settings is empty (keeps
   current dev setup working).
2. **Hot vs. cold apply.** ✅ **RESOLVED — hot.** Settings read at point-of-use via injected
   getters (file classifier, sandbox policy, `getExecutionConfig`). The Portkey-client
   invalidation half belongs to the LLM slice.
3. **Model list source.** *(STILL OPEN — LLM slice.)* Portkey model ids are gateway aliases;
   there's no enumerated catalog in the code. Options: (a) a **user-maintained list** of model
   ids in Settings — simplest; (b) fetch a catalog from the gateway — defer. Recommendation: (a).
4. **Permission toggles — scope for V1.** ✅ **RESOLVED.** Shipped per-file-kind policy
   (`file_write`, `file_edit` → `auto | require_approval`). **Shell is not a blanket toggle** —
   instead the sandbox auto-approve mechanism (§G) downgrades shell commands *by category*
   (`destructive_fs`, `history_rewrite`, …) and only inside a container; the hardline tier is
   never bypassed.
5. **Settings scope.** ✅ **RESOLVED — global** (the `settings` table has no scope column; can
   grow one later if per-workspace overrides are needed).
6. **Settings surface.** ✅ **RESOLVED — Sheet** from a sidebar-footer gear, with `tabs`. No new
   `VIEWS` entry.

## Likely implementation shape (hypothesis — revisit after Q1/Q4)

Assuming **safeStorage key + hot apply + user-maintained model list + file-kind toggles + global
scope + Sheet UI** as the leading hypothesis.

### A. Settings store (schema + repo) — ✅ SHIPPED
- **`migrations.ts`** — appended **`SCHEMA_V4`** (the schema was at V3/todos, so the settings
  table is V4). Reaches `user_version 4`. Key-value-of-JSON table as drafted:
  ```sql
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,   -- e.g. "execution", "permissions"
    value      TEXT NOT NULL,      -- JSON blob
    updated_at INTEGER NOT NULL
  );
  ```
- **`src/main/db/repositories/settings.ts`** — `getSetting(key)`, `setSetting(key, value)` (upsert
  via `ON CONFLICT`), `getAll()`. **Repo stores raw strings**; JSON (de)serialize lives in the
  service (a deliberate change from the original draft — keeps the table a dumb blob store).
  Exported from the barrel as `export * as settings`.
- *(Deferred to LLM slice:* the safeStorage-encrypted API key inside an `llm` blob.*)*

### B. Settings service (single read point + cache) — ✅ SHIPPED (execution + permissions only)
- **`src/main/settings/service.ts`** — thin main-process service over the repo. Caches parsed
  blobs in memory; refreshes on write. Defaults baked in so a fresh install behaves exactly like
  before. Shipped surface:
  - `getExecution()` / `setExecution()` and `getExecutionConfig()` — maps the `execution` blob to
    the env factory's `EnvConfig`; **falls back to `envConfigFromEnv()` (the `COWORK_ENV_RUNTIME`
    env var) until the UI writes a backend choice.**
  - `getPermissions()` / `setPermissions()` — `{ file_write, file_edit }`, default `auto`/`auto`.
  - `sandboxAutoApproves(category)` — true only when sandbox auto-approve is on AND the category
    is enabled (drives §G). Defines the `ApprovalCategory` taxonomy + `SANDBOX_CATEGORY_DEFAULTS`.
  - `_resetCacheForTests()` test hook.
- **Still pending (LLM slice):** API-key encryption via `safeStorage`, `getResolvedApiKey()`,
  `getLlmConfig()`, `setLlmConfig()` + Portkey-client invalidation.

### C. Agent reads settings (provider/model/key dynamic) — ⏳ PENDING (LLM slice)
- **`src/main/agent/index.ts`** — `getClient()` becomes settings-aware: build the Portkey client
  from `settingsService.getLlmConfig().baseURL` + `getResolvedApiKey()`; keep the current
  constants as **defaults** only. Add `invalidateClient()` (sets the cached `client = undefined`)
  called by the settings service on an LLM-config write, so the next turn rebuilds with new
  values.
- Replace the hardcoded `model: MODEL` at both call sites (title generation + the agentic loop)
  with `settingsService.getLlmConfig().model`. Keep `MODEL` as the fallback default.
- `provider` is stored and surfaced but only `"portkey"` is wired in V1 — the field exists so a
  future provider is a new branch in `getClient()`, not a schema change.

### D. Permissions drive the classifier (no restart) — ✅ SHIPPED
- **`src/main/agent/approval/file-classifier.ts`** — `FileActionClassifier` takes a permissions
  getter (wired in `agent/index.ts` to `() => settingsService.getPermissions()`) and reads it
  **at `classify()` time**. A required approval is tagged `category: "workspace_mutation"` so the
  sandbox policy (§G) can target it. Defaults to auto-allow when no getter is supplied (keeps unit
  tests + pre-settings behavior intact). `PolicyEngine` stays built once; only the data is live.
- Shell permissions are **not** a separate toggle — they're handled by the §G sandbox-category
  mechanism. The `RegexCommandClassifier` hardline tier remains unconditional regardless.

### E. IPC + preload — ✅ SHIPPED (execution + permissions channels)
- **`src/main/ipc/settings-handlers.ts`** (new sibling to `db-handlers.ts`, registered from
  `src/main/index.ts` alongside `registerDbHandlers`) — channels: `settings:getExecution`,
  `settings:setExecution`, `settings:getPermissions`, `settings:setPermissions`,
  `settings:checkRuntimes`. All route through the settings service.
- **`src/preload/index.ts`** — `window.cowork.settings` namespace mirroring those channels;
  setting types re-exported (also surfaced via `@/types` for the renderer).
- **Still pending (LLM slice):** `settings:getLlm` / `setLlm` / `hasApiKey` (boolean only, never
  the plaintext key).

### F. Renderer — the Settings pane — ✅ SHIPPED (partial: Backend/Permissions/Sandbox)
- **`src/renderer/src/components/settings-sheet.tsx`** — a `Sheet` with `tabs`:
  - **Backend:** a `select` for `Local | Docker | Podman`; container options show their runtime
    status (available / not installed / installed-not-running) from `settings:checkRuntimes` and
    are disabled when unavailable.
  - **Permissions:** `switch` per gated action — "Require approval to write/edit files".
  - **Sandbox:** master auto-approve `switch` (default OFF) + a per-`ApprovalCategory` switch row
    when on. Tab disabled unless a container backend is selected.
  - **Onboarding `Dialog`:** first time a container backend is picked (`sandbox.prompted` false),
    explains sandbox auto-approve and offers Enable / Not now (either sets `prompted: true`).
- **`src/renderer/src/main.tsx`** holds `settingsOpen`; **`sidebar.tsx`** has the gear `Button` in
  the footer (`onSettingsClick`). No new `VIEWS` entry.
- **Fix landed here too:** `ui/sheet.tsx` close button got `[-webkit-app-region:no-drag]` so the X
  isn't swallowed by the window's top drag region on macOS.
- **Still pending (LLM slice):** the **Provider & Model** and **API Key** tabs.

### G. Execution backend + sandbox approval policy (the `.plan/006` section-E pickup) — ✅ SHIPPED

The 006-E payoff. Two pieces, both landed:

- **Backend choice in Settings.** `runChat` (`src/main/agent/index.ts`) reads
  `settingsService.getExecutionConfig()` and passes it to `createEnvironment(...)` instead of
  calling `envConfigFromEnv()` directly; `envConfigFromEnv()` survives only as the service's
  fallback (used until the UI writes a choice). Surfaced in the Settings Sheet Backend tab (§F);
  `src/main/agent/env/runtime-check.ts` preflights `docker`/`podman` so unavailable runtimes are
  disabled in the picker (the turn-start validation in `createEnvironment` remains the real gate).
- **Sandbox-aware downgrade — landed in the `PolicyEngine`, not the classifier.** *(This is a
  deliberate improvement over the original draft, which proposed reading "is container" inside the
  classifier at classify-time.)* The shipped design:
  - A `require_approval` `ActionDecision` now carries an optional **`category`** (file classifier
    tags `workspace_mutation`; `RegexCommandClassifier`'s DANGEROUS patterns are tagged
    `destructive_fs` / `history_rewrite` / `system_mutation` / `code_exec`; untagged → `code_exec`).
  - `PolicyContext` gained `sandboxed?: boolean`; the engine takes an optional
    `SandboxPolicyLookup { autoApproves(category) }` (wired to `settingsService.sandboxAutoApproves`).
  - In `decide()`, **after the `hard_block` early-return** — the same place the allowlist downgrade
    already lived — a `require_approval` is downgraded to `allow` when `ctx.sandboxed` AND the
    sandbox policy auto-approves its category. `runChat` sets `sandboxed = envConfig.kind ===
    "container"` and passes it into `policy.decide(...)`.
  - **Hard invariant, structurally enforced:** `hard_block` returns before any downgrade branch,
    so neither the allowlist nor the sandbox can ever reach it. `rm -rf /` is blocked in every
    backend. Covered by unit tests in `approval.test.ts` (including "sandboxed + all-yes policy →
    still hard_block").
  - **Granularity is config-driven, not blanket.** Default when auto-approve is enabled: only
    `workspace_mutation` is on; the riskier categories are opt-in per the Sandbox tab. Local always
    stays strict (the downgrade only fires when `sandboxed`).

This keeps 006's mechanism and 004's policy/UI cleanly separated: 006 made execution *swappable*;
004 makes the choice *visible* and turns the sandbox into the *trust lever* that justifies it.

## Sequencing
**Slice 1 (shipped):** schema+repo (V4) → settings service (cache + defaults) → file classifier
reads permissions → IPC+preload (execution/permissions) → renderer Sheet + gear → backend choice
+ sandbox approval policy (§G). ✅

**LLM slice (next):** safeStorage key handling in the service → `getClient()`/model dynamic +
invalidation (§C) → `settings:getLlm/setLlm/hasApiKey` channels (§E) → Provider/Model + API-Key
tabs (§F). Each step typecheck-able independently; the agent keeps using the current constants +
env key until that slice lands.

## Verification

**Slice 1 — done (✅ automated + manual):**
- **Defaults / back-compat:** fresh DB behaves as before — Local backend, file ops auto-allow,
  dangerous shell prompts, hardline blocks. Migration reaches `user_version 4`.
- **Permissions (hot):** toggle "Require approval to edit files" ON → editing a file shows the
  inline approval card; OFF → applies silently. No restart. ✅
- **Hardline safety:** unit-tested — `rm -rf /` stays `hard_block` even sandboxed with an all-yes
  sandbox policy; sandbox only downgrades enabled categories; non-sandboxed never downgrades. ✅
- **Execution backend (§G):** switching the runtime in Settings runs the next turn in that backend
  with no restart; unavailable runtimes are disabled in the picker. ✅
- `pnpm typecheck` + `pnpm build` clean; **131 tests** pass (19 new); `pnpm dev` manually verified
  (backend switch, hot permission toggle, runtime preflight, sandbox onboarding, sheet close X). ✅

**LLM slice — pending:**
- **API key:** set a key in Settings → persisted encrypted (the `settings` row is ciphertext),
  survives restart, agent uses it; clearing falls back to env; renderer never sees the plaintext.
- **Model:** change the selected model → next turn calls Portkey with the new id, no restart.

## Out of scope
- Additional providers beyond Portkey (the model/provider field is future-proofed; only Portkey
  is wired).
- Fetching a live model catalog from the gateway (user-maintained list in V1).
- Per-workspace / per-conversation settings overrides (global only in V1).
- Per-tool granular allowlist management UI (the `action_allowlist` from `002` is adjacent but a
  separate concern; managing/revoking remembered rules is its own future pane).
- Theme/appearance, keybindings, telemetry, and other non-LLM/non-permission preferences.
