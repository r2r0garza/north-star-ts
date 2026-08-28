# PR68: Progressive tool discovery and activation

> Status: **DEFERRED** until the built-in + MCP catalog is large enough that sending
> every eligible schema materially harms context, latency, or model selection.

## Context

More tools increase prompt cost and can reduce tool-selection accuracy. A future
`tool_search` should disclose eligible tools on demand, but it must never become a way
to discover or activate capabilities denied by an agent, mode, workspace, approval
posture, or MCP policy.

## Goal

Add a small always-offered `tool_search(query, category?, limit?)` that searches the
current turn's **authorized** catalog and activates selected tool definitions for the
next model round.

## Design

Separate three sets:

1. Runtime catalog — all registered built-in/MCP tools.
2. Authorized catalog — intersection after mode, workspace, `057` agent, MCP, and
   source-specific policies.
3. Offered set — minimal core tools plus tools activated for this turn/session.

`tool_search` sees only the authorized catalog. Results include name, concise purpose,
effects, category, and availability reason; denied tools are neither named nor hinted.
Activation mutates only the offered set and never bypasses the exact dispatch guard.

Keep essential coordination/lifecycle tools eagerly offered where policy permits.
Cache activations per conversation turn or bounded session with clear invalidation when
mode, agent, workspace, plan state, MCP availability, or approvals change. MCP tool
search must avoid connecting to every deferred server merely to index schemas.

## Measurement gate

Do not implement until telemetry/benchmarks show a real problem. Compare eager versus
progressive catalogs on representative tasks:

- schema tokens
- first-tool accuracy
- task success
- extra search/model turns
- latency and cost
- denied-tool leakage

## Verification

- Search/activation never reveals external-agent-denied or mode-withheld tools.
- Agent changes, plan-mode transitions, MCP disconnects, and background/headless modes
  invalidate stale activations.
- Fabricated calls to non-offered tools still fail exact availability checks.
- Evaluation demonstrates a net gain before rollout.

## Out of scope

- Installing tools/plugins, changing permissions through search, arbitrary remote tool
  discovery, or replacing skills.

