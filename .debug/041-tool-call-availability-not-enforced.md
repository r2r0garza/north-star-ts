# Tool execution does not enforce the per-round offered tool set

> Status: **Resolved**
> Severity: **P1 — authorization boundary bypass**
> Area: agent tool dispatch and custom-agent restrictions

## Problem

The agent loop filters tool definitions by mode, workspace, browser availability,
custom-agent categories, and MCP server restrictions before sending them to the
model. Execution does not enforce that filtered set. Built-ins are resolved from
the global registry, and any syntactically valid `mcp__<server>__<tool>` name is
routed to the MCP manager.

Model output is untrusted. A fabricated tool call can therefore invoke a tool
that was intentionally withheld from that model round, including tools excluded
by a custom agent's `tools` or `mcpServers` configuration.

## Reproduction test

Run a turn whose offered definitions omit a known built-in, then submit a forged
call using that built-in's name. Repeat with an enabled MCP server omitted by the
selected agent's `mcpServers` list and with browser tools omitted by the agent's
tool categories. Assert every call is rejected before approval or execution.

## Fix direction

Build an exact set of offered tool names for every model round and pass it into
the call executor. Reject names outside that set before MCP prefix parsing or
global-registry lookup. Keep any universal tools explicit in the offered set
rather than creating dispatch-time exceptions.

Also bring plan-mode mutation classification and category mappings into line
with the complete modern tool surface (`apply_patch_tool`, command sessions,
and other replacements for legacy tool names).

## Acceptance criteria

- A tool call executes only if its exact name was offered in that model round.
- Custom-agent built-in and MCP restrictions are enforced at dispatch.
- Browser, index, workspace, and plan-mode withholding cannot be bypassed by a
  fabricated function name.
- Rejections are structured tool errors and never reach the approval gate or
  underlying implementation.

## Resolution

- Added an exact per-round offered-name set and dispatch guard before argument
  parsing, MCP prefix routing, approval gating, or built-in tool lookup.
- Updated plan-mode withholding to include `apply_patch_tool` and the modern
  command-session tool names.
- Added `apply_patch_tool` to the custom-agent `edit` tool category.
- Added regression coverage for withheld built-ins, withheld MCP names,
  browser category exclusion, edit-category coverage, and plan-mode-withheld
  shell/patch calls.

## Verification

- `npm test -- src/main/agent/tool-availability.test.ts src/main/agent/agents/tool-categories.test.ts src/main/agent/approval/plan-mode-classifier.test.ts`
- `npm run typecheck`
- `npm test -- src/main/agent`
- `npm test`
