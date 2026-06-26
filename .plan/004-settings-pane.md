# Cowork — Settings Pane (DRAFT / PICK-UP)

> Status: **NOT STARTED** — written ahead as a pickup point. Independent of the todo_tool
> (`003`); builds on the SQLite layer (`001`) and the approval pipeline (`002`, now on `main`).
> A few decisions (see "Open questions") should be settled before execution; the shape below is
> a leading hypothesis, not a locked spec.

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

This phase adds a **Settings pane** so the user can, from the UI: pick the LLM provider (only
Portkey today, but the model is future-proofed for more), choose the model from a maintained
list, set their API key, and flip tool-permission policies (e.g. file edits require approval or
not). It introduces the app's first **persisted settings store** and makes the agent read its
provider/model/permissions from that store at runtime instead of from constants.

Key facts established by exploration:
- **No settings table exists.** Migrations are append-only functions in `src/main/db/
  migrations.ts` (`SCHEMA_V1`, `SCHEMA_V2`); a new `SCHEMA_V3` slots in cleanly.
- **`getClient()` is a lazy singleton** keyed on nothing — it reads env once and caches. It must
  become settings-aware and invalidatable when settings change.
- **`policy` and its classifiers are built once at module load** (`agent/index.ts`). For a
  permission toggle to take effect without a restart, the classifier must read settings *at
  decision time*, not at construction.
- **Renderer has no settings surface**, but every primitive needed exists in
  `src/renderer/src/components/ui/` (`dialog`, `sheet`, `tabs`, `switch`, `input`, `select`?,
  `field`, `label`, `card`, `button`). Views are `Chat | Interactive | North Star` in
  `sidebar.tsx`; the Shell (`main.tsx`) owns `view` + `activeConversationId`.

## Open questions to resolve BEFORE building (decide first)

1. **API-key storage / security — the key fork.** Plaintext in SQLite is a credential-leak risk
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
2. **Hot vs. cold apply.** When the user changes model/key/permission, does it take effect on the
   next turn (hot) or after restart (cold)? Recommendation: **hot** — it's cheap and expected.
   Mechanism: read settings at point-of-use (see §C, §D) and invalidate the cached Portkey client
   on any LLM-config write.
3. **Model list source.** Portkey model ids are gateway aliases; there's no enumerated catalog in
   the code. Options: (a) a **user-maintained list** of model ids in Settings (add/remove/select)
   — simplest, ships now; (b) fetch a catalog from the Portkey gateway — defer unless an endpoint
   is known. Recommendation: (a), seeded with the current default model.
4. **Permission toggles — scope for V1.** The user's example is "edit_file requires approval or
   not". Recommendation: ship per-file-kind policy (`file_write`, `file_edit` → `auto` |
   `require_approval`). **Shell** is trickier: a global "auto-approve all shell" is a foot-gun and
   must NEVER bypass the hardline blocklist — defer a shell toggle, or expose only a clearly
   labeled "auto-approve non-catastrophic shell commands" that still respects hardline. Decide
   whether shell is in or out for V1.
5. **Settings scope.** Global only, or per-workspace overrides (like the allowlist's
   `workspace_path`)? Recommendation: **global** for V1; the table can grow a scope column later.
6. **Settings surface.** A **Sheet/Dialog** opened from a gear button in the sidebar footer, NOT a
   4th view (settings are a singleton, not a conversation). Recommendation: **Sheet** (more room
   for grouped toggles + provider/model/key sections via `tabs`).

## Likely implementation shape (hypothesis — revisit after Q1/Q4)

Assuming **safeStorage key + hot apply + user-maintained model list + file-kind toggles + global
scope + Sheet UI** as the leading hypothesis.

### A. Settings store (schema + repo)
- **`migrations.ts`** — append `SCHEMA_V3` (never edit V1/V2). A small key-value table keeps the
  store flexible as settings grow:
  ```sql
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,   -- e.g. "llm", "permissions"
    value      TEXT NOT NULL,      -- JSON blob
    updated_at INTEGER NOT NULL
  );
  ```
  (Key-value-of-JSON rather than a wide column-per-setting table, so adding a setting is a code
  change, not a migration. The API key is stored as a safeStorage-encrypted base64 string inside
  the `llm` blob — never plaintext.)
- **`src/main/db/repositories/settings.ts`** — `getSetting(key)`, `setSetting(key, value)`,
  `getAll()`. JSON (de)serialize in the repo, mirroring the existing repo style. Export from the
  repo barrel `index.ts`.

### B. Settings service (single read point + cache + secrets)
- **`src/main/settings/service.ts`** — a thin main-process service over the repo that:
  - Caches the parsed `llm` and `permissions` blobs in memory; refreshes on write.
  - Owns API-key encryption via `safeStorage.encryptString` / `decryptString`. Exposes
    `getResolvedApiKey()` (decrypts, falling back to env) for `getClient()` — the plaintext key
    never leaves main.
  - Exposes `getLlmConfig()` (provider, baseURL, model, models[]) and `getPermissions()`
    (`{ file_write, file_edit }`) for the agent + classifier to read at point-of-use.
  - `setLlmConfig(...)` invalidates the cached Portkey client (see §C).
  Defaults live here, so a fresh install behaves exactly like today (current model + env key).

