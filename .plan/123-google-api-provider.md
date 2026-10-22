# PR123: Google API provider

> Status: **Proposed — not implemented.** Prerequisite for [PR118: in-turn context compaction](118-in-turn-context-compaction.md). Follows [PR122: Anthropic API provider](122-anthropic-api-provider.md) and reuses its generalized native carrier and context-window catalog.

## Objective and recommendation

Wire the reserved `google` provider as an **API-key account** for the Gemini Developer API, following the same pattern as `openai`, `openai_compatible`, Portkey and PR122:

- a Gemini API key in the existing secrets store; an optional base URL;
- the official `@google/genai` SDK, built in `buildClient` with SDK-level retries off, because the agent loop owns the retry budget;
- the "Google" entry in Settings enabled, with models imported from the provider's model list.

A translation layer maps the loop's chat-completions shape to Gemini's format and back, as in PR122.

**Why not Google's OpenAI-compatible endpoint?** That already works today through an `openai_compatible` account. It is a lossy path for thought signatures, which reasoning models need replayed across tool-calling rounds.

## The key decision: which Gemini API

Google offers two generation APIs with official JavaScript SDK support:

- **`generateContent` / `generateContentStream`** (`client.models.generateContentStream`). Stateless: the full history is resent every request. Google describes it as "fully supported".
  - Function results pair with calls by name and position.
  - Thought signatures are metadata attached to other parts, including `functionCall` parts and the final response part, and must be returned in place.
- **Interactions API** (`client.interactions.create`). Google recommends it "for all new development".
  - State is server-side by default (`store: true` with `previous_interaction_id`); `store: false` is the stateless mode.
  - Thoughts are first-class `thought` steps, each carrying a required signature that must be resent unaltered in stateless mode.
  - Function results pair with calls by `call_id`.
  - Streaming uses `step.start`, `step.delta`, `step.stop` and `interaction.completed` events.

North Star owns its transcript, replays history every round and, with PR118, compacts it. Server-side conversation state does not fit that model, and it would also keep conversation content on Google's side. So either way the adapter runs **stateless**.

**Recommendation:** target the Interactions API with `store: false`. Its explicit `call_id` pairing and dedicated thought steps map more cleanly onto North Star's tool calls and native carrier than position-based pairing does. Its documentation status was inconsistent when this plan was written: one page still called it beta, while a June 2026 report described general availability. Confirm GA at implementation start; if it is still beta, ship on `generateContentStream` instead. Keep the translation layer narrow so the choice is contained in one module.

## Evidence and current seams

- `src/main/db/types.ts` already reserves `"google"` in `Provider`. `llm-settings.tsx` lists "Google" with `enabled: false`.
- `src/main/agent/providers/index.ts` — `buildClient`, the `LlmClient` contract, and `classifyLink` (numeric `status` drives retry classification).
- PR122's shared native carrier (provider discriminant) and `contextWindowFor` catalog.
- The agent loop never forces a tool; `tool_choice` is only `auto` or `none`.

## Adapter

Add `src/main/agent/providers/google.ts` exporting `buildGoogleClient({ apiKey, baseUrl })`, which returns an `LlmClient`.

**Request mapping (chat-completions body → Gemini):**

- `system` and `developer` messages → the system instruction.
- User and assistant text → user and model content.
- Assistant `tool_calls` → function calls; tool results → function results, paired by call ID (Interactions) or by name and position (`generateContent`). Send all results of one round together.
- Images → inline image data, honoring `acceptsImages`.
- Tool definitions → function declarations. Gemini accepts a subset of JSON Schema; add a schema sanitizer, with tests, for keywords North Star's tool schemas use that Gemini rejects. Confirm the supported subset (and whether a full JSON Schema field is available) at implementation time.
- `tool_choice` `auto` and `none` map directly.
- Output cap → the output token limit. Thought tokens count toward it.
- Thinking: the thinking level (`minimal`, `low`, `medium`, `high`, depending on the model) from the app's effort setting where one exists. Enable thought summaries only if Trace should show reasoning.

**Response and stream mapping (Gemini → chat-completions shape):**

