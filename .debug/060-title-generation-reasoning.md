---
status: resolved
trigger: "Interactive conversation titles echo generic greetings or contain the title model's reasoning narration"
created: 2026-08-27
updated: 2026-08-27
---

## Symptoms

- Expected: `hey there` receives a short semantic label rather than copying the greeting.
- Actual: the title is `hey there`.
- Expected: a request to open the LangChain DeepAgents overview receives a concise topic title.
- Actual: the title starts with `We need to produce a short title 3-6 words summarizing the user's first message...` and is truncated.
- Reproduction: create a new Interactive conversation and send either example as the first message.

## Current Focus

- hypothesis: The 32-token completion cap is shared with reasoning tokens, so a reasoning model can exhaust the budget before emitting its final title. The code accepts any non-empty response without semantic or structural validation.
- test: Simulate reasoning narration, a generic greeting echo, a valid marked title, and a provider that rejects `reasoning_effort`.
- expecting: Valid 3-6 word semantic titles are accepted; invalid/meta output falls back to a concise deterministic label; incompatible providers retry without the reasoning parameter.
- next_action: Resolved; restart the app and verify the two reported Interactive-mode examples.
- reasoning_checkpoint: The user's exact output matches budget-truncated meta reasoning rather than a routing or persistence failure.

## Evidence

- timestamp: 2026-08-27
  observation: `generateTitle` caps output at 32 tokens and accepts every non-empty `message.content` as the database title.
- timestamp: 2026-08-27
  observation: Current OpenAI API documentation states `max_completion_tokens` includes visible output and reasoning tokens; lower `reasoning_effort` reduces reasoning-token usage.
- timestamp: 2026-08-27
  observation: The leaked title explicitly narrates the title-writing instruction and truncates mid-URL, consistent with the completion hitting its output budget.

## Eliminated

- hypothesis: Interactive mode bypasses title generation.
  reason: The title is being persisted, and its contents match the title model's response; the defect is output quality and validation.

## Resolution

- root_cause: Title generation allowed only 32 completion tokens even though reasoning models count reasoning against that budget, then persisted any non-empty content without validating that it was title-shaped. Generic greeting echoes were likewise accepted.
- fix: Extracted title generation into a dedicated module; raised the completion ceiling to 256; requested low reasoning with an unsupported-parameter retry; required a marked `TITLE:` response; rejected reasoning/meta narration, URLs, commands, oversized output, and echoed greetings; added semantic deterministic fallbacks.
- verification: Focused title tests cover the two reported examples, visible reasoning extraction, truncated reasoning rejection, greeting echoes, low-reasoning requests, and provider compatibility retry. Full suite reports 750 passed and 394 skipped; TypeScript, production Electron build, Prettier, and `git diff --check` pass.
- files_changed: src/main/agent/title.ts, src/main/agent/title.test.ts, src/main/agent/index.ts
