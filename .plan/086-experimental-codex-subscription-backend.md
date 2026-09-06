# PR86: Experimental Codex subscription backend

> Status: **PLANNED**. Explores an opt-in `chatgpt.com/backend-api/codex` runtime connector without making it the public-product foundation.

> **For Hermes:** Implement with the `north-star-project`, `coding-agent-adapters`, and `test-driven-development` skills. Do not commit unless the user explicitly asks.

**Goal:** Add an experimental, explicitly opt-in Codex subscription backend that can run through ChatGPT/Codex OAuth-style credentials while preserving North Star's runtime ownership, auditability, and safe fallback to Codex CLI or official API providers.

**Architecture:** Treat the ChatGPT/Codex subscription path as a separate provider/account mode, not as an OpenAI SDK base URL swap. Main process owns authentication, request assembly, transport, tool-call mediation, and persistence; renderer only selects/configures the provider through `window.cowork.*`. The feature should be behind experimental UI copy and disabled unless the user configures it intentionally.

**Tech Stack:** Electron main process, TypeScript, existing provider account/model catalog tables, existing agent/provider adapter interfaces, Vitest, optional external protocol reference from Hermes Agent implementation.

---

## Product Contract

- This is **experimental / opt-in**.
- Do not replace Codex CLI or official OpenAI-compatible providers.
- Do not present this as a stable public-product backend.
- Do not put auth/token handling in renderer.
- Do not store raw credentials in plaintext.
- Do not assume the official OpenAI SDK can call this endpoint unchanged.
- Preserve North Star as the agent/process runtime owner: approvals, tools, process state, retries, snapshots, and dashboards remain North Star-owned.

## Current Context / Assumptions

- North Star already has provider accounts, models, external CLI providers, process runtime profiles, and provider/model pickers.
- Prior investigation found Hermes Agent uses `openai-codex`, `https://chatgpt.com/backend-api/codex`, `api_mode: codex_responses`, and a Responses-style request shape with assembled `instructions`, `input`, `tools`, tool results, reasoning/cache fields, and local tool-call handling.
- Exact credentials/tokens must remain redacted and must not be copied into this repo or plan.
- This plan should rely on fresh inspection before implementation because the endpoint/protocol is undocumented and may change.

## Proposed Approach

1. Add a new experimental provider mode, e.g. `codex_subscription` or `codex_responses_oauth`.
2. Implement a main-process transport adapter that mirrors the required Codex backend request/response protocol.
3. Keep the feature gated by settings and explicit experimental warnings.
4. Add preflight detection, clear failure messages, and fallback recommendations to Codex CLI.
5. Add tests with recorded/synthetic protocol fixtures only; never bake real tokens or live private endpoint responses into tests.

## Files Likely To Change

- Modify: `src/main/db/types.ts`
- Modify: `src/main/db/schema.ts`
- Modify: `src/main/db/migrations.ts`
- Modify: `src/main/db/migrations.test.ts`
- Modify: `src/main/db/repositories/models.ts`
- Modify: `src/main/db/repositories/providers.ts` or equivalent provider repository
- Modify/create: `src/main/agent/providers/*`
- Modify/create: `src/main/agent/providers/codex-subscription.ts`
- Modify: `src/main/ipc/provider-handlers.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/components/llm-settings.tsx`
- Modify: `src/renderer/src/components/process-screen.tsx` only if runtime picker filtering/copy needs provider-specific treatment
- Modify tests adjacent to each changed main/renderer module

## Step-by-Step Plan

### Task 1: Re-inspect adapter/provider architecture

**Objective:** Identify the exact extension points for a new non-standard provider transport.

**Files:**
- Inspect: `src/main/agent/index.ts`
- Inspect: `src/main/agent/providers/*`
- Inspect: `src/main/agent/cli/codex.ts`
- Inspect: `src/main/db/types.ts`
- Inspect: `src/main/db/repositories/models.ts`
- Inspect: `src/main/ipc/provider-handlers.ts`
- Inspect: `src/renderer/src/components/llm-settings.tsx`

**Steps:**
1. Trace how provider accounts are created and selected.
2. Trace how chat/process runtime calls dispatch to provider transports.
3. Identify whether `api_mode` or `provider` enum is the right discriminator.
4. Document all constraints before editing.

**Verification:**
- You can trace a selected account/model from renderer picker to main-process transport call.

### Task 2: Freshly inspect Hermes reference behavior

**Objective:** Avoid guessing the private protocol shape.

**Files/Repos:**
- Inspect local Hermes Agent source if available: `/Users/r2r0garza/.hermes/hermes-agent`
- Use public docs only for Hermes architecture; do not expose credentials.

**Steps:**
1. Locate Hermes Codex auth, transport, and request assembly code.
2. Note only structural details: endpoint path, request fields, stream/event handling, cache/reasoning fields, auth header shape names without values.
3. Record pitfalls in this plan or implementation notes.

**Verification:**
- No tokens, cookies, refresh tokens, or user secrets are copied into source, tests, logs, or plan updates.

### Task 3: Add provider/account schema support behind an experimental discriminator

**Objective:** Let users configure the experimental backend without overloading official OpenAI accounts.

**Files:**
- Modify: `src/main/db/types.ts`
- Modify: `src/main/db/schema.ts`
- Modify: `src/main/db/migrations.ts`
- Modify: `src/main/db/migrations.test.ts`

