# PR122: Anthropic API provider

> Status: **Implemented (steps 1–6) — awaiting live verification (step 7).** Adapter in `src/main/agent/providers/anthropic.ts`; shared carrier in `src/main/agent/providers/native-carrier.ts`. Open questions still open: no refusal fallbacks, thinking display left at the default (`omitted`), effort fixed at `high` (`low` below a 4096-token cap). Prerequisite for [PR118: in-turn context compaction](118-in-turn-context-compaction.md). The existing Claude subscription provider is out of scope and unchanged; it is being reworked separately. [PR123: Google API provider](123-google-api-provider.md) reuses the shared pieces this plan introduces.

## Objective and recommendation

Wire the reserved `anthropic` provider as an **API-key account**, following the same pattern as `openai`, `openai_compatible` and Portkey:

- an API key in the existing secrets store, plus an optional base URL that defaults to the Anthropic API;
- the official `@anthropic-ai/sdk` client, built in `buildClient` with `maxRetries: 0`, because the agent loop owns the retry budget;
- the "Anthropic" entry in Settings enabled, with models imported from the provider's model list.

This is not a bridge like the Codex subscription: no OAuth, device codes or private endpoints. A translation layer is still needed, though. The agent loop speaks the chat-completions shape (`LlmClient.chat.completions.create`), while the Messages API uses content blocks.

**Why not Anthropic's OpenAI-compatible endpoint?** That already works today through an `openai_compatible` account. It cannot carry thinking-block signatures, explicit prompt-cache breakpoints or server-side context editing, and those are exactly what long agent turns and PR118 need.

## Evidence and current seams

- `src/main/db/types.ts` already reserves `"anthropic"` in `Provider`. `src/renderer/src/components/llm-settings.tsx` lists "Anthropic" with `enabled: false`.
- `src/main/agent/providers/index.ts`:
  - `buildClient` branches per provider and rejects anything not wired yet;
  - `wrapOpenAI` and `wrapPortkey` show how an SDK becomes an `LlmClient`;
  - `classifyLink` treats an error's numeric `status` as authoritative for retry decisions.
- `src/main/agent/tool-stream.ts` and the round loop read chat-completion stream chunks: `delta.content`, `delta.tool_calls` and the finish reason.
- `src/main/agent/providers/claude-subscription/native-carrier.ts` replays provider-native assistant blocks, including thinking signatures, through the `messages.native_assistant` column and the `nativeAssistant` symbol. It records a history-prefix fingerprint, but `validateCarrier` is hard-wired to `provider: "claude_subscription"`.
- The agent loop never forces a tool: `tool_choice` is only `auto` or `none` (`src/main/git/commit-message.ts`). That matters because current Claude models reject forced tool choice.
- `src/main/settings/secrets.ts` (`getApiKey` / `setApiKey`) stores API keys for the existing key-based providers.

## Adapter

Add `src/main/agent/providers/anthropic.ts` exporting `buildAnthropicClient({ apiKey, baseUrl })`, which returns an `LlmClient`.

**Request mapping (chat-completions body → Messages API):**

- `system` and `developer` messages → top-level `system` as text blocks.
- Assistant `tool_calls` → `tool_use` blocks. Each round's tool results → `tool_result` blocks in **one** user message; splitting parallel results across messages degrades parallel tool use.
- Images in user or tool content → `image` blocks (base64), honoring the account's `acceptsImages`.
- Tool definitions → `{ name, description, input_schema }`. `tool_choice` `auto` and `none` map directly; forced choice is never sent.
- `max_tokens` from the loop's output cap. Use streaming for every agent round.
- Thinking: adaptive thinking on models that support it; never `budget_tokens`, and never `disabled` on models that reject it. Map the app's effort setting, where one exists, to `output_config.effort`. Set it explicitly, because defaults differ by model.

**Response and stream mapping (Messages API → chat-completions shape):**

- Text deltas → `delta.content`.
- `tool_use` blocks and their streamed JSON input → `delta.tool_calls`.
- Thinking blocks → the reasoning field the loop already handles, and the native carrier (below).
- Usage, including cache creation and cache read tokens, → the usage the context-usage log (PR108) reports.
- Stop reasons:

| Messages API | Chat-completions mapping |
|---|---|
| `end_turn`, `stop_sequence` | `stop` |
| `tool_use` | `tool_calls` |
| `max_tokens` | `length` (a genuine output-cap stop) |
| context window full | the context-overflow error from PR118 step 1, **never** `length` |
| `refusal` | `refusal`, with `stop_details` kept for the error message |
| `pause_turn` | unexpected (North Star sends no server tools); fail the round clearly |

**Errors:** map the SDK's typed errors onto errors carrying `status`, so `classifyLink` keeps working: 429 and 5xx (including overloaded) are transient, other 4xx are deterministic. A `413 request_too_large` and a 400 for an over-long prompt are classified as context overflow. Confirm the exact overflow message while building the adapter.

**Models:** call `models.list` for import. Keep each model's `max_input_tokens`, `max_tokens` and `capabilities` in a per-account in-memory catalog, exposed as `contextWindowFor(accountId, modelId)`, so PR118 can bound requests by the real window. Store nothing new in the database for now.

**Prompt caching:** one breakpoint on the stable system prompt and a rolling breakpoint on the latest message, within the four-breakpoint limit. Verify with `cache_read_input_tokens` on consecutive rounds.

