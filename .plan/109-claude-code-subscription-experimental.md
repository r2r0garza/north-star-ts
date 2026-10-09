# PR109: Claude Code Subscription - Experimental

> Status: **PLANNED**. Design umbrella; implementation is split into 109.1–109.5. No provider implementation is included in the planning change.

## Goal and ownership contract

Add provider `claude_subscription`, displayed exactly as **Claude Code Subscription - Experimental**, as a subscription-backed model transport inside North Star's existing agent loop. Preserve `claude_code` and its autonomous CLI behavior unchanged.

Implement the existing `LlmClient` compatibility surface (`chat.completions.create`, `models.list`) under `apiMode: "completions"`. The subprocess is disposable per model attempt; North Star's database remains canonical. No new API mode or generic provider-interface redesign is needed on current evidence.

North Star owns history/provenance, context and skill assembly, progressive tool discovery, tool validation/execution, approvals, Plan/Default/Auto modes, workspace/container environments, persistence, summaries, command-completion delivery, request permits/retries, and task/process/Mission Control state. Claude Code supplies its official login and model transport, not its agent loop. Host tools can run in a container while the model subprocess runs on the host.

Do not create native CLI session/resume rows or grant this provider the execution-capable North Star CLI MCP bridge. Its MCP inventory is separate and inert. Do not read credential files, extract/copy bearer tokens, build another OAuth flow, patch the vendor CLI, accept arbitrary upstream URLs, or automatically fall back to another provider.

## Implementation sequence

[109.1: Request-scoped transport](109.1-claude-subscription-transport.md) establishes translation, replay, file-backed settings, inert inventory, one-request admission, authoritative response capture, and cleanup. This is a prerequisite for enabling the provider.

[109.2: Integration and qualification](109.2-claude-subscription-integration-and-qualification.md) adds schema/routing/setup/UI support and verifies real North Star runtime ownership. V1 ships only when both slices meet their acceptance gates.

[109.3: Replay and cache follow-up](109.3-claude-subscription-replay-and-cache.md) is deferred optimization, despite its roadmap placement after the v1 slices. Promote signed replay into v1 only if real-service qualification proves canonical reconstruction insufficient for correctness; do not promote cache optimization merely for parity with Hermes.

[109.4: Broader authentication and managed-policy support](109.4-claude-code-authentication-and-managed-policy.md) defers API-key, Team/Enterprise, token-only and unknown/new auth states to a capability- and policy-aware Claude Code inference follow-up. The goal is to support official CLI inference regardless of credential kind where transport and organization restrictions can be preserved. Work-machine qualification is deferred; no broader auth mode is enabled now.

[109.5: Host image vision and durable media history](109.5-host-images-and-durable-media.md) addresses standalone image vision and durable screenshot/scanned-PDF pixels as one shared host capability. On 2026-10-09 the user accepted the current media limitations for 109.2 and confirmed macOS visual settings, live cross-provider history and Docker-selected tools. Only native Linux/Windows integrated qualification remains in 109.2; keep it in progress until those sessions complete. Distribution qualification and vendor release review are deferred until all 109.X plans are done, not waived or established by completing an implementation slice.

Initial v1 is scoped to reported personal Pro/Max logins. Enterprise-account availability is not a prerequisite for that scope. This is a product scope decision, not proof that cached account metadata is fresh or that managed-policy compatibility is qualified; retain existing guards and document the personal-scope freshness/check-start limitation rather than marking it tested.

## Research baseline

Analysis was performed on branch `feat/claude-sub`, with HEAD `9d15bad`, using the user-added [replication notes](../hermes-claude-subscription-directsdk-replication.md) and North Star's current implementation. The ignored `hermes-agent/` checkout is reference material only and is not a runtime dependency.

The Hermes checkout does not bundle this provider. Its `plugin-catalog/claude-subscription-directsdk.yaml` points to the standalone plugin at `4bc79c78031d1a042b5d8a7314ceea283db5c5e2`. To match the supplied analysis, the following source files were directly inspected at **`31b591fd04737a7807183f3d7f3d389b19f94687`**:

