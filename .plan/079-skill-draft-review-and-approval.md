# PR79: Automatic skill drafts, request-changes review, and approved installation

> Status: **PLANNED**. Depends on `077`'s inert-draft/install boundary and `078`'s eligible workflow
> evidence. The system prepares drafts automatically but never activates them without user approval.

## Product flow

When an eligible workflow reaches the repetition threshold, tell the user:

> You completed this workflow 3 times. I prepared a skill draft for you to review.

Do not say the skill was created: until approval, it is a database proposal and is absent from the active
skill catalog.

The review surface has four primary actions:

- **Approve** — install the currently reviewed version at the selected location.
- **Request changes** — accept natural-language feedback, regenerate a new version, and show the changes.
- **Not now** — close the proposal and allow a later reminder under `078`'s cooldown.
- **Reject** — suppress the workflow until it materially changes or the user explicitly reopens it.

An optional **Edit source** affordance may expose raw `SKILL.md` editing for advanced users. “Edit” or
“Feedback” must not replace the clearer primary label **Request changes**.

## Drafting service

Use a constrained background completion, not a general tool-using agent:

- input is the normalized workflow plus bounded provenance from the three supporting executions;
- no tools, filesystem access, network access, delegation, or skill installation capability;
- output is strict structured fields (`name`, `description`, body, optional allowed-tool hints,
  portability assessment, workspace dependencies, caveats);
- validate against the existing Agent Skills loader rules and `077`'s persistent-instruction checks;
- failure leaves an eligible workflow that can be retried and never interrupts task completion.

A bundled `skill-creator` skill may separately support explicit user requests to author/improve skills,
but automatic proposals must not depend on an unconstrained agent invoking it.

## Proposal/version storage

Persist the proposal and immutable revisions. Each revision links to the workflow evidence and records the
feedback that produced it, generator model identity, validation warnings, inferred scope, and timestamp.
Only one revision is current; approval binds to its exact content hash and chosen destination.

Keep generated resources inert as database blobs or application-controlled draft files outside all paths
returned by `skillSources()`. A restart cannot make a pending proposal discoverable by `read_skill`.

## Scope behavior

Default location is inferred from dependencies:

- **Global** for portable procedures and procedures that refer generically to the active workspace.
- **Workspace** when the skill requires a particular repository's paths, commands, conventions,
  configuration, or domain knowledge.
- **Global with an uncertainty note** when inference is inconclusive.

Show the suggested location and a plain-language reason. The user may change it before approval. Explicit
feedback overrides inference, including:

> Remove the repository-specific pieces, parameterize the paths, and make this skill global.

After that request, regenerate the content and update the location recommendation. If the evidence cannot
support a safe portable procedure, explain the remaining dependency instead of pretending it was removed.

Approval should be one review action, not approval followed by a second location question. Present the
location selector in the review UI, default it appropriately, and label the primary action with the
destination (for example, **Save globally** or **Save to North Star workspace**).

## Request-changes loop

- Accept bounded user feedback as a direct instruction; keep workflow evidence as untrusted data.
- Generate a new immutable revision and show a readable diff/changed-field summary.
- Retain earlier revisions for inspection and rollback within the pending proposal.
- Re-run name, collision, authority, and portability validation for every revision.
- Do not install during regeneration. Approval always targets the visible current revision.

If an installed skill already covers the workflow, propose a reviewed update to that skill rather than a
duplicate. Preserve the original file and show its diff; approval uses revision-safe write semantics and
must fail on concurrent edits instead of overwriting them.

## Installation

- Reuse/refactor the guarded `skills:create` path and `skillScaffold` validation in main; the renderer
  must never write arbitrary proposal paths.
- Global approval targets `userSkillsDir()`. Workspace approval targets the active workspace's writable
  `<dataDirName()>/skills` source (normally `.cowork/skills`), matching the most-specific source already
  returned by `skillSources()`; surface the resolved location in the UI.
- Re-resolve the writable destination at approval time, reject path escape/name collision/stale revision,
  and use atomic create/no-overwrite semantics.
- Mark the proposal approved only after the filesystem write succeeds. Refresh the skill catalog and open
  the installed skill for inspection.
- If the referenced workspace is unavailable, keep the proposal pending and allow Global or another valid
  destination; never silently fall back.

## UI and settings

- Add **Skill suggestions**, default on, as a separate setting from Automatic memory with concise text
  explaining that successful workflow summaries are retained to detect repetition.
- Surface new proposals after task completion with a non-blocking card/toast and a durable proposals list
  reachable from Skills. Do not obscure the task's actual final result.
- The review shows the proposed source, three supporting executions (conversation/project/date), inferred
  reusable procedure, scope reason, warnings, and rendered skill contents.
- Pending/rejected/not-now/approved states survive restart. Avoid showing the same new-proposal alert more
  than once per eligible event.

## Verification

- An eligible workflow generates one inert draft without filesystem writes or catalog activation.
- The review accurately cites three distinct executions across conversation/project boundaries.
- Request changes produces a versioned diff; repo-specific-to-global feedback removes/parameterizes the
  dependency and changes the suggested destination when supported.
- Global is the default for portable/uncertain drafts; repository-dependent drafts default to that
  workspace; the user can override either.
- Not now and Reject transition to the distinct `078` suppression behavior.
- Approval installs exactly the reviewed hash in the selected writable root; collision, stale content,
  concurrent edits, unavailable workspace, and validation failure remain pending with clear errors.
- Auto memory disabled does not affect drafting/review. Skill suggestions disabled prevents new proposals
  but leaves existing proposals and approved skills accessible.
- Focused service/IPC/renderer tests, `pnpm typecheck`, `pnpm build`, and a real-app three-run exercise pass.

## Out of scope

- Silent skill activation, autonomous publishing/sharing, marketplace submission, automatic execution of
  a newly installed skill, or treating three repetitions as proof that embedded instructions are trusted.
