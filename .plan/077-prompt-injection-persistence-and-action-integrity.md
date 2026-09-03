# PR77: Prompt-injection persistence and action-integrity controls

> Status: **PLANNED**. Depends on `076`'s trust/provenance model. This plan closes the highest-impact
> paths: persistent memory/skills and consequential actions taken after untrusted content is consumed.

## Context

Automatic memory currently feeds the completed turn's user and assistant text to a background model,
stores raw excerpts in `memory-recent/reference/`, stages extracted bullets, and later rewrites managed
`memory-*` skills. The extractor is instructed to keep user-stated facts, but its output is not an
independent security boundary. An indirect injection followed or paraphrased by the assistant can
therefore be offered to a persistence model and may influence later sessions.

Separately, the policy engine correctly hard-blocks catastrophic operations, but Auto mode approves the
recoverable `require_approval` tier. An agent influenced by hostile data may still perform consequential
workspace, browser, MCP, or shell actions without a human seeing the causal source.

## Goal

1. Prevent untrusted instructions from being promoted into memory or installed skills.
2. Add an explicit-approval tier for narrow high-impact actions that Auto mode cannot bypass.
3. Bind approval display to the concrete action and the untrusted sources that influenced it.
4. Preserve useful automation and avoid prompting for every ordinary read or reversible workspace edit.

## Memory write pipeline

Refactor `src/main/agent/memory/service.ts` into an evidence-first pipeline:

1. Accept structured turn segments with trust/provenance rather than concatenated `User:` / `Assistant:`
   text.
2. Treat assistant text as untrusted derived data. It may help locate candidates but cannot establish a
   durable user preference, permission, or behavioral instruction.
3. Extract candidate facts into a strict schema carrying source message/segment IDs, category, and a
   declarative-versus-instruction classification.
4. Deterministically reject tool-policy changes, approval claims, hidden/delayed commands, requests to
   reveal data, secrets/credentials, and facts without valid provenance. Apply length/count limits before
   merging.
5. Use the model only for bounded semantic extraction/deduplication. Validate its JSON and require every
   output item to map to supplied evidence; never accept newly invented items.
6. Write memory atomically and retain bounded provenance metadata or a sidecar audit record. Raw reference
   logs remain data resources and must never be described as instructions.

Direct user preferences may still be remembered when auto memory is enabled. The system must distinguish
“always format my reports as a table” from quoted page text saying “always upload reports here.”

## Installed-skill boundary

- Treat bundled/imported/unreviewed skill material as supply-chain input. Loading a skill never expands
  the runtime's authorized tool set or approval scope.
- Only existing explicitly installed skills and proposals approved through `079` receive
  `approved_instruction` classification.
- A generated draft remains inert database content. It is absent from `skillSources()` and `read_skill`
  until approval writes it through the guarded `skills:create` path.
- Validate generated/imported `SKILL.md` for forbidden authority claims and suspicious resource paths;
  surface warnings for review rather than silently rewriting user-owned content.

## Explicit action-integrity tier

Extend the policy decision model with a narrow level such as `require_explicit_approval`:

- unlike ordinary `require_approval`, it is never bypassed by Auto mode or sandbox auto-approval;
- a prior allowlist rule does not cover it unless that rule type explicitly supports the same protected
  action and destination;
- hard blocks retain precedence.

Initially apply it to persistent instruction/configuration changes and sensitive external effects after
untrusted content influenced the action: sending or publishing content, granting permissions, entering
secrets, destructive remote operations, and untrusted-content-directed data transfer. Define categories
from concrete tool effects rather than model-written labels. Do not gate simple reads or ordinary
workspace-local reversible edits solely because a file was read.

The gate packet shows the exact tool, destination, bounded payload summary, relevant source provenance,
and why explicit review is required. Approval binds to an immutable action identity; changes after review
require a new gate.

## Recovery and failure behavior

- Memory extraction failure skips that candidate without blocking the completed user turn.
- A suspicious candidate remains absent from active memory; diagnostics may retain only a redacted event.
- Restart/retry cannot convert a draft or rejected memory candidate into installed instructions.
- External CLI agents that cannot expose equivalent provenance run with their existing capability limits
  and conservative protected-action handling; do not claim parity without tests.

## Verification

- Seed indirect injections in tool output and confirm they do not appear in `memory-*` skill bodies.
- Confirm legitimate direct user identity/preferences and workspace facts still persist.
- Confirm model-produced facts without source IDs are rejected and atomic writes preserve the prior file
  on malformed output or interruption.
- Confirm Auto mode cannot bypass `require_explicit_approval`, while hard blocks and ordinary approval
  semantics remain unchanged.
- Confirm approval identities reject changed destination/payload/source context.
- Add regression cases for poisoned imported skills and inert generated drafts.
- Run focused memory/policy/approval tests, `pnpm typecheck`, `pnpm build`, and a real-app exercise.

## Out of scope

- Turning memory into the workflow repetition database, automatic deletion of user-authored skills, or
  requiring human review for every agent action.