- [README.md](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/blob/31b591fd04737a7807183f3d7f3d389b19f94687/README.md)
- [directsdk.py](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/blob/31b591fd04737a7807183f3d7f3d389b19f94687/directsdk.py)
- [admission.py](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/blob/31b591fd04737a7807183f3d7f3d389b19f94687/admission.py)
- [directsdk_setup.py](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/blob/31b591fd04737a7807183f3d7f3d389b19f94687/directsdk_setup.py)
- [inert_mcp.py](https://github.com/NousResearch/hermes-plugin-claude-subscription-directsdk/blob/31b591fd04737a7807183f3d7f3d389b19f94687/inert_mcp.py)

The catalog and analysis pins differ. Do not silently change reference versions during implementation. Hermes model/version/qualification claims are reference claims, not North Star qualification results. Preserve MIT attribution if adapting source directly; do not add the Hermes checkout as a dependency.

## Findings that refine the replication notes

Only historical **user** frames carry `shouldQuery:false` and wait for a successful zero-turn result. Historical assistant frames are written directly, without waiting for an acknowledgement. Replay results are not generation results. Adjacent user and tool-result messages merge into one native user frame; only the final frame queries, without a synthetic continue prompt.

Hermes supplies complete tool schemas and generation fields through private `settings.json` → `env.CLAUDE_CODE_EXTRA_BODY`, in addition to inert MCP. The system prompt is also file-backed. Output caps use `CLAUDE_CODE_MAX_OUTPUT_TOKENS`; supported effort must agree with native `--effort`. Merely advertising an MCP inventory does not reproduce the transport.

The admission relay captures the first upstream SSE assistant response, including complete tool input, stop details and usage. A completed first response outranks subsequent native recovery text/errors. `--max-turns 1` and disabled retries are insufficient to enforce one upstream request. The relay is a **v1 requirement**, not a post-launch enhancement.

Model discovery uses a correlated initialize control request and must admit zero Messages requests. Generation replays frames directly. A stable isolated CWD is distinct from disposable request files. Neither should be the selected workspace. Qualified `error_max_turns`/exit-1 tool boundaries and known denied-recovery outcomes are narrowly accepted; arbitrary nonzero exits and incomplete upstream responses are not.

## Current North Star integration map

| Area | Existing extension point / constraint |
| --- | --- |
| Provider client | `src/main/agent/providers/index.ts`: `LlmClient`, client cache, resolve/build, readiness, token-field compatibility |
| Host agent loop | `src/main/agent/index.ts`: normal completion requests, retry/validation, tool dispatch and persistence |
| Retry/stream contract | `src/main/agent/model-request-retry.ts`: permits, attempt rollback, stall guards, usage and recognized refusal/reasoning fields |
| Context | `src/main/agent/context/context-builder.ts`: provenance-aware canonical history; optional sections budgeted using configured summarization threshold, not model window |
| Existing CLI provider | `src/main/agent/cli/claude.ts` and `cli/index.ts`: native session/agent ownership; keep unchanged |
| Process lifecycle | `src/main/agent/env/host-cli-env.ts`, `spawn-util.ts`: GUI PATH/environment and process-tree supervision |
| Accounts/setup | `src/main/db/{types,schema,migrations}.ts`, `db/repositories/provider-accounts.ts`, `ipc/provider-handlers.ts` |
| Settings/API | `src/preload/index.ts`, renderer `types.ts`, `components/llm-settings.tsx`, `App.tsx` |
| Portable runtime config | Explicit provider allowlists in `src/main/process/io.ts` and `src/main/mission-control/io.ts` |
| Auxiliary calls | `src/main/agent/title.ts` uses nonstream completion and `reasoning_effort:"low"`; trace memory/summary/background callers before implementation |

## Product and security boundaries

Provider creation is explicit opt-in. Explain installed CLI/login prerequisites, shared official CLI account, experimental/version-sensitive behavior, subscription usage, and possible account-configured credits/overages. Multiple provider entries do not imply independent credentials. Native costs are estimated API list-price equivalents, not verified charges or a promise of included/free usage.

Review applicable vendor terms and support constraints before broad distribution. Do not describe this adapter as officially supported or compliant based solely on another project's implementation.

V1 has no automatic login/update, arbitrary flags, credential import, endpoint override, account usage dashboard, generalized settings framework, signed replay persistence, or wire cache rewriting. All secret-bearing handling stays main-process/in-memory; fixtures and diagnostics contain no account credentials or private trajectories. Never disable certificate verification or silently bypass configured proxies.

## V1 acceptance gate

A configured keyless account must use the ordinary North Star loop, replay canonical history, execute host-approved tools only through North Star, and return complete tool batches only after authoritative response/finalization checks. Each host attempt admits at most one upstream Messages request; retries remain visible to the host coordinator. Abort, stall, early iterator exit, failures and shutdown must leave no subprocess tree, active socket, inventory server, request artifacts or dangling listeners.

Synthetic tests and installed-CLI loopback qualification precede any explicit opt-in subscription smoke test. Qualify version/platform and packaged execution instead of inheriting Hermes' claims. Existing Claude Code CLI and API providers must retain their behavior.

## Verification

Implementation slices specify targeted tests. Use repository scripts, including the SQLite wrapper where native DB tests are involved:

```sh
pnpm test -- <targeted-test-paths>
pnpm run test:sqlite
pnpm run typecheck
pnpm run build
pnpm run verify:roadmap
```

Broader tests follow targeted passes. Platform/package and real-service verification require separate evidence; unit tests do not establish them. The planning change itself requires roadmap validation, document/link review and a diff confirming no application implementation changes.
