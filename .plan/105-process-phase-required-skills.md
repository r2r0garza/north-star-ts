# PR105: Required skills for individual Process phases

> Status: **PLANNED**. Makes one specific skill an explicit part of an agent phase’s definition and activates it for every worker invocation of that phase. Sub-process phases do not offer or inherit this setting; their own inner phase definitions remain the sole authority for skill assignment.

## Goal

Let a Process author say “run this verification phase with `verify-code`” rather than only selecting an agent that happens to have that skill available and hoping the worker chooses it from the catalog.

The assignment is phase-scoped orchestration intent. When the phase runs, North Star resolves the configured skill, marks it as explicitly activated for that worker turn, and steers the worker to follow it. For fan-out agent phases, every worker child receives the same required skill. Router, decomposition, validator, and unrelated phases do not receive it unless separately configured by a future feature.

## Current distinction

`process_phase_agents.skills` is already a tri-state catalog override: `null` uses the agent definition, `[]` offers no skills, and a non-empty array limits which skills are available. That controls capability availability, not which skill the phase must use.

`runAgentLoop` also has a `skills` input used by slash-selected skills. It resolves named skills, rejects missing names, registers their resource roots, and adds an explicitly selected-skills prompt section. Process workers currently do not pass a phase assignment through that input.

Keep these concepts separate:

- **phase-agent skill allowlist**: which skills the selected agent may access;
- **required phase skill**: the one procedure explicitly activated for this phase invocation.

## Product decisions

1. **One required skill in v1.** An agent phase may select zero or one required skill by canonical skill name. This keeps the inspector and runtime contract unambiguous; ordered multi-skill composition can be added later if demonstrated.
2. **Agent phases only.** Show the setting only when the phase executes an LLM worker. Do not show it for a sub-process phase because the referenced Process owns its inner phase assignments. Do not show it for a deterministic command phase from `104`, which makes no LLM call.
3. **Every actual worker gets it.** A normal agent phase receives it once; every fan-out child receives it independently. Dispatch routing may choose different agents, but every candidate that can be selected must be compatible with the required skill.
4. **Activation, not mere advertisement.** Pass the skill through the existing explicit-selection path and adjust its Process-facing copy so the worker is told that this skill is required for the phase, not merely present in the optional skill catalog. The worker must read the skill instructions before performing the phase work when they are not already in context.
5. **Do not silently weaken the assignment.** If the skill is missing, shadowed by an invalid definition, unreadable, or excluded by the selected phase-agent policy, fail the phase before the LLM call with a clear configuration error. Never continue with the base agent and never substitute a similarly named skill.
6. **No inheritance across a sub-process boundary.** Starting a nested Process passes the ordinary phase objective/upstream input only. It does not pass the caller’s required skill. Each nested agent phase resolves its own assignment from its own definition.
7. **Portable by name, explicit on import.** Export the canonical skill name. Import may preserve an unresolved name with a warning so a portable Process can be mapped after import, but a run cannot start that phase until the skill resolves in the run’s effective skill sources.
8. **Snapshot run intent.** Record the resolved required skill identity on the phase run (at minimum canonical name and source/path identity suitable for display; preferably a content hash/revision). This makes the monitor and incident exports explain what the worker was instructed to use even if skill discovery changes later. Do not copy mutable skill bodies into ordinary transcripts unless the existing selected-skill mechanism already requires it.

## Data and validation

Add a nullable phase-level field such as:

```ts
interface ProcessPhase {
  // ...existing fields
  requiredSkill: string | null
}

interface ProcessPhaseRun {
  // ...existing fields
  requiredSkillSnapshot?: {
    name: string
    source: string
    path: string
    contentHash: string
  } | null
}
```

Exact persisted representation should follow current schema and incident-export conventions. The definition stores a portable canonical name; the run stores bounded resolved provenance for observability. Include the definition field in Process import/export and the run snapshot in diagnostic/incident exports where phase runtime identity is already reported.