## Append-only history: the key design decision

Current Claude models (Opus 5.5, Sonnet 5.5, Fable 5.1) bind each thinking block's signature to the conversation prefix that produced it: the top-level `system` prompt, the set of `tools`, and every earlier message. Editing that prefix invalidates every later thinking block. For accounts created on or after 2026-08-31, replaying an invalidated block is a `400 invalid_request_error`, and retrying the same body fails again. Older accounts are only recorded, but should be treated the same way.

North Star edits the prefix today:

- it rebuilds the system prompt every turn (todos, task state, approvals, rolling summary, index and environment sections);
- it recomputes `tools` every round (`buildTools()`, for example when plan mode flips);
- the rolling summary (PR019/PR102) replaces earlier history.

Options:

- **A. Replay thinking only when the prefix is unchanged.** Generalize the native carrier so its prefix fingerprint covers `system`, the tool set and earlier messages. Replay thinking blocks only when the fingerprint matches; otherwise strip prior thinking blocks and keep their text and `tool_use` blocks. This never fails a request, but it loses earlier reasoning and restarts the prompt cache whenever the prefix changes.
- **B. Make Anthropic conversations append-only.** Freeze the core system prompt per conversation. Deliver volatile context (todos, task state, summary) as appended mid-conversation `role: "system"` messages, which current Opus, Sonnet 5.5, Fable and Haiku 5.5 models accept but Sonnet 5 does not. Keep `tools` stable within a conversation. This keeps reasoning and cache across rounds and turns, but it is a larger change to context assembly.
- **C. Safety net:** send `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` (beta header `thinking-binding-controls-2026-08-01`), so a missed edit drops blocks instead of failing. Log every `input_transformations` entry.

**Recommendation:** ship A plus C in this plan; correct by construction, never a 400, and every drop is visible in the logs. Plan B as a follow-up slice, justified by the drop counts and `cache_read_input_tokens` measured from A.

**Consequence for PR118:** for Anthropic accounts, tier 1 must use server-side context editing (`clear_tool_uses_20250919`, beta `context-management-2025-06-27`) instead of rewriting old tool results client-side. Server-side clearing does not count as an edit, because the check compares the conversation as sent. Client-side stubbing would invalidate every later thinking block. Tier 2's rebuild drops prior thinking by design.

## Shared pieces for PR123

- **Generalized native carrier:** move it out of `claude-subscription/` into a shared providers module with a `provider` discriminant. Keep the Claude subscription's behavior unchanged; its validation still accepts only its own carriers.
- **Context-window catalog:** the `contextWindowFor` lookup, filled by each provider's model list.

## Settings and UI

- Enable "Anthropic" in `llm-settings.tsx`. The API key is required; the base URL is optional (`requiresBaseUrl` returns false for `anthropic`).
- Model import uses `models.list`. `acceptsImages` defaults to true.
- `hasActiveProvider` and `resolveLlmTarget` treat `anthropic` like the other key-based providers.

## Implementation sequence

1. Shared native carrier with a provider discriminant; Claude subscription tests unchanged and passing.
2. `anthropic.ts`: request mapping, non-streaming and streaming response mapping, stop reasons, error mapping.
3. Thinking replay with the prefix fingerprint (option A) and the `drop_block` safety net (option C), with logging.
4. Models import and the context-window catalog.
5. Prompt-cache breakpoints.
6. Settings entry, `buildClient` branch, provider gates.
7. Live verification by the user.

## Verification and acceptance

- Unit, request mapping: system blocks; parallel tool results in a single user message; images; tool definitions; `tool_choice` `none`; no forced choice; no `budget_tokens`.
- Unit, stream mapping from recorded event fixtures: text, tool-call argument streaming, thinking, usage with cache fields, and each stop reason, including overflow never becoming `length`.
- Unit, errors: 429 and 5xx transient; 400 and 413 overflow classified as overflow; other 4xx deterministic.
- Unit, thinking replay: an unchanged prefix replays blocks verbatim; a changed `system`, tool set or earlier message strips prior thinking and keeps text and `tool_use` blocks; the Claude subscription's carrier validation is unchanged.
- Integration with a mocked SDK: a multi-round tool turn and a following turn with a rebuilt system prompt both produce valid request bodies.
- **Live (user):** a long tool-using turn on `claude-opus-5-5` with `prefix_mismatch_behavior: "error"` set, so any prefix edit fails loudly. Acceptance: no 400s, `cache_read_input_tokens > 0` on consecutive rounds, and no `thinking_dropped` entries within a single turn.

## Explicit non-goals

- No change to the Claude subscription provider.
- No Bedrock, Vertex AI, Microsoft Foundry or Claude Platform on AWS clients.
- No server tools (web search, web fetch, code execution), Managed Agents, Message Batches or Files API.
- No database schema change for model capabilities.

## Open questions

- Whether to enable server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) for models that support them, and how a fallback should appear in the transcript.
- Thinking display: `summarized` for visible reasoning, or the default `omitted`. This affects what Trace can show.
- Whether option B's append-only context assembly should become the default for every provider, since it also improves prompt caching elsewhere.
- Which effort level to default to per model, given that defaults differ (`medium` on Opus 5.5, `high` on Sonnet 5.5).
