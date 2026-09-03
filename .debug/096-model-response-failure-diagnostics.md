---
status: CLOSED
severity: P2
trigger: "An empty terminal response is persisted without enough evidence to distinguish missing content, truncation, or unhandled response fields"
created: 2026-09-02
updated: 2026-09-02
---

# Preserve bounded model response failure diagnostics

## Evidence

The incident in [095](./095-empty-model-response-reported-as-complete.md) leaves
an empty assistant message and a completed retry budget with no error. The
stream consumer retains only text, tool-call fragments, and finish reason;
the database does not retain that finish reason. Consequently we cannot
identify the original provider/model cause from the recorded conversation.

The conversation's account/model selection is null, meaning it used defaults.
Today's default settings cannot establish which provider/model handled a
historical request. The large roadmap read and 156-second final request are
observations, not proof of context exhaustion or reasoning-token exhaustion.

## Proposed implementation

Implement alongside 095, using its typed response-validation failures.

1. Collect a small allowlisted response summary while consuming the stream:
   chunk count, whether any choice/delta was seen, raw text character count,
   recovered visible text character count, tool-fragment/call counts, terminal
   reason, and booleans indicating recognized refusal/reasoning fields. Preserve
   absence as unknown rather than claiming the provider sent no such data.
2. Include resolved account ID, model ID, and API mode from the actual request,
   plus elapsed milliseconds and a provider request ID if available without
   changing transport behavior. Include numeric token usage only when emitted;
   do not issue extra requests or assume usage is always present.
3. Attach the summary to validation failures and serialize a bounded diagnostic
   into the existing retry budget `last_error` through `recordFailure` and
   `exhaustBudget`. Keep a concise error code/message for classification and
   user-facing text; do not expose the diagnostic blob in the chat bubble.
   Limit the serialized summary to 4 KiB, capping strings before serialization
   so it remains valid and useful when truncated.
4. Retain the failed-attempt summary if a later retry succeeds, as current
   `completeBudget` retains `last_error`. The existing field represents the
   most recent failure, not a complete per-attempt audit trail. Do not introduce
   a new telemetry table or persist all successful responses for this scope.
5. Keep user-facing errors in 095 specific to the evidence. For example,
   `length` can explain an output limit; absent usage cannot establish why
   that limit was reached. Reasoning content must never be displayed or stored.

No raw prompts, message bodies, tool arguments, response chunks, reasoning text,
credentials, URLs with credentials, or arbitrary provider error objects belong
in the summary. Cap and sanitize even provider-supplied identifiers/reasons.
Reuse applicable existing diagnostic sanitizers without coupling ordinary
conversation errors to process-only persistence.

## Likely files

`src/main/agent/model-request-retry.ts`, `src/main/agent/index.ts`, their tests,
and retry budget repository tests. Provider adapter changes are only needed
if a request identifier is already accessible there; its absence is allowed.
No database migration is planned.

## Acceptance and verification

- [x] Empty stop, empty EOF, output-limit, refusal, and reasoning-only synthetic
      streams leave distinct, accurate summaries with missing fields marked unknown.
- [x] Resolved request identity is recorded rather than inferred later from
      potentially changed default settings.
- [x] A DB-backed failure can be diagnosed after reopening; successful retry
      retains the preceding failure summary without being reported as failure.
- [x] Adversarial strings cannot exceed the bound or leak response/credential
      sentinel values; serialization remains valid.
- [x] User-facing errors remain concise and notification routing matches 095.
- [x] SQLite-backed regression assertions execute with
      `COWORK_REQUIRE_SQLITE_TESTS=1`; record exact commands/results on closure.

## Implementation references

- `src/main/agent/model-request-retry.ts` collects an allowlisted
  `ModelResponseAttemptDiagnostics` summary while consuming each stream and
  attaches it to `ModelResponseValidationError` failures inside the retry
  boundary.
- The persisted `last_error` keeps the concise validation message and appends a
  `[model_response_diagnostic]` JSON payload capped to 4 KiB. The summary stores
  counts, finish reason, elapsed time, resolved request identity, optional usage,
  and optional provider request ID; it does not store prompt text, response text,
  reasoning text, refusal text, tool arguments, credentials, or arbitrary error
  objects.
- `src/main/agent/index.ts` passes the actual resolved account ID, model ID, API
  mode, and existing recovered-visible-text parser into the retry wrapper.
- `src/main/db/repositories/model-request-retry-budgets.test.ts` documents that
  `completeBudget` preserves the preceding failed-attempt `last_error`, matching
  successful retry behavior.
- Regression coverage was added in
  `src/main/agent/model-request-retry.test.ts` for empty stop, empty EOF,
  output-limit, refusal-only, reasoning-only, identity/usage/request-id capture,
  recovered text counts, tool fragment/call counts, and bounded adversarial
  serialization.

## Verification results

Passed on 2026-09-02:

```sh
COWORK_REQUIRE_SQLITE_TESTS=1 npx vitest run src/main/agent/model-request-retry.test.ts src/main/db/repositories/model-request-retry-budgets.test.ts
npm run typecheck
```

## Historical limit

These changes improve future evidence. They cannot reconstruct the original
response or prove the provider cause of the September 2 incident. Preserve
the incident database and leave that cause recorded as unknown unless separate
provider logs establish it.