Repository validation should reject a required skill on non-agent phase kinds. Builder-time validation should also detect obvious incompatibility with each phase-pool agent’s effective skill allowlist. Runtime must re-resolve because file-based skill sources can change after authoring and because last-wins discovery may resolve the same name from a different source in another workspace.

For a `single` phase, the selected pool agent must allow the required skill. For `dispatch`, every routable pool member must allow it; otherwise the builder should identify incompatible agents and prevent saving/running until the author changes the pool, allowlist, or required skill. Do not let the router choose an incompatible worker and discover the error after a model classification call.

## Runtime integration

Resolve the phase worker’s effective skill catalog using the same source order and agent capability policy as `runAgentLoop`. Before creating or resuming the worker call:

- resolve the exact configured name;
- verify it survives the chosen agent’s allowlist/capability policy;
- persist the phase-run skill snapshot;
- pass `skills: [phase.requiredSkill]` (or an equivalent explicit Process-required input) into `runAgentLoop`; and
- label the context as Process-assigned rather than falsely describing it as a user slash selection.

The cleanest implementation may generalize the existing selected-skill context from “user-selected skills” to an explicit activation record with an origin such as `user_selection | process_phase`. Preserve the current slash-command behavior and trust provenance. A Process definition created or edited by the user is durable orchestration configuration, but skill files are still loaded through the existing guarded skill-source boundary.

Resume must keep the same assignment for an existing phase attempt. If the snapshotted skill revision is no longer available, do not silently switch revisions mid-attempt; interrupt with a clear stale/missing-skill error and offer an explicit retry against the current definition. A fresh retry/rework round may resolve the current revision, with the new snapshot visible in history.

The required skill applies only to the phase worker call. Do not pass it to model-decided routing, fan-out decomposition, the separate validator agent, sub-process schedulers, or cross-phase consultation calls. Those are distinct runtime roles and would need their own explicit assignment fields if a future use case requires them.

## Builder and monitor

In the phase inspector, add a **Required skill** picker beneath the agent configuration for agent phases. Include `None` and the resolved skill catalog, with source/scope details sufficient to distinguish shadowed names. Explain that the selected skill will be activated for every worker in the phase, while agent skill settings control availability.

When the phase uses dispatch, show compatibility across the whole pool and block an invalid combination with actionable copy. When the phase switches to sub-process or command execution, clear the assignment only after confirmation and hide the control. A sub-process card may summarize required skills inside its referenced definition, but it must not expose an override at the parent phase.

The run monitor should show a compact skill badge from the persisted phase-run snapshot and make the source/revision inspectable. Fan-out children each show the assignment they actually used. Nested runs show skill badges on their own inner phase rows, never on the outer sub-process container merely because a child used one.

## Verification

Repository and I/O tests should cover nullable storage, agent-kind-only validation, import/export round trips, unresolved import warnings, and incident-export snapshots.

Engine tests should prove that an assigned skill is resolved and passed through the explicit activation path; the worker context requires reading/following it; no LLM call occurs when it is missing or disallowed; single and dispatch compatibility is enforced; every fan-out child receives it; rework/retry behavior records the correct revision; and router, decomposer, validator, sibling phases, and nested sub-process phases do not inherit it.

Renderer tests should cover the agent-only picker, source labels, pool incompatibility errors, clearing on kind changes, and monitor badges for normal/fan-out/nested runs. Manually build a verification phase assigned to `verify-code`, run it, inspect the worker context/tool trace to confirm activation, then remove or disallow the skill and confirm the phase fails clearly before model execution.

Run focused tests, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm verify:roadmap`.

## Out of scope

- Assigning a skill to a sub-process container or implicitly propagating one into nested Processes.
- Assigning skills to deterministic command phases, routers, decomposers, validators, or consultation calls.
- Ordered composition of multiple required skills, automatic skill selection, semantic skill matching, or fallback substitution.
- Bundling skill contents into a Process export or installing a missing skill during import/run.
- Replacing agent-level skill allowlists; availability policy and phase activation remain separate controls.