### C. Agent reads settings (provider/model/key dynamic)
- **`src/main/agent/index.ts`** — `getClient()` becomes settings-aware: build the Portkey client
  from `settingsService.getLlmConfig().baseURL` + `getResolvedApiKey()`; keep the current
  constants as **defaults** only. Add `invalidateClient()` (sets the cached `client = undefined`)
  called by the settings service on an LLM-config write, so the next turn rebuilds with new
  values.
- Replace the hardcoded `model: MODEL` at both call sites (title generation + the agentic loop)
  with `settingsService.getLlmConfig().model`. Keep `MODEL` as the fallback default.
- `provider` is stored and surfaced but only `"portkey"` is wired in V1 — the field exists so a
  future provider is a new branch in `getClient()`, not a schema change.

### D. Permissions drive the classifier (no restart)
- **`src/main/agent/approval/file-classifier.ts`** — `FileActionClassifier` takes a permissions
  getter (injected from the settings service) and reads it **at `classify()` time**:
  ```ts
  classify(action) {
    if (action.kind !== "file_write" && action.kind !== "file_edit") return null
    const policy = this.getPermissions()[action.kind]   // "auto" | "require_approval"
    return policy === "require_approval"
      ? { level: "require_approval", reason: `${action.kind} requires approval (settings)` }
      : { level: "allow" }
  }
  ```
  The `PolicyEngine` stays constructed once at module load; only the classifier's *data* is live.
  This is the seam the `002` plan deliberately left — file edits already flow through the gate, so
  this is purely a policy change, and the inline approval card + allowlist already work for them.
- (If Q4 includes shell) a shell permission would similarly be read live, but the
  `RegexCommandClassifier` hardline tier must remain unconditional regardless of any setting.

### E. IPC + preload
- **`src/main/ipc/db-handlers.ts`** — new channels: `settings:getLlm`, `settings:setLlm`,
  `settings:getPermissions`, `settings:setPermissions`, and `settings:hasApiKey` (returns a
  boolean, never the key). The set-LLM handler routes through the settings service so the client
  cache is invalidated. **The decrypted API key is never sent to the renderer** — only a
  "is a key set" boolean and a "replace key" write path.
- **`src/preload/index.ts`** — add a `settings` namespace to `window.cowork` mirroring those
  channels (thin `ipcRenderer.invoke` wrappers, matching the existing `db` pattern). Add the
  setting value types to the shared types so the renderer is typed.

### F. Renderer — the Settings pane
- **`src/renderer/src/components/settings-sheet.tsx`** — a `Sheet` (or `Dialog`) with `tabs`:
  - **Provider & Model:** a provider `select` (only "Portkey", disabled/coming-soon for others),
    a model `select` populated from the maintained list, and add/remove model-id controls.
  - **API Key:** an `input` (password type) that writes via `settings:setLlm`; shows "key is set"
    (masked) vs "no key — using environment" based on `settings:hasApiKey`. Never pre-fills the
    actual key.
  - **Permissions:** `switch` per gated action — "Require approval to write files", "Require
    approval to edit files" (+ shell if Q4 says so). Reads/writes `settings:getPermissions` /
    `setPermissions`.
  Use `field`/`label`/`card` for layout, matching the existing component style. Mirror the
  `AlertDialog` usage already in `sidebar.tsx` for structure.
- **`src/renderer/src/main.tsx` (Shell)** — hold `settingsOpen` state; render `<SettingsSheet>`
  at shell level. **`src/renderer/src/components/sidebar.tsx`** — add a gear `Button` (ghost,
  icon) in the sidebar footer that opens it. No new entry in the `VIEWS` enum.

## Sequencing
schema+repo (settings table) → settings service (cache + safeStorage + defaults) → agent reads
settings (getClient/model dynamic + invalidate) → classifier reads permissions → IPC+preload →
renderer Sheet + gear trigger. Each step typecheck-able independently; the agent keeps working
with defaults until the UI writes anything.

## Verification (when built)
- **Defaults / back-compat:** fresh install with only `.env.local` set behaves exactly as today
  (same model, env key used). `settings:hasApiKey` reflects env presence.
- **API key:** set a key in Settings → it's persisted encrypted (inspect the `settings` row: the
  value is ciphertext, not the raw key), survives restart, and the agent uses it (a turn
  succeeds). Clearing it falls back to env. The renderer never receives the plaintext key.
- **Model:** change the selected model → next turn calls Portkey with the new model id (verify via
  a model that responds differently, or log the request model). No restart needed.
- **Permissions (the headline):** toggle "Require approval to edit files" ON → ask the agent to
  edit a file → the **same inline approval card** appears (Approve / Always allow / Deny), proving
  the generic pipeline serves file edits. Toggle OFF → edits apply with no prompt. Confirm hot
  apply (no restart).
- **Hardline safety:** with any permissive shell setting (if shipped), `rm -rf /` is still
  hard-blocked — settings can never override the hardline tier.
- `pnpm typecheck`, `pnpm test`, `pnpm build` clean; `pnpm dev` boots and the gear opens the Sheet.

## Out of scope
- Additional providers beyond Portkey (the model/provider field is future-proofed; only Portkey
  is wired).
- Fetching a live model catalog from the gateway (user-maintained list in V1).
- Per-workspace / per-conversation settings overrides (global only in V1).
- Per-tool granular allowlist management UI (the `action_allowlist` from `002` is adjacent but a
  separate concern; managing/revoking remembered rules is its own future pane).
- Theme/appearance, keybindings, telemetry, and other non-LLM/non-permission preferences.
