---
status: OPEN
severity: P1
trigger: "Auto Memory examines an isolated user message, so it can miss durable conclusions contained in an assistant response that the user subsequently accepts, while assistant text cannot safely authorize itself"
created: 2026-09-03
updated: 2026-09-03
---

# Preserve conversational substance without letting the assistant self-author memory

## Problem

The current extractor receives the latest user text as one trusted
`user_instruction` segment and the same turn's assistant response as untrusted
context. It does not receive the preceding assistant response that a referential
user reply such as `alright, that's fair` is accepting.

This loses the substance of ordinary conversations:

```text
User: What do you think we should learn from this situation?
Assistant: We should use one component system consistently so the product keeps
           a unified design language.
User: Alright, that's fair.
```

The lesson is in the assistant message; the user's next message supplies its
authority. Processing only the final user text loses the lesson. Promoting the
assistant message by itself would instead let the agent write its own beliefs,
instructions, or compromised content into long-term memory.

The production provenance model also marks the complete user message as trusted.
Quoted web pages, tool output, forwarded messages, and prompt-injection fixtures
inside that message are not structurally distinguished from the user's own
words. Prompt instructions and regex filters help, but they are not a complete
trust boundary.

## Governing principle

> Assistant content may supply the substance of a memory, but it cannot supply
> its own authority.

## Evidence model

Extraction jobs from [097](./097-auto-memory-extraction-lifecycle.md) should
carry a bounded structured conversation window with stable message/segment IDs:

| Evidence class                   | May supply substance?  | May authorize durable memory?                                                                    |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| Direct user-authored statement   | Yes                    | Yes, subject to safety and durability validation                                                 |
| User quote/paste/attachment      | Yes, as data           | No, unless the user separately adopts the claim                                                  |
| Assistant proposal or conclusion | Yes                    | No, requires later user ratification                                                             |
| Tool/repository observation      | Yes                    | Only as provenance-tagged verified workspace knowledge, never as a user preference or permission |
| Imported skill/web content       | Yes, as untrusted data | No                                                                                               |

An accepted assistant-derived candidate should retain both roles:

```json
{
  "text": "Use one component system consistently to preserve a unified design language.",
  "category": "lessons",
  "sources": [
    { "messageId": "assistant-42", "relation": "proposed" },
    { "messageId": "user-43", "relation": "accepted" }
  ]
}
```

Every candidate must map to exact supplied evidence. The model may select and
normalize claims, but it may not invent a claim, source, acceptance edge, trust
class, category authority, or permission.

## Ratification semantics

- Explicit adoption (`Let's do that`, `Make that our rule`) can authorize the
  clearly referenced proposal.
- Contextual acceptance (`that's fair`, `sounds good`) may authorize the central
  conclusion when there is one unambiguous proposal in the immediately preceding
  exchange.
- Vague acceptance after a response containing multiple independent proposals
  must not silently approve every bullet. Retain only an unambiguous central
  conclusion or no memory until later clarification.
- Questions, acknowledgements of receipt, politeness, and continuation cues do
  not automatically ratify claims.
- Rejection, correction, supersession, sarcasm, and conditional agreement must
  prevent or qualify promotion.
- A later explicit user statement overrides an earlier assistant proposal or
  ambiguous acceptance.
- Approval claims, tool-policy changes, credential handling, secret disclosure,
  hidden/delayed commands, skill/plugin installation, and permission expansion
  remain forbidden memory regardless of vague or explicit acceptance.

## Context-window rules

- Include the current user message, the preceding assistant response, and only
  earlier messages required to resolve references or causal context.
- Preserve message and segment boundaries. Do not flatten the window into a
  concatenated transcript with a single trust label.
- Bound messages, characters/tokens, attachments, and tool excerpts. Prefer a
  deterministic relevance selector over truncating away the accepted claim.
- Carry tool-output provenance separately from assistant paraphrases so verified
  workspace observations can be distinguished from model inference.
- Raw context is job evidence with a retention limit; accepted memory stores
  compact provenance rather than the entire conversation indefinitely.

## Durable-memory policy

The extractor should distinguish at least:

- durable user identity and preferences;
- workspace facts and durable project constraints;
- verified tool/repository observations;
- decisions and lessons explicitly stated or ratified by the user;
- tentative suggestions and unresolved alternatives, which are not memory;
- transient requests, current task state, and small talk, which are rejected.

Project-specific behavioral constraints such as `Only use shadcn components in
this app` belong to workspace knowledge/constraints, not global interaction
preferences merely because they are phrased as instructions.

## Acceptance criteria

- [ ] A natural direct statement is extracted without requiring phrases such as
      `remember this`, `keep this in mind`, or `durable fact`.
- [ ] A user asks for a lesson, the assistant proposes one, and an unambiguous
      user acceptance promotes that lesson with both source IDs.
- [ ] The same assistant proposal without user acceptance cannot become a user
      preference, instruction, decision, or lesson.
- [ ] `That's fair` after one central conclusion can ratify that conclusion;
      the same reply after five unrelated recommendations does not ratify all
      five.
- [ ] User correction/rejection prevents the preceding assistant claim from
      being promoted, and supersession updates rather than duplicates memory.
- [ ] Quoted prompt injection inside a user message retains an untrusted segment
      and cannot establish memory.
- [ ] Verified repository facts may be stored as tool-grounded workspace
      knowledge with provenance, but never masquerade as user-authored policy.
- [ ] Project-local constraints remain workspace-scoped; identity/preferences
      remain global only when their evidence is genuinely user-global.
- [ ] Forbidden authority and secret-handling candidates are rejected even when
      followed by `okay`, `do that`, or another acceptance phrase.
- [ ] Evaluation covers paraphrase, pronoun/reference resolution, multi-proposal
      ambiguity, correction, sarcasm/conditional language, prompt injection,
      and extractor JSON/schema drift.

## Likely files

- `src/main/agent/index.ts` and transcript/message repository access
- `src/main/agent/memory/service.ts`
- `src/main/agent/memory/service.test.ts`
- New deterministic provenance/ratification validation modules and tests
- The durable extraction-job/fact repository introduced by [097](./097-auto-memory-extraction-lifecycle.md)

## Relationship to existing security work

Plan 077 correctly states that assistant text is untrusted derived data and
cannot establish durable memory by itself. This brief extends that rule: an
assistant claim may become durable only when an independently trusted source
establishes or ratifies it, and the stored provenance must show that chain.