**Implementation notes:**
- Prefer a distinct provider enum value such as `codex_subscription` or an explicit `api_mode` such as `codex_responses_oauth`.
- If existing provider table CHECK constraints need widening, add a normal append-only migration.
- Include migration tests for existing accounts and new provider creation.

**Commands:**
```bash
pnpm vitest run src/main/db/migrations.test.ts
pnpm run typecheck
```

### Task 4: Add secure credential storage/config path

**Objective:** Store required auth material only through main-process secure storage paths.

**Files:**
- Modify: provider repository/settings service as needed
- Modify: `src/main/ipc/provider-handlers.ts`
- Modify: `src/renderer/src/components/llm-settings.tsx`

**Requirements:**
- Renderer can submit credentials/config but cannot read secrets back.
- Stored secret values use the same encrypted/safeStorage pattern as existing API keys.
- UI labels clearly say experimental/private/unsupported.
- Redact secrets in logs and errors.

**Acceptance Criteria:**
- Saved account appears in provider settings with secret status but not secret value.
- Deleting/disabling the account removes or ignores credentials consistently with other providers.

### Task 5: Implement the main-process transport adapter

**Objective:** Send model requests through the experimental Codex backend while preserving North Star's local tool/runtime loop.

**Files:**
- Create/modify: `src/main/agent/providers/codex-subscription.ts`
- Modify: provider dispatch registry

**Implementation notes:**
- Build request payloads explicitly; do not rely on OpenAI SDK defaults that may not match the private endpoint.
- Support system/developer instructions, user input, prior context, and tool-result turns according to the protocol shape discovered in Task 2.
- Parse streaming and non-streaming responses as needed by existing North Star abstractions.
- Surface private-backend failures with actionable messages and fallback suggestions.

**Acceptance Criteria:**
- A synthetic response fixture can drive the same downstream assistant-message/tool-call path as official providers.
- Network/auth errors are redacted and user-safe.

### Task 6: Model catalog strategy

**Objective:** Keep model selection practical despite no stable model-list endpoint.

**Files:**
- Modify: `src/main/db/repositories/models.ts`
- Modify: provider model seeding/catalog code
- Modify: `src/renderer/src/components/llm-settings.tsx`

**Implementation notes:**
- Seed a conservative set of known aliases if appropriate.
- Allow custom model IDs.
- Mark catalog entries as experimental/user-maintained.
- Do not block usage solely because a model is not in a remote list.

**Acceptance Criteria:**
- User can select or type a model ID for the experimental account.
- Model picker copy makes instability clear.

### Task 7: Add preflight and diagnostics

**Objective:** Detect misconfiguration before a process run fails deep in execution.

**Files:**
- Modify: provider detection/preflight service
- Modify: settings UI
- Maybe modify: process start preflight if runtime profile references this provider

**Checks:**
- Credentials/config present.
- Endpoint reachable enough to classify network/auth failures.
- Selected model ID present.
- Feature gate enabled.

**Acceptance Criteria:**
- User gets clear errors: missing auth, expired auth, endpoint changed, model unavailable, network blocked.

### Task 8: Add tests with synthetic fixtures

**Objective:** Verify behavior without depending on live private endpoint access.

**Files:**
- Create/modify tests near provider adapter
- Modify: `src/main/db/migrations.test.ts`
- Modify renderer settings tests if present

**Test cases:**
1. Provider enum/migration accepts experimental account.
2. Secrets are stored redacted/encrypted consistently with other accounts.
3. Request builder produces expected structural payload from a small transcript.
4. Response parser handles assistant text.
5. Response parser handles tool call requests if supported.
6. Errors redact auth values.
7. Runtime profile can select the experimental provider but falls back cleanly if disabled.

**Commands:**
```bash
pnpm vitest run src/main/db/migrations.test.ts
pnpm vitest run src/main/agent/providers/*.test.ts
pnpm run typecheck
```

### Task 9: Manual validation with explicit user-owned credentials

**Objective:** Confirm live behavior only after tests pass and only with user-provided credentials.

**Steps:**
1. Run `pnpm dev`.
2. Enable experimental Codex subscription backend in Settings.
3. Add the account/config using user-owned credentials.
4. Run provider preflight.
5. Start a simple chat turn.
6. Start a simple one-phase Process using the provider via runtime profile.
7. Verify runtime snapshot records the experimental provider/model.
8. Verify errors/logs contain no token values.

## Tests / Validation

Run before manual testing:
```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

If provider-specific tests are added, also run:
```bash
pnpm vitest run src/main/agent/providers/codex-subscription.test.ts
pnpm vitest run src/main/db/migrations.test.ts
```

## Risks / Tradeoffs

- The endpoint is undocumented and may break without notice.
- Shipping this as a primary backend would create product support risk; keep it experimental.
- Credential handling is high-risk; main-process-only storage and redaction are mandatory.
- Private endpoint semantics may differ from official OpenAI Responses API enough that SDK reuse is misleading.
- Live tests cannot be required in CI because they need user-specific auth and may violate stability expectations.

## Open Questions

- Exact provider naming: `codex_subscription`, `codex_responses_oauth`, or another explicit label?
- Should this require a hidden developer flag, an experimental settings toggle, or both?
- Should North Star support this for chat only first, then Processes, or route through generic runtime providers from the start?
- How should refresh/expiry be handled without creating a fragile auth maintenance burden?
- Should this be kept out of public builds entirely until the protocol stabilizes?