- Text → `delta.content`. Function calls → `delta.tool_calls`. Thought summaries → the reasoning field the loop already handles.
- Thought steps and signatures → the shared native carrier, replayed verbatim on later rounds.
- Usage (prompt, output and thought tokens; cached tokens where reported) → the context-usage log (PR108).
- Completion status: normal completion → `stop` or `tool_calls`. An output-cap stop (`incomplete` or `MAX_TOKENS`) → `length`, but only when the input fit; an over-long input → the context-overflow error from PR118 step 1. Safety or policy blocks → `refusal` with the reason kept. A malformed function call → the loop's existing failed-tool-call handling.

**Errors:** map the SDK's errors onto errors carrying `status`: 429 (resource exhausted) and 5xx (including unavailable) are transient, other 4xx deterministic. An input-token-limit rejection is classified as context overflow. Confirm the exact status and message while building the adapter.

**Models:** list models, keep only those that support generation, and record their input and output token limits in PR122's `contextWindowFor` catalog.

**Caching:** rely on Gemini's implicit caching by keeping the request prefix stable. Explicit cached-content resources are out of scope.

## History rules and PR118

- Thought steps and signatures must be resent unaltered in stateless mode, including after a model switch. Google's docs state this, but not the error when they are missing or changed, and not whether trimming earlier turns is allowed.
- Until a contract test proves otherwise, assume Gemini behaves like Anthropic's preserved thinking: client-side edits to earlier turns may break signature validation.
- For PR118, write contract tests for this adapter: stub an old function result's content, and rebuild history after a summary. Enable each tier for Google only if the provider accepts it with signatures intact. Otherwise tier 1 stays off for Google, and only tier 2's full rebuild (which drops prior thoughts) and the clear overflow failure apply.

## Settings and UI

- Enable "Google" in `llm-settings.tsx`. The API key is required; the base URL is optional (`requiresBaseUrl` returns false for `google`).
- Model import uses the model list. `acceptsImages` defaults to true.
- `hasActiveProvider` and `resolveLlmTarget` treat `google` like the other key-based providers.

## Implementation sequence

1. Confirm the Interactions API's status; pick it or `generateContentStream` and record the decision here.
2. `google.ts`: request mapping, schema sanitizer, streaming and non-streaming response mapping, completion statuses, errors.
3. Thought-signature replay through the shared native carrier.
4. Models import into the context-window catalog.
5. Settings entry, `buildClient` branch, provider gates.
6. Contract tests for PR118's compaction tiers.
7. Live verification by the user.

## Verification and acceptance

- Unit, request mapping: system instruction; parallel function results sent together; images; schema sanitizer on every built-in North Star tool schema; `tool_choice` `none`.
- Unit, stream mapping from recorded fixtures: text, function calls, thought steps with signatures, usage, and each completion status, including an over-long input never becoming `length`.
- Unit, errors: 429 and 5xx transient; input-token-limit overflow classified as overflow; other 4xx deterministic.
- Unit, replay: signatures stored by the carrier come back byte-identical on the next round.
- **Live (user):** a long tool-using turn on a current Gemini reasoning model. Acceptance: no signature or validation errors across rounds and turns, usage logged per round, and tool calls paired correctly when the model calls several tools in parallel.

## Explicit non-goals

- No Vertex AI (Google Cloud) client; Gemini Developer API keys only.
- No server-side conversation state (`store: true`).
- No built-in Google tools (search grounding, code execution, URL context), Live API, Files API or explicit context caching.
- No database schema change for model capabilities.

## Open questions

- Interactions API versus `generateContentStream`, decided by the GA check in step 1.
- Whether `store: false` fully disables server-side retention, or whether account-level data settings also apply. This matters for workspaces with sensitive code.
- Which thinking level to default to per model, and whether to show thought summaries in Trace.
- How strict Gemini's schema subset is for North Star's larger tool schemas (nested objects, unions).

## Sources

- [Gemini thinking guide (signatures)](https://ai.google.dev/gemini-api/docs/thinking)
- [Migrating to the Interactions API](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [API Evangelist: Interactions API as the front door to Gemini (June 2026)](https://apievangelist.com/2026/06/22/google-makes-the-interactions-api-the-front-door-to-gemini/)
